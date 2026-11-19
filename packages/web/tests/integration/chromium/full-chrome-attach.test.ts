/**
 * Attaching over CDP to the pinned full Chrome, not the headless shell: its
 * browser UI targets and component extension service workers sit beside the
 * tab, as in a user's own Chrome, and `attachBrowser` and
 * `web({ connect })` still navigate and locate. The host launches below the
 * engine's `prepare`, so nothing installs the headed build for it: the suite
 * fails without it, naming the install command.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@e2e-dev/core/engine';
import { attachBrowser, web } from '../../../src/index.ts';
import { debuggerUrl, installedChrome, launchRemoteChrome, recordGoodbyes, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../../helpers/secrets.ts';
import { byRole, cleanup, initInfo, operation } from '../../helpers/web-session.ts';

describe('attaching to the pinned full Chrome over CDP', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let endpoint: string;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome({ fullChrome: installedChrome() });
    endpoint = `http://${new URL(chrome.endpoint).host}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-full-chrome-artifacts-'));
  }, 60_000);

  afterAll(async () => {
    await tearDownRemote({ chrome, closes: [() => app?.close()], directories: [artifactsDir] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists browser UI targets beside the tab', async () => {
    const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as { type: string }[];
    expect(targets.map(({ type }) => type)).toEqual(expect.arrayContaining(['page', 'browser_ui']));
  });

  it('navigates and locates through attachBrowser', async () => {
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    await attached.browser.goto(`${app.url}/`);
    expect(await attached.browser.url()).toBe(`${app.url}/`);
    expect(await attached.screen.getByRole('heading', 'Home').count()).toBe(1);
  }, 60_000);

  it('navigates and locates through web({ connect }), and leaves the browser running', async () => {
    const goodbyes = recordGoodbyes();
    const engine: EngineHandle = web({ connect: { cdpEndpoint: () => chrome.endpoint } });
    await engine.init!(initInfo({ app: { site: new URL(app.url).hostname } }));
    try {
      await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/`, operation('a1'));
      const headings = await engine.locate!(byRole('heading'), operation('a1'));
      expect(headings[0]?.name).toBe('Home');
      expect((await engine.observe!(operation('a1'))).location).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
    expect(goodbyes()).toEqual(['session.end']);
    expect(await debuggerUrl(chrome)).toBe(chrome.endpoint);
  }, 60_000);
});
