/**
 * What an attempt sets in a browser it does not own, with
 * `web({ connect: { context: 'existing' } })` and with `attachBrowser`, is
 * taken back when the attempt ends: the configured options (user agent,
 * locale, time zone, media, viewport, headers, permissions) and what a test
 * sets (`emulateMedia`, `setViewport`, an init script, and a route with the
 * HTTP cache bypass it brings). The page is
 * read the way its host reads it, over a DevTools session of the test's
 * own: it reads as it did before the attempt, the next attempt starts
 * without any of it, and the tab is a background tab again. The one thing
 * that stays is what scripts did in a document the attempt left open, until
 * that document navigates.
 *
 * A read of the page after an attempt polls: Chrome lifts a viewport at
 * once and lays the page out at its window's size a moment later, as it
 * does when a person resizes the window.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attachBrowser } from '../../../src/index.ts';
import { closeRemoteChrome, installedChrome, launchRemoteChrome, type RemoteChrome, type RemoteChromeOptions } from '../../helpers/cdp-host.ts';
import { evaluateInTab } from '../../helpers/cdp-page.ts';
import { openTab, showOnly, type OpenTab } from '../../helpers/cdp-tabs.ts';
import { startPageServer, startWebSession, type PageServer, type WebSession } from '../../helpers/web-session.ts';
import type { WebOptions } from '../../../src/index.ts';

/** Everything of the page a configured option changes, read in the page. */
const CONFIGURED = `(async () => ({
  userAgent: navigator.userAgent,
  language: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  viewport: [innerWidth, innerHeight, devicePixelRatio],
  clipboardRead: (await navigator.permissions.query({ name: 'clipboard-read' })).state,
  clipboardWrite: (await navigator.permissions.query({ name: 'clipboard-write' })).state,
  sent: await (await fetch('/echo')).json(),
}))()`;

/** Everything of the page a test's own calls change, read in the page. */
const SET_BY_A_TEST = `(async () => ({
  dark: matchMedia('(prefers-color-scheme: dark)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  viewport: [innerWidth, innerHeight, devicePixelRatio],
  initScript: window.initScriptRan ?? false,
  routed: (await (await fetch('/echo')).json()).routed ?? false,
  usesHttpCache: (await (await fetch('/counted')).text()) === (await (await fetch('/counted')).text()),
}))()`;

/** What scripts the attempt ran did in the document: an init script's mark, and whether service workers can still be registered. */
const DONE_BY_SCRIPTS = `({
  initScript: window.initScriptRan ?? false,
  registersServiceWorkers: String(navigator.serviceWorker.register).includes('[native code]'),
})`;

const HOSTS: readonly (readonly [string, () => RemoteChromeOptions])[] = [
  ['the headless shell', () => ({})],
  ['the pinned full Chrome', () => ({ fullChrome: installedChrome() })],
];

