/**
 * `ensureFfmpeg` against a cache and a mirror of the test's own, with no
 * ffmpeg on the PATH, so the download path runs whatever the machine has.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startArchiveServer, type ArchiveServer } from '../helpers/archive-server.ts';
import { browserPlatform, PINS, type BrowserPlatform } from '../../src/install/builds.ts';
import { browserExecutable, ensureBrowsersInstalled } from '../../src/install/provision.ts';
import { ensureFfmpeg } from '../../src/install/ffmpeg.ts';

/** The mirror path the pinned ffmpeg of `platform` is requested at. */
function served(platform: BrowserPlatform['node']): string {
  return `/eugeneware/ffmpeg-static/releases/download/${PINS.ffmpeg.buildId}/ffmpeg-${platform}.gz`;
}

/** Runs `work` as Node on `platform` and `arch` would see itself. */
async function onMachine(platform: NodeJS.Platform, arch: string, work: () => Promise<void>): Promise<void> {
  const own = { platform: Object.getOwnPropertyDescriptor(process, 'platform')!, arch: Object.getOwnPropertyDescriptor(process, 'arch')! };
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  try {
    await work();
  } finally {
    Object.defineProperty(process, 'platform', own.platform);
    Object.defineProperty(process, 'arch', own.arch);
  }
}

let cache = '';
let server: ArchiveServer;
let env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  vi.stubEnv('PATH', '');
  cache = mkdtempSync(path.join(tmpdir(), 'e2e-ffmpeg-'));
  server = await startArchiveServer();
  env = { E2E_BROWSERS_PATH: cache, E2E_BROWSERS_DOWNLOAD_HOST: server.origin };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
  rmSync(cache, { recursive: true, force: true });
});

describe('ensureFfmpeg', () => {
  it('returns E2E_FFMPEG_PATH without downloading', async () => {
    expect(await ensureFfmpeg({ ...env, E2E_FFMPEG_PATH: '/opt/ffmpeg' })).toBe('/opt/ffmpeg');
    expect(server.requests).toEqual([]);
  });

  it('is not downloaded by preparing a chromium run', async () => {
    const executable = browserExecutable('chromium', false, env);
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, '');
    await ensureBrowsersInstalled(['chromium'], { env, headed: false, log: () => {} });
    expect(server.requests).toEqual([]);
  });

  it('downloads the pinned build from the mirror and refuses one with another SHA-256', async () => {
    const archive = served(browserPlatform()!.node);
    server.route(archive, Buffer.from('not ffmpeg'));
    const logs: string[] = [];
    await expect(ensureFfmpeg(env, { log: (line) => logs.push(line) })).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_FAILED',
      message: expect.stringMatching(/^could not install ffmpeg: download of .* has SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}; refusing it; run "npx @e2e-dev\/web install ffmpeg"/),
    });
    expect(logs).toEqual([`Downloading ffmpeg from ${server.origin}${archive}`]);
    expect(readdirSync(cache)).toEqual([]);
  });

  it('downloads the x64 build on Windows on Arm, which runs the x64 browsers', async () => {
    await onMachine('win32', 'arm64', async () => {
      await expect(ensureFfmpeg(env)).rejects.toMatchObject({ code: 'BROWSER_INSTALL_FAILED', message: expect.stringContaining('404 Not Found') });
    });
    expect(server.requests).toEqual([served('win32-x64')]);
  });

  it('fails a platform with no pinned build with UNSUPPORTED_CAPABILITY', async () => {
    await onMachine('linux', 'riscv64', async () => {
      await expect(ensureFfmpeg(env)).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: 'recording video on chromium needs an ffmpeg with libvpx-vp9, and none is pinned for linux-riscv64: set E2E_FFMPEG_PATH',
      });
    });
    expect(existsSync(path.join(cache, '.install.lock'))).toBe(false);
    expect(server.requests).toEqual([]);
  });
});
