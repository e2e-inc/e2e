/**
 * Init scripts: the configured `initScripts` and `browser.addInitScript` run
 * in every document before its own scripts, in order, in new tabs and
 * frames, and again on each context the attempt replaces. Each page here
 * records, from its first inline script, the trail the init scripts left.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import type { Browser } from '../../src/browser.ts';
import { web } from '../../src/engine.ts';
import type { WebOptions } from '../../src/surface.ts';
import { cleanupContext, workerInfo, openSurface, type OpenSurface } from '../helpers/attempt.ts';

declare global {
  interface Window {
    trail?: string[];
    seenAtBoot?: string[];
  }
}

const BOOT = '<script>window.seenAtBoot = [...(window.trail ?? [])];</script>';
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><head>${BOOT}</head><body><h1>Home</h1></body></html>`,
  '/framed': `<!doctype html><html><head>${BOOT}</head><body><iframe src="/"></iframe></body></html>`,
};

describe('init scripts', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-'));
  let server: Server;
  let url: string;

  beforeAll(async () => {
    writeFileSync(path.join(projectRoot, 'from-file.js'), "(window.trail ??= []).push('file');\n");
    server = createServer((request, response) => {
      const body = PAGES[request.url ?? ''];
      response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(body ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const artifactDirs: string[] = [];
  afterEach(() => {
    for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Boots one worker with `options` and runs `body` in one attempt with its `browser` fixture. */
  async function attempt(options: WebOptions, body: (opened: OpenSurface) => Promise<void>): Promise<void> {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-init-scripts-artifacts-'));
    artifactDirs.push(artifactsDir);
    const opened = await openSurface({ options, init: { projectRoot, app: { site: '127.0.0.1' } }, attempt: { artifactsDir }, baseUrl: url, timeoutMs: 30_000 });
    try {
      await body(opened);
    } finally {
      await opened.close();
    }
  }

  const seenAtBoot = (browser: Browser) => browser.evaluate(() => window.seenAtBoot ?? null);

  it('runs the configured scripts in order before the page, in frames, new tabs, and replaced contexts', async () => {
    const initScripts: WebOptions['initScripts'] = [
      "(window.trail ??= []).push('source');",
      { path: 'from-file.js' },
      () => { (window.trail ??= []).push('function'); },
      { method() { (window.trail ??= []).push('method'); } }.method,
    ];
    await attempt({ initScripts }, async ({ browser, surface, operation }) => {
      const expected = ['source', 'file', 'function', 'method'];
      await browser.goto('/framed');
      expect(await seenAtBoot(browser)).toEqual(expected);
      const frame = surface.requirePage().frames()[1]!;
      await frame.waitForLoadState();
      expect(await frame.evaluate(() => window.seenAtBoot)).toEqual(expected);

      const opened = surface.requireContext().waitForEvent('page');
      await browser.evaluate((target) => { window.open(target); return null; }, `${url}/`);
      const tab = await opened;
      await tab.waitForLoadState();
      expect(await tab.evaluate(() => window.seenAtBoot)).toEqual(expected);

      await surface.reset(operation());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(expected);
    });
  });

  it('adds a test script after the configured ones, from the next document on, for the rest of the attempt', async () => {
    await attempt({ initScripts: ["(window.trail ??= []).push('config');"] }, async ({ browser, surface, operation }) => {
      await browser.goto('/');
      await browser.addInitScript((wallet) => { (window.trail ??= []).push(`wallet:${wallet.address}`); }, { address: '0xabc' });
      expect(await seenAtBoot(browser)).toEqual(['config']);
      await browser.reload();
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc']);

      const arg = JSON.parse('{"__proto__":{"own":true}}') as { __proto__: { own: boolean } };
      await browser.addInitScript((value) => {
        (window.trail ??= []).push(`own __proto__:${String(Object.hasOwn(value, '__proto__'))}`);
      }, arg);
      await browser.addInitScript({ path: 'from-file.js' });
      await surface.reset(operation());
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual(['config', 'wallet:0xabc', 'own __proto__:true', 'file']);
    });
    await attempt({}, async ({ browser }) => {
      await browser.goto('/');
      expect(await seenAtBoot(browser)).toEqual([]);
    });
  });

  it('refuses a script it cannot run, and a secret argument', async () => {
    await attempt({}, async ({ browser }) => {
      const add = browser.addInitScript as (...args: unknown[]) => Promise<void>;
      await expect(add('window.x = 1', 3)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/only with a function/) });
      await expect(add({ path: 'missing.js' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/missing\.js \(ENOENT\)/) });
      await expect(add({ content: 'x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/takes only path, got content/) });
      await expect(add(42)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(add(() => undefined, secrets.get('key'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    });
  });

  it('fails the run, and a worker, with INVALID_CONFIG when a configured file cannot be read', async () => {
    const engine = web({ initScripts: [{ path: 'nope.js' }] });
    await expect(engine.prepare!({ runId: 'init-scripts', targetName: 'web', projectRoot, app: {}, slots: 1, env: {},
      signal: new AbortController().signal, headed: false, log: () => undefined })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/nope\.js \(ENOENT\)/) });
    await expect(engine.init!(workerInfo({ projectRoot }))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/web\(\{ initScripts \}\)\[0\] path cannot be read: .*nope\.js \(ENOENT\)/),
    });
    await engine.dispose!(cleanupContext());
  });
});
