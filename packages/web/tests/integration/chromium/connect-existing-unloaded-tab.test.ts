/**
 * `web({ connect: { context: 'existing' } })` beside a tab the browser's own
 * page opened whose only navigation answered `204`, so that it never got a
 * document. The tab opens while the worker's browser connection is up, so
 * the browser saw its navigation start, and from then on holds every call
 * put to the tab by its browsing context. Picking the tab to drive asks
 * nothing that way: the next attempt drives the page a person sees on the
 * full Chrome, and on the headless shell, which shows both tabs, it is
 * refused at once with both named.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteChrome, installedChrome, launchRemoteChrome, type RemoteChrome, type RemoteChromeOptions } from '../../helpers/cdp-host.ts';
import { evaluateInTab } from '../../helpers/cdp-page.ts';
import { openTabs, showOnly, showTab, type OpenTab } from '../../helpers/cdp-tabs.ts';
import { gate } from '../../helpers/gate.ts';
import { byRole, startPageServer, startWebSession, type PageServer, type WebSession } from '../../helpers/web-session.ts';

const APP = '<!doctype html><title>App</title><button onclick="this.textContent = \'Pressed\'">Press me</button>';

describe("web({ connect: { context: 'existing' } }) beside a tab that never got a document", () => {
  let pages: PageServer;
  let chrome: RemoteChrome | undefined;
  let session: WebSession | undefined;

  beforeAll(async () => {
    pages = await startPageServer();
  });

  afterEach(async () => {
    await session?.close();
    session = undefined;
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    chrome = undefined;
  });

  afterAll(async () => {
    await pages?.close();
  });

  /**
   * A Chrome of `options` showing the app, a session whose first attempt
   * drove that page and ended, and a tab the page then opened on a URL that
   * answers `204`, with the app's tab back in front of it.
   */
  async function besideUnloadedTab(options: RemoteChromeOptions): Promise<{ endpoint: string; shown: OpenTab; unloaded: OpenTab }> {
    const hosted = await launchRemoteChrome(options);
    chrome = hosted;
    const endpoint = `http://${new URL(hosted.endpoint).host}`;
    const shown = await showOnly(endpoint, pages, '/app', APP);
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => hosted.endpoint, context: 'existing' } } });
    await session.endAttempt();

    const { held: answered, release: answer } = gate();
    const nowhere = pages.serve('/nowhere', (_request, response) => {
      response.writeHead(204);
      response.end();
      answer();
    });
    await evaluateInTab(endpoint, shown, `void window.open(${JSON.stringify(nowhere)})`);
    await answered;
    await showTab(endpoint, shown);
    const open = await openTabs(endpoint);
    expect(open).toHaveLength(2);
    return { endpoint, shown, unloaded: open.find((tab) => tab.id !== shown.id)! };
  }

  it('drives the page the full Chrome shows, and leaves the other tab open', async () => {
    const { endpoint, shown, unloaded } = await besideUnloadedTab({ fullChrome: installedChrome() });
    await session!.startAttempt();
    expect(await session!.browser.url()).toBe(shown.url);
    await session!.act(byRole('button', 'Press me'), { kind: 'tap' });
    expect(await session!.locate(byRole('button', 'Pressed'))).toHaveLength(1);
    await session!.endAttempt();
    expect((await openTabs(endpoint)).map((tab) => tab.id).toSorted()).toEqual([shown.id, unloaded.id].toSorted());
  }, 60_000);

  it('is refused at once on the headless shell, which shows both tabs, with both named', async () => {
    const { endpoint, shown, unloaded } = await besideUnloadedTab({});
    await expect(session!.startAttempt()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringMatching(/^cannot tell which tab of the attached browser to drive: 2 are open \(.*about:blank.*\) and 2 of them are visible\. Leave one tab visible, or close the others\.$/),
    });
    expect((await openTabs(endpoint)).map((tab) => tab.id).toSorted()).toEqual([shown.id, unloaded.id].toSorted());
  }, 60_000);
});
