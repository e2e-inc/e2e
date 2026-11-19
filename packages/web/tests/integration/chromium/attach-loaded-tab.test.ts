/**
 * `attachBrowser` on a tab that already shows a page, with no navigation
 * after the attach, on the headless shell and on the pinned full Chrome: the
 * page is read, tapped once, filled, and observed as it is found, and from
 * the attach on it records what a page loaded under the preloads records.
 * Of several tabs the attach drives the one a person sees, never a page the
 * browser prerenders, and it refuses when the browser shows more than one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachBrowser } from '../../../src/index.ts';
import { ATTACH_HOSTS, closeRemoteChrome, installedChrome, launchRemoteChrome, type RemoteChrome, type RemoteChromeOptions } from '../../helpers/cdp-host.ts';
import { openTab, openTabs, showOnly, showTab } from '../../helpers/cdp-tabs.ts';
import { startPageServer, type PageServer } from '../../helpers/web-session.ts';
import { gate } from '../../helpers/gate.ts';

/** A button that counts its clicks, two fields that log their edits, a framed button, a shadow host, and two dialogs over a button. */
const APP = `<!doctype html><title>App</title>
<button id=press>Press me</button><p id=count>clicked 0</p>
<label>Name <input id=name></label><input type=range max=10 aria-label=Level>
<iframe srcdoc="<button onclick='parent.framed = (parent.framed ?? 0) + 1'>In frame</button>"></iframe>
<div id=host></div><button>Behind</button>
<dialog id=lower><button>Lower</button></dialog><dialog id=upper><button>Upper</button></dialog>
<script>
  let clicks = 0;
  press.addEventListener('click', () => { clicks += 1; count.textContent = 'clicked ' + clicks; });
  window.edits = [];
  for (const type of ['input', 'change']) document.addEventListener(type, (event) => edits.push(type + ':' + event.target.value));
</script>`;

