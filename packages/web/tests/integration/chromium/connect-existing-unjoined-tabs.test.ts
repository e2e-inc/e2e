/**
 * `web({ connect: { context: 'existing' } })` when a test ends with a tab
 * its page opened that has not joined the attempt's tabs: one whose only
 * navigation answered `204`, opened by a script or by a `target="_blank"`
 * link, and one still waiting on its first response. Each is closed with
 * the attempt, so the next attempt finds the one page the browser showed
 * and drives it, on the headless shell and on the pinned full Chrome.
 */

import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BidiConnection } from '../../../src/driver/connection.ts';
import { closeRemoteChrome, installedChrome, launchRemoteChrome, type RemoteChrome, type RemoteChromeOptions } from '../../helpers/cdp-host.ts';
import { openTabs, showOnly } from '../../helpers/cdp-tabs.ts';
import { byRole, startPageServer, startWebSession, type PageServer, type WebSession } from '../../helpers/web-session.ts';

/** A link and a button that each open `/nowhere` in a new tab, and a button that opens `/slow` in one, beside a button that counts its clicks. */
const APP = `<!doctype html><title>App</title>
<a href="/nowhere" target="_blank">Link nowhere</a>
<button onclick="window.open('/nowhere')">Script nowhere</button>
<button onclick="window.open('/slow')">Open slow</button>
<button id=press>Press me</button><p id=count>clicked 0</p>
<script>
  let clicks = 0;
  press.addEventListener('click', () => { clicks += 1; count.textContent = 'clicked ' + clicks; });
</script>`;

const HOSTS: readonly (readonly [string, () => RemoteChromeOptions])[] = [
  ['the headless shell', () => ({})],
  ['the pinned full Chrome', () => ({ fullChrome: installedChrome() })],
];

describe.each(HOSTS)("web({ connect: { context: 'existing' } }) on %s, ending with a tab that has not joined", (_host, options) => {
  let pages: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;
  let session: WebSession | undefined;
  /** The responses `/slow` has yet to answer. */
  const waiting: ServerResponse[] = [];

  beforeAll(async () => {
    pages = await startPageServer();
    pages.serve('/nowhere', (_request, response) => {
      response.writeHead(204);
      response.end();
    });
    pages.serve('/slow', (_request, response) => void waiting.push(response));
    chrome = await launchRemoteChrome(options());
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await session?.close();
    session = undefined;
  });

  afterAll(async () => {
    await pages?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  /**
   * Counts the tabs the driver was told a page opened, from now until the
   * test restores its mocks. The driver's own listener hears each one first,
   * so a tab counted here is one the attempt knows of.
   */
  function tabsThePageOpened(): () => number {
    let opened = 0;
    const listening = new WeakSet<BidiConnection>();
    const send = BidiConnection.prototype.send;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      if (!listening.has(this)) {
        listening.add(this);
        this.on('browsingContext.contextCreated', (info) => {
          if (info.originalOpener != null) opened += 1;
        });
      }
      return send.call(this, method, params);
    } as typeof send);
    return () => opened;
  }

  /** A session whose attempts drive the page Chrome shows. */
  function attach(): Promise<WebSession> {
    return startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint, context: 'existing' } } });
  }

  it('closes the tabs that never got a document, and the next attempt drives the page', async () => {
    const shown = await showOnly(endpoint, pages, '/app', APP);
    const opened = tabsThePageOpened();
    session = await attach();
    await session.act(byRole('button', 'Script nowhere'), { kind: 'tap' });
    await session.act(byRole('link', 'Link nowhere'), { kind: 'tap' });
    await expect.poll(opened).toBe(2);
    expect(await openTabs(endpoint)).toHaveLength(3);
    expect(session.browser.tabs()).toHaveLength(1);

    await session.startAttempt();
    expect(await openTabs(endpoint)).toEqual([shown]);
    expect(await session.browser.url()).toBe(shown.url);
    await session.act(byRole('button', 'Press me'), { kind: 'tap' });
    expect(await session.browser.evaluate(() => document.getElementById('count')!.textContent)).toBe('clicked 1');
  });

  it('closes a tab still waiting on its first response, whose page never shows', async () => {
    const shown = await showOnly(endpoint, pages, '/app-slow', APP);
    const opened = tabsThePageOpened();
    session = await attach();
    await session.act(byRole('button', 'Open slow'), { kind: 'tap' });
    await expect.poll(opened).toBe(1);
    await expect.poll(() => waiting.length).toBe(1);
    expect(session.browser.tabs()).toHaveLength(1);

    await session.startAttempt();
    expect(await openTabs(endpoint)).toEqual([shown]);
    waiting.pop()!.end('<title>Late</title>');
    expect(await session.browser.url()).toBe(shown.url);
    expect(await openTabs(endpoint)).toEqual([shown]);
  });
});
