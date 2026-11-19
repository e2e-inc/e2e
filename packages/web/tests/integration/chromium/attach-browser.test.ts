/**
 * `attachBrowser` on a Chrome the test owns: `browser` and `screen` drive the
 * open tab in the default context, and closing detaches without closing the
 * tab or the browser, whose cookies the next attach still sees. The frames
 * already loaded in the tab are the attached session's from the start, and
 * a page no attach loaded is tapped as it is found, and edited and read
 * without what a preload would have kept in it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachBrowser } from '../../../src/index.ts';
import { launchRemoteChrome, recordGoodbyes, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { startPageServer, type PageServer } from '../../helpers/web-session.ts';
import { openTabs, showOnly } from '../../helpers/cdp-tabs.ts';

describe('attachBrowser', () => {
  let app: FixtureApp;
  let server: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    server = await startPageServer();
    chrome = await launchRemoteChrome();
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterAll(async () => {
    await tearDownRemote({ chrome, closes: [() => app?.close(), () => server?.close()] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs in on the open tab and leaves the tab, the browser, and the cookie behind', async () => {
    const [tab] = await openTabs(endpoint);
    expect(tab).toBeDefined();
    const goodbyes = recordGoodbyes();

    const first = await attachBrowser(endpoint);
    try {
      await first.browser.goto(`${app.url}/sign-in`);
      await first.screen.getByLabel('Email').fill('qa@example.com');
      await first.screen.getByLabel('Password').fill('hunter2');
      await first.screen.getByRole('button', 'Sign in').tap();
      await first.browser.waitForURL(`${app.url}/`);
    } finally {
      await first.close();
    }

    expect(goodbyes()).toEqual(['session.end']);
    expect(await openTabs(endpoint)).toEqual([{ id: tab!.id, url: `${app.url}/` }]);

    await using second = await attachBrowser(endpoint);
    expect(await second.browser.url()).toBe(`${app.url}/`);
    expect(await second.screen.getByRole('heading', 'Home').count()).toBe(1);
    expect((await second.browser.cookies()).map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'session', value: 'qa%40example.com' }]);
  });

  it('closes the tabs it opened when it detaches, whichever tab is active, and leaves the open tab', async () => {
    const before = await openTabs(endpoint);
    const attached = await attachBrowser(endpoint);
    try {
      const opened = await attached.browser.newTab();
      expect(await openTabs(endpoint)).toHaveLength(before.length + 1);
      await attached.browser.tabs()[0]!.activate();
      expect(opened.isActive()).toBe(false);
    } finally {
      await attached.close();
    }
    expect(await openTabs(endpoint)).toEqual(before);
  });

  it('routes and waits for the requests of a frame the tab loaded before it attached', async () => {
    server.serve('/data', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('served');
    });
    const frame = server.serve('/frame', '<body>frame</body>');
    const page = server.serve('/top', `<iframe src="${frame}"></iframe>`);
    const seed = await attachBrowser(endpoint);
    try {
      await seed.browser.goto(page);
    } finally {
      await seed.close();
    }

    await using attached = await attachBrowser(endpoint);
    let routed = 0;
    await attached.browser.route('**/probe', async (route) => {
      routed += 1;
      await route.fulfill({ body: 'routed' });
    });
    const fetchInFrame = (path: string) => attached.browser.evaluate(
      async (url: string) => await (await document.querySelector('iframe')!.contentWindow!.fetch(url)).text(),
      path,
    );
    expect(await fetchInFrame('/probe')).toBe('routed');
    expect(routed).toBe(1);
    const response = attached.browser.waitForResponse('**/data', { timeout: 5_000 });
    expect(await fetchInFrame('/data')).toBe('served');
    expect(await (await response).text()).toBe('served');
    expect(await attached.browser.url()).toBe(page);
  });

  it('sets a cookie that names its own url or domain, though the attach has no app URL', async () => {
    await using attached = await attachBrowser(endpoint);
    const { browser } = attached;
    const { hostname } = new URL(server.origin);
    try {
      await browser.setCookies([
        { name: 'attach-url', value: '1', url: `${server.origin}/account/settings` },
        { name: 'attach-domain', value: '2', domain: hostname, path: '/admin' },
      ]);
      const set = (await browser.cookies()).filter((cookie) => cookie.name.startsWith('attach-'));
      expect(set.map(({ name, value, domain, path }) => ({ name, value, domain, path })).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'attach-domain', value: '2', domain: hostname, path: '/admin' },
        { name: 'attach-url', value: '1', domain: hostname, path: '/account/' },
      ]);
      await expect(browser.setCookies([{ name: 'attach-relative', value: '3', url: '/account' }])).rejects.toMatchObject({ code: 'APP_URL_REQUIRED' });
      await expect(browser.setCookies([{ name: 'attach-nowhere', value: '4' } as never])).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'browser.setCookies: cookie "attach-nowhere" needs a url or a domain',
      });
    } finally {
      await browser.clearCookies({ name: /^attach-/ });
    }
  });

  it('taps the page it finds open, which no attach loaded, with no navigation first', async () => {
    const { url: found } = await showOnly(endpoint, server, '/found', `<button id=b>Tap me</button><script>
      window.log = [];
      for (const type of ['mousedown', 'mouseup', 'click']) b.addEventListener(type, () => log.push(type));
    </script>`);
    await using attached = await attachBrowser(endpoint);
    expect(await attached.browser.url()).toBe(found);
    await attached.screen.getByRole('button', 'Tap me').tap();
    expect(await attached.browser.evaluate('window.log')).toEqual(['mousedown', 'mouseup', 'click']);
  });

  it('edits and reads the page it finds open without what a preload would have kept there', async () => {
    await showOnly(endpoint, server, '/found-unkept', `<input type=range max=10 aria-label=Level><div id=host></div>
      <script>
        window.log = [];
        for (const type of ['input', 'change']) document.querySelector('input').addEventListener(type, (event) => log.push(type + ':' + event.target.value));
        host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed</button>';
      </script>`);
    await using attached = await attachBrowser(endpoint);
    const { browser, screen } = attached;
    // The `Event` kept at the attach is the page's own, as it was then.
    await screen.getByLabel('Level').fill('7');
    expect(await browser.evaluate('window.log')).toEqual(['input:7', 'change:7']);
    // A closed root attached before any preload is in no record, so what it holds stays out of reach.
    expect(await screen.getByRole('button', 'Closed').count()).toBe(0);
  });
});
