/**
 * A target's `app.permissions` with `web({ connect: { context: 'existing' } })`,
 * for a test that drives the page the browser already shows and never opens
 * one: the page as found holds the permissions the target grants, and the
 * browser has its own back once the attempt ended. On the headless shell
 * and on the pinned full Chrome.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteChrome, installedChrome, launchRemoteChrome, type RemoteChrome, type RemoteChromeOptions } from '../../helpers/cdp-host.ts';
import { evaluateInTab } from '../../helpers/cdp-page.ts';
import { showOnly } from '../../helpers/cdp-tabs.ts';
import { startPageServer, startWebSession, type PageServer, type WebSession } from '../../helpers/web-session.ts';

/** What the page holds of the clipboard and of geolocation, which no target here grants. */
const HELD = `(async () => {
  const held = {};
  for (const name of ['clipboard-read', 'clipboard-write', 'geolocation']) held[name] = (await navigator.permissions.query({ name })).state;
  return held;
})()`;

const HOSTS: readonly (readonly [string, () => RemoteChromeOptions])[] = [
  ['the headless shell', () => ({})],
  ['the pinned full Chrome', () => ({ fullChrome: installedChrome() })],
];

describe.each(HOSTS)("app.permissions with web({ connect: { context: 'existing' } }) on %s", (_host, options) => {
  let pages: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;
  let session: WebSession | undefined;

  beforeAll(async () => {
    pages = await startPageServer();
    chrome = await launchRemoteChrome(options());
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  afterAll(async () => {
    await pages?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('are held by the page as it is found, with no navigation, and lifted when the attempt ends', async () => {
    const tab = await showOnly(endpoint, pages, '/found', '<title>Found</title>');
    const found = await evaluateInTab<Record<string, string>>(endpoint, tab, HELD);
    expect(found).toMatchObject({ 'clipboard-read': 'prompt', geolocation: 'prompt' });

    session = await startWebSession({
      appUrl: pages.origin,
      app: { permissions: { 'clipboard-read': 'grant', 'clipboard-write': 'grant' } },
      web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } },
    });
    expect(await session.browser.url()).toBe(tab.url);
    expect(await session.browser.evaluate(HELD)).toEqual({ 'clipboard-read': 'granted', 'clipboard-write': 'granted', geolocation: 'prompt' });
    expect(await session.browser.evaluate(async () => {
      await navigator.clipboard.writeText('copied in the page as found');
      return navigator.clipboard.readText();
    })).toBe('copied in the page as found');

    await session.endAttempt();
    expect(await evaluateInTab(endpoint, tab, HELD)).toEqual(found);
  });
});