describe.each(ATTACH_HOSTS)('attachBrowser on a tab %s already shows', (_host, options) => {
  let server: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;

  beforeAll(async () => {
    server = await startPageServer();
    chrome = await launchRemoteChrome(options());
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('reads, taps once, fills, and observes the page it finds, with no navigation first', async () => {
    const tab = await showOnly(endpoint, server, '/app', APP);
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    const { browser, screen } = attached;
    expect(await browser.url()).toBe(tab.url);
    expect(await browser.evaluate(() => location.href)).toBe(tab.url);

    await screen.getByRole('button', 'Press me').tap();
    expect(await browser.evaluate(() => document.getElementById('count')!.textContent)).toBe('clicked 1');
    await screen.getByLabel('Name').fill('Ada');
    expect(await browser.evaluate(() => (document.getElementById('name') as HTMLInputElement).value)).toBe('Ada');
    expect(await browser.evaluate('window.edits')).toEqual(['input:Ada']);
    await browser.frameLocator('iframe').getByRole('button', 'In frame').tap();
    expect(await browser.evaluate('window.framed')).toBe(1);

    const tree = await screen.tree();
    expect(tree).toContain('button "Press me"');
    expect(tree).toContain('clicked 1');
    expect(tree).toContain('button "In frame"');
    expect(await openTabs(endpoint)).toEqual([tab]);
  });

  it('records, from the attach on, what a page loaded under the preloads records', async () => {
    await showOnly(endpoint, server, '/app-footing', APP);
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    const { browser, screen } = attached;
    // A closed root attached after the attach is recorded, so what it holds is read.
    await browser.evaluate(() => {
      document.getElementById('host')!.attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed</button>';
      return null;
    });
    expect(await screen.getByRole('button', 'Closed').count()).toBe(1);
    // The page's own `Event` was kept at the attach, so an edit still fires its events once the page replaced it.
    await browser.evaluate('void (window.Event = class {})');
    await screen.getByLabel('Level').fill('7');
    expect(await browser.evaluate('window.edits')).toEqual(['input:7', 'change:7']);
    // Modal dialogs shown after the attach have an order: the one shown last is on top, and the rest of the page is left out of the tree.
    await browser.evaluate('lower.showModal(), upper.showModal(), document.activeElement.blur()');
    const tree = await screen.tree();
    expect(tree).toContain('button "Upper"');
    expect(tree).not.toContain('button "Lower"');
    expect(tree).not.toContain('button "Behind"');
  });

  it('attaches to a page that replaced a builtin the driver\'s own scripts call, and drives the next document', async () => {
    const tab = await showOnly(endpoint, server, '/app-broken', `${APP}<script>window.WeakMap = undefined;</script>`);
    const next = server.serve('/app-next', APP);
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    const { browser, screen } = attached;
    expect(await browser.evaluate(() => location.href)).toBe(tab.url);
    await browser.goto(next);
    await screen.getByRole('button', 'Press me').tap();
    expect(await browser.evaluate(() => document.getElementById('count')!.textContent)).toBe('clicked 1');
  });

  it('taps once on each attach to the same document, and keeps what the first attach kept there', async () => {
    await showOnly(endpoint, server, '/app-again', APP);
    const first = await attachBrowser(endpoint, { timeout: 30_000 });
    try {
      await first.screen.getByRole('button', 'Press me').tap();
      await first.browser.evaluate('void (window.Event = class {})');
    } finally {
      await first.close();
    }
    await using second = await attachBrowser(endpoint, { timeout: 30_000 });
    await second.screen.getByRole('button', 'Press me').tap();
    expect(await second.browser.evaluate(() => document.getElementById('count')!.textContent)).toBe('clicked 2');
    await second.screen.getByLabel('Level').fill('7');
    expect(await second.browser.evaluate('window.edits')).toEqual(['input:7', 'change:7']);
  });
});

describe('the tab attachBrowser drives of several', () => {
  let server: PageServer;

  beforeAll(async () => {
    server = await startPageServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Runs `body` against a Chrome of `options` it launches and closes. */
  async function withChrome(options: RemoteChromeOptions, body: (endpoint: string) => Promise<void>): Promise<void> {
    const chrome = await launchRemoteChrome(options);
    try {
      await body(`http://${new URL(chrome.endpoint).host}`);
    } finally {
      await closeRemoteChrome(chrome);
    }
  }

  /** The URL of the document an attach to `endpoint` drives. */
  async function drivenUrl(endpoint: string): Promise<string> {
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    return await attached.browser.evaluate(() => location.href);
  }

  it('is the tab the window of the full Chrome shows, whichever opened first', async () => {
    await withChrome({ fullChrome: installedChrome() }, async (endpoint) => {
      const first = await showOnly(endpoint, server, '/first', '<title>First</title>');
      const second = await openTab(endpoint, server, '/second', '<title>Second</title>');
      expect(await drivenUrl(endpoint)).toBe(second.url);
      await showTab(endpoint, first);
      expect(await drivenUrl(endpoint)).toBe(first.url);
      expect(await openTabs(endpoint)).toHaveLength(2);
    });
  }, 60_000);

  it('is never a page the full Chrome prerenders beside the tab', async () => {
    await withChrome({ fullChrome: installedChrome() }, async (endpoint) => {
      const { held: requested, release: prerendered } = gate();
      server.serve('/next', (request, response) => {
        if (String(request.headers['sec-purpose']).includes('prerender')) prerendered();
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<title>Next</title>');
      });
      const tab = await showOnly(endpoint, server, '/prerenders', `<title>Tab</title>
        <script type="speculationrules">{ "prerender": [{ "urls": ["/next"] }] }</script>`);
      await requested;
      await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
      expect(await attached.browser.evaluate(() => location.href)).toBe(tab.url);
      expect(await attached.browser.evaluate('document.prerendering')).toBe(false);
    });
  }, 60_000);

  it('is refused on a headless shell with two tabs, which shows both, until one is closed', async () => {
    await withChrome({}, async (endpoint) => {
      const first = await showOnly(endpoint, server, '/shell-first', '<title>First</title>');
      const second = await openTab(endpoint, server, '/shell-second', '<title>Second</title>');
      await expect(attachBrowser(endpoint, { timeout: 30_000 })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/cannot tell which tab of the attached browser to drive: 2 are open \(.*\) and 2 of them are visible\. Leave one tab visible, or close the others\./),
      });
      expect(await openTabs(endpoint)).toHaveLength(2);
      await fetch(`${endpoint}/json/close/${first.id}`);
      await expect.poll(() => openTabs(endpoint)).toEqual([second]);
      expect(await drivenUrl(endpoint)).toBe(second.url);
    });
  }, 60_000);
});
