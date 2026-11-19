/**
 * `web({ connect: { context: 'existing' } })` on the headless shell and on
 * the pinned full Chrome: a test drives the page the browser already shows,
 * `app.open()` navigates it, no context or tab is created, a second attempt
 * finds the window and the state the first left, and what would replace the
 * browser context is refused. Electron, the host this is for, can create
 * neither; these hosts can, so the tests assert that nothing was.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ATTACH_HOSTS, closeRemoteChrome, installedChrome, launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { evaluateInTab } from '../../helpers/cdp-page.ts';
import { openTab, openTabs, showOnly } from '../../helpers/cdp-tabs.ts';
import { byRole, startPageServer, startWebSession, type PageServer, type WebSession } from '../../helpers/web-session.ts';

/** A button that counts its clicks and a field, on a page that reads what an earlier attempt left. */
const APP = `<!doctype html><title>App</title>
<button id=press>Press me</button><p id=count>clicked 0</p>
<label>Name <input id=name></label>
<script>
  let clicks = 0;
  press.addEventListener('click', () => { clicks += 1; count.textContent = 'clicked ' + clicks; });
</script>`;

describe.each(ATTACH_HOSTS)("web({ connect: { context: 'existing' } }) on %s", (_host, options) => {
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

  /** A session whose attempts drive the page Chrome shows. */
  function attach(): Promise<WebSession> {
    return startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
  }

  /** Taps the page's button and reads what it counted. */
  async function pressOnce(driven: WebSession): Promise<string | null> {
    await driven.act(byRole('button', 'Press me'), { kind: 'tap' });
    return driven.browser.evaluate(() => document.getElementById('count')!.textContent);
  }

  it('opens the app in the window the browser shows, and a second attempt finds that window and what the first left', async () => {
    const shown = await showOnly(endpoint, pages, '/shown', '<title>Shown</title>');
    session = await attach();
    expect(await session.browser.url()).toBe(shown.url);

    const app = session.serve('/app', APP);
    await session.browser.goto('/app');
    expect(await pressOnce(session)).toBe('clicked 1');
    await session.browser.locator('#name').fill('Ada');
    expect(await session.browser.evaluate(() => (document.getElementById('name') as HTMLInputElement).value)).toBe('Ada');
    await session.browser.evaluate(() => {
      localStorage.setItem('left', 'by the first attempt');
      document.cookie = 'left=first';
      return null;
    });
    expect(await openTabs(endpoint)).toEqual([{ id: shown.id, url: app }]);

    await session.startAttempt();
    expect(await session.browser.url()).toBe(app);
    await session.open(app);
    expect(await session.browser.evaluate(() => [localStorage.getItem('left'), document.cookie])).toEqual(['by the first attempt', 'left=first']);
    expect(await pressOnce(session)).toBe('clicked 1');
    expect(await openTabs(endpoint)).toEqual([{ id: shown.id, url: app }]);

    await session.close();
    session = undefined;
    expect(chrome.proc.exitCode).toBeNull();
    expect(await openTabs(endpoint)).toEqual([{ id: shown.id, url: app }]);
  });

  it('refuses app.clearState(), keeps no saved session, and closes only the tab it opened', async () => {
    const shown = await showOnly(endpoint, pages, '/shown-limits', APP);
    session = await attach();
    expect(session.engine.state).toBeUndefined();
    await expect(session.engine.session!.reset!(session.op())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: "app.clearState() is unavailable with web({ connect: { context: 'existing' } }): it replaces the browser context, and the attempt drives the browser's own",
    });
    expect(await pressOnce(session)).toBe('clicked 1');

    await session.browser.newTab();
    expect(await openTabs(endpoint)).toHaveLength(2);
    await session.endAttempt();
    expect(await openTabs(endpoint)).toEqual([shown]);
  });
});

describe("web({ connect: { context: 'existing' } }) beside tabs the browser already had", () => {
  let pages: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;
  let session: WebSession | undefined;

  beforeAll(async () => {
    pages = await startPageServer();
    chrome = await launchRemoteChrome({ fullChrome: installedChrome() });
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  afterAll(async () => {
    await tearDownRemote({ ends: [() => session?.close()], chrome, closes: [() => pages?.close()] });
  });

  it('restarts in the window it drives and leaves the background tab open', async () => {
    const background = await showOnly(endpoint, pages, '/background', '<title>Background</title>');
    const shown = await openTab(endpoint, pages, '/front', APP);
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
    expect(await session.browser.url()).toBe(shown.url);
    await session.browser.newTab();

    await session.engine.session!.restart!(session.op());
    expect(await session.browser.url()).toBe(shown.url);
    expect((await openTabs(endpoint)).toSorted((a, b) => a.url.localeCompare(b.url))).toEqual([background, shown]);
  });

  it('leaves alone a tab that a tab it does not drive opened', async () => {
    const popup = pages.serve('/theirs', '<title>Theirs</title>');
    const background = await showOnly(endpoint, pages, '/opener', '<title>Opener</title>');
    const shown = await openTab(endpoint, pages, '/driven', APP);
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
    const urls = async (): Promise<string[]> => (await openTabs(endpoint)).map((tab) => tab.url).toSorted();

    await evaluateInTab(endpoint, background, "window.open('/theirs') === null");
    await expect.poll(urls).toEqual([shown.url, background.url, popup].toSorted());
    await session.act(byRole('button', 'Press me'), { kind: 'tap' });
    expect(session.browser.tabs()).toHaveLength(1);

    await session.startAttempt();
    expect(await urls()).toEqual([shown.url, background.url, popup].toSorted());
  });
});