describe.each(HOSTS)('what an attempt sets in a browser it does not own, on %s', (_host, options) => {
  let pages: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;
  let session: WebSession | undefined;

  beforeAll(async () => {
    pages = await startPageServer();
    pages.serve('/echo', (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ language: request.headers['accept-language'] ?? null, preview: request.headers['x-preview'] ?? null }));
    });
    let served = 0;
    pages.serve('/counted', (_request, response) => {
      served += 1;
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=3600' });
      response.end(String(served));
    });
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

  /** A session whose attempts drive the page Chrome shows, for the app the page server serves. */
  function attach(web: Omit<WebOptions, 'connect'>, permissions: Record<string, 'grant'> = {}): Promise<WebSession> {
    return startWebSession({ appUrl: pages.origin, app: { permissions }, web: { ...web, connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
  }

  it('gives the page back as it found it when the attempt ends, each configured option taken back', async () => {
    const tab = await showOnly(endpoint, pages, '/configured', '<title>Configured</title>');
    const found = await evaluateInTab(endpoint, tab, CONFIGURED);

    session = await attach(
      { viewport: { width: 500, height: 400 }, userAgent: 'e2e-configured', locale: 'de-DE', timezoneId: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce', headers: { 'x-preview': 'on' } },
      { 'clipboard-read': 'grant', 'clipboard-write': 'grant' },
    );
    await session.browser.goto('/configured');
    expect(await session.browser.evaluate(CONFIGURED)).toEqual({
      userAgent: 'e2e-configured',
      language: 'de-DE',
      timeZone: 'Asia/Tokyo',
      dark: true,
      reducedMotion: true,
      viewport: [500, 400, 1],
      clipboardRead: 'granted',
      clipboardWrite: 'granted',
      sent: { language: 'de-DE', preview: 'on' },
    });

    await session.endAttempt();
    await expect.poll(() => evaluateInTab(endpoint, tab, CONFIGURED)).toEqual(found);
    await session.close();
    session = undefined;
    await expect.poll(() => evaluateInTab(endpoint, tab, CONFIGURED)).toEqual(found);
  });

  it('starts the next attempt without what a test set in the one before', async () => {
    await showOnly(endpoint, pages, '/set-by-a-test', '<title>Set by a test</title>');
    session = await attach({ viewport: null });
    const found = await session.browser.evaluate(SET_BY_A_TEST);

    await session.browser.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await session.browser.setViewport({ width: 320, height: 480 });
    await session.browser.addInitScript('window.initScriptRan = true');
    await session.browser.route('**/echo', (route) => route.fulfill({ json: { routed: true } }));
    await session.browser.goto('/set-by-a-test');
    expect(await session.browser.evaluate(SET_BY_A_TEST)).toEqual({ dark: true, reducedMotion: true, viewport: [320, 480, 1], initScript: true, routed: true, usesHttpCache: false });

    await session.startAttempt();
    await session.browser.goto('/set-by-a-test');
    await expect.poll(() => session!.browser.evaluate(SET_BY_A_TEST)).toEqual(found);
  });

  it('gives the page back as it found it when attachBrowser closes', async () => {
    const tab = await showOnly(endpoint, pages, '/attached', '<title>Attached</title>');
    const found = await evaluateInTab(endpoint, tab, CONFIGURED);
    const attached = await attachBrowser(endpoint, { timeout: 30_000 });
    try {
      await attached.browser.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await attached.browser.setViewport({ width: 320, height: 480 });
      expect(await attached.browser.evaluate(CONFIGURED)).toMatchObject({ dark: true, reducedMotion: true, viewport: [320, 480, 1] });
    } finally {
      await attached.close();
    }
    await expect.poll(() => evaluateInTab(endpoint, tab, CONFIGURED)).toEqual(found);
  });

  it('leaves a document the attempt drove with what scripts did in it, until the document navigates', async () => {
    const tab: OpenTab = await showOnly(endpoint, pages, '/scripted', '<title>Scripted</title>');
    expect(await evaluateInTab(endpoint, tab, DONE_BY_SCRIPTS)).toEqual({ initScript: false, registersServiceWorkers: true });

    session = await attach({ headers: { 'x-preview': 'on' } });
    await session.browser.addInitScript('window.initScriptRan = true');
    await session.browser.goto('/scripted');
    await session.endAttempt();
    // The limit: nothing takes back what a script did in a document that is still open.
    expect(await evaluateInTab(endpoint, tab, DONE_BY_SCRIPTS)).toEqual({ initScript: true, registersServiceWorkers: false });

    await evaluateInTab(endpoint, tab, 'void location.reload()');
    await expect.poll(() => evaluateInTab(endpoint, tab, DONE_BY_SCRIPTS)).toEqual({ initScript: false, registersServiceWorkers: true });
  });
});

describe('the tab an attempt adopted on the full Chrome, once the attempt ended', () => {
  let pages: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;
  let session: WebSession | undefined;

  beforeAll(async () => {
    pages = await startPageServer();
    chrome = await launchRemoteChrome({ fullChrome: installedChrome() });
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await pages?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('is a background tab again behind another: hidden, and without the focus the attempt had it emulate', async () => {
    const tab = await showOnly(endpoint, pages, '/behind', '<title>Behind</title>');
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
    await session.endAttempt();
    await openTab(endpoint, pages, '/in-front', '<title>In front</title>');
    expect(await evaluateInTab(endpoint, tab, '[document.visibilityState, document.hasFocus()]')).toEqual(['hidden', false]);
  });
});
