/**
 * `attachBrowser` on a page that removes a frame while the attach lists the
 * documents it finds open, between the tree that names the frame and the
 * read of which documents take a call: a frame that is gone has no document
 * to prepare, and the attach drives the page that is left.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BidiConnection } from '../../../src/driver/connection.ts';
import { attachBrowser } from '../../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { evaluateInTab } from '../../helpers/cdp-page.ts';
import { showOnly, type OpenTab } from '../../helpers/cdp-tabs.ts';
import { startPageServer, type PageServer } from '../../helpers/web-session.ts';

describe('attachBrowser on a page that removes a frame as it attaches', () => {
  let server: PageServer;
  let chrome: RemoteChrome;
  let endpoint: string;

  beforeAll(async () => {
    server = await startPageServer();
    chrome = await launchRemoteChrome();
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await server?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  /**
   * Has the page of `tab` remove its frame, once, before the first read of
   * which documents take a call (`script.getRealms`) leaves the driver, and
   * holds every such read until the browser said the frame's context is
   * gone. Returns how many reads were held.
   */
  function removeFrameBeforeRealmsAreRead(tab: OpenTab): () => number {
    const send = BidiConnection.prototype.send;
    let removed: Promise<void> | undefined;
    let held = 0;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      if (method !== 'script.getRealms') return send.call(this, method, params);
      held += 1;
      removed ??= (async () => {
        const gone = new Promise<void>((resolve) => {
          const off = this.on('browsingContext.contextDestroyed', (info) => {
            if (info.parent == null) return;
            off();
            resolve();
          });
        });
        await evaluateInTab(endpoint, tab, "document.getElementById('going').remove()");
        await gone;
      })();
      return removed.then(() => send.call(this, method, params));
    } as typeof send);
    return () => held;
  }

  it('drives the page that is left, the frame that went away prepared no more than a document that has none', async () => {
    const tab = await showOnly(endpoint, server, '/removes-frame', `<!doctype html><title>Removes a frame</title>
      <iframe id=going srcdoc="<p>going</p>"></iframe><iframe id=staying srcdoc="<button>In frame</button>"></iframe>
      <button onclick="this.textContent = 'Pressed'">Press me</button>`);
    const heldReads = removeFrameBeforeRealmsAreRead(tab);

    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    // The tab, and both frames the tree listed: the removed one was asked for its realms after it was gone.
    expect(heldReads()).toBeGreaterThanOrEqual(3);
    expect(await attached.browser.evaluate(() => [...document.querySelectorAll('iframe')].map((frame) => frame.id))).toEqual(['staying']);
    await attached.screen.getByRole('button', 'Press me').tap();
    expect(await attached.screen.getByRole('button', 'Pressed').count()).toBe(1);
    expect(await attached.browser.frameLocator('#staying').getByRole('button', 'In frame').count()).toBe(1);
  });
});
