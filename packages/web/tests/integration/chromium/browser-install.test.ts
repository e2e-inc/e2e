/**
 * A real install of the pinned headless shell from Chrome for Testing into a
 * fresh cache, then a BiDi session on it: the one test that proves the
 * pinned archive is at its URL, has its pinned hash, and runs. It needs the
 * network and fails without it; the unit tests cover the installer against
 * a local archive server.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchBidiBrowser } from '../../../src/driver/launch.ts';
import { browserPlatform, PINS } from '../../../src/install/builds.ts';
import { browserExecutable, installBrowsers } from '../../../src/install/provision.ts';

const { buildId } = PINS['chrome-headless-shell'];

describe('installing the pinned headless shell', () => {
  const cache = mkdtempSync(path.join(tmpdir(), 'e2e-browser-install-'));
  const env = { ...process.env, E2E_BROWSERS_PATH: cache };

  afterAll(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it('downloads it into the cache and opens a BiDi session on it', { timeout: 300_000 }, async () => {
    const logs: string[] = [];
    await installBrowsers(['chromium'], { log: (line) => logs.push(line), env, headed: false });
    const executable = browserExecutable('chromium', false, env);
    expect(existsSync(executable)).toBe(true);
    expect(logs).toEqual([`Downloading chrome-headless-shell ${buildId} into ${cache}`]);
    expect(readdirSync(path.join(cache, 'chrome-headless-shell'))).toEqual([`${browserPlatform()!.cacheKey}-${buildId}`]);

    const browser = await launchBidiBrowser('chromium', { headed: false, timeoutMs: 30_000, env, signal: new AbortController().signal, media: {} });
    try {
      const { context } = await browser.connection.send('browsingContext.create', { type: 'tab' });
      const result = await browser.connection.send('script.evaluate', {
        expression: 'navigator.userAgent',
        target: { context },
        awaitPromise: false,
      });
      expect(result).toMatchObject({ type: 'success', result: { type: 'string', value: expect.stringContaining(`HeadlessChrome/${buildId}`) } });
    } finally {
      await browser.close();
    }
  });
});
