/**
 * A local launch and a CDP attach without a real browser: the executable
 * comes from the run's environment, never this process's, a signal that
 * aborts at any stage ends either as the deadline it aborted with or as
 * `CANCELLED`, and the watchdog a browser runs under kills it and removes
 * its profile once the launching process lets go.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EngineError } from '@e2e-dev/core/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectBidiOverCdp, launchBidiBrowser } from '../../src/driver/launch.ts';
import { spawnWatched } from '../../src/driver/browser-watchdog.ts';
import { browserExecutable } from '../../src/install/provision.ts';

/** Whether a process with `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('launchBidiBrowser', () => {
  it('looks the build up in the browsers cache the run environment names', async () => {
    const cache = path.join(os.tmpdir(), 'e2e-no-such-browsers-cache');
    await expect(launchBidiBrowser('chromium', { headed: false, timeoutMs: 10_000, env: { E2E_BROWSERS_PATH: cache }, signal: new AbortController().signal, media: {} })).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(cache),
    });
  });
});

/** What stops after each test: the servers and directories it made. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The deadline a signal aborts with once the browser took too long to open, as the surface words it. */
function deadline(): EngineError {
  return new EngineError('OPERATION_TIMEOUT', 'the browser did not open within 60000ms', { retryable: false });
}

/** Listens on a local port; resolves with it. The server and its connections close after the test. */
async function listening(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** A local port that takes a connection and never answers it, and a promise of the first one. */
async function silentPort(): Promise<{ port: number; connected: Promise<void> }> {
  const server = createServer();
  const connected = new Promise<void>((resolve) => server.once('connection', () => resolve()));
  return { port: await listening(server), connected };
}

/** A local port that opens a WebSocket and never answers what is sent on it, and a promise of the first message. */
async function mutePort(): Promise<{ port: number; asked: Promise<void> }> {
  const server = createHttpServer();
  const asked = new Promise<void>((resolve) => {
    server.on('upgrade', (request, socket) => {
      const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.once('data', () => resolve());
    });
  });
  return { port: await listening(server), asked };
}

/**
 * The run environment of a browsers cache whose Firefox build is `program`,
 * a Node program that stands in for the browser.
 */
function firefoxRunning(program: string): Record<string, string> {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'e2e-launch-test-'));
  cleanups.push(() => rmSync(cache, { recursive: true, force: true }));
  const env = { E2E_BROWSERS_PATH: cache };
  const executable = browserExecutable('firefox', false, env);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(path.join(cache, 'browser.mjs'), program);
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${path.join(cache, 'browser.mjs')}'\n`, { mode: 0o755 });
  return env;
}

/** How a signal aborts, and what the launch or attach it stopped fails with. */
const ABORTS = [
  { how: 'the deadline it aborted with', reason: deadline(), failure: { code: 'OPERATION_TIMEOUT', message: 'the browser did not open within 60000ms' } },
  { how: 'CANCELLED', reason: undefined, failure: { code: 'CANCELLED' } },
] as const;

describe.each(ABORTS)('a launch or attach whose signal aborts fails as $how', ({ reason, failure }) => {
  it('before it starts anything', async () => {
    const signal = AbortSignal.abort(reason);
    await expect(launchBidiBrowser('chromium', { headed: false, timeoutMs: 10_000, env: {}, signal, media: {} })).rejects.toMatchObject(failure);
    await expect(connectBidiOverCdp({ endpoint: 'ws://127.0.0.1:9' }, 10_000, signal)).rejects.toMatchObject(failure);
  });

  it.skipIf(process.platform === 'win32')('while the launched browser has yet to name its endpoint', async () => {
    const { port, connected } = await silentPort();
    const env = firefoxRunning(`import { connect } from 'node:net';\nconnect(${port}, '127.0.0.1');\nsetInterval(() => undefined, 1_000);\n`);
    const controller = new AbortController();
    const launching = launchBidiBrowser('firefox', { headed: false, timeoutMs: 10_000, env, signal: controller.signal, media: {} });
    await connected;
    controller.abort(reason);
    await expect(launching).rejects.toMatchObject(failure);
  });

  it.skipIf(process.platform === 'win32')('while the launched browser has yet to open the session', async () => {
    const { port, asked } = await mutePort();
    const env = firefoxRunning(`console.error('WebDriver BiDi listening on ws://127.0.0.1:${port}');\nsetInterval(() => undefined, 1_000);\n`);
    const controller = new AbortController();
    const launching = launchBidiBrowser('firefox', { headed: false, timeoutMs: 10_000, env, signal: controller.signal, media: {} });
    await asked;
    controller.abort(reason);
    await expect(launching).rejects.toMatchObject(failure);
  });

  it('while the attach reads the DevTools URL its endpoint names', async () => {
    const { port, connected } = await silentPort();
    const controller = new AbortController();
    const attaching = connectBidiOverCdp({ endpoint: `http://127.0.0.1:${port}` }, 10_000, controller.signal);
    await connected;
    controller.abort(reason);
    await expect(attaching).rejects.toMatchObject(failure);
  });

  it('while the mapper connects to the browser', async () => {
    const { port, connected } = await silentPort();
    const controller = new AbortController();
    const attaching = connectBidiOverCdp({ endpoint: `ws://127.0.0.1:${port}/devtools/browser/none` }, 10_000, controller.signal);
    await connected;
    controller.abort(reason);
    await expect(attaching).rejects.toMatchObject(failure);
  });
});

describe('browser watchdog', () => {
  it('kills the browser and removes its profile once its stdin closes, as when the launching process is killed', async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'e2e-watchdog-test-'));
    const browserLike = ['-e', 'console.error(`pid ${process.pid}`); setInterval(() => undefined, 1000);'];
    const watchdog = spawnWatched(profile, process.execPath, browserLike);
    const pid = await new Promise<number>((resolve) => watchdog.stderr.on('data', (chunk: Buffer) => {
      const match = /pid (\d+)/.exec(chunk.toString());
      if (match !== null) resolve(Number(match[1]));
    }));
    expect(alive(pid)).toBe(true);
    const exited = new Promise<void>((resolve) => watchdog.once('exit', () => resolve()));
    watchdog.stdin.destroy();
    await exited;
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(existsSync(profile)).toBe(false);
  });

  it('removes the profile and exits with the browser when the browser exits on its own', async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'e2e-watchdog-test-'));
    const watchdog = spawnWatched(profile, process.execPath, ['-e', 'process.exit(3)']);
    const code = await new Promise<number | null>((resolve) => watchdog.once('exit', (exitCode) => resolve(exitCode)));
    expect(code).toBe(3);
    expect(existsSync(profile)).toBe(false);
  });
});
