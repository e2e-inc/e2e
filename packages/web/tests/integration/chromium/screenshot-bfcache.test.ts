/**
 * A document that leaves while a capture masks it, in a browser that keeps
 * it in its back-forward cache and shows it again on the way back: the
 * reason the mask takes itself off on `pagehide`. The engine launches its
 * own browsers with that cache off, so the browser here is one it attaches
 * to: the pinned full Chrome, since the headless shell keeps no page in the
 * cache whatever its flags (`BackForwardCacheDisabledForDelegate`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { aroundCapture, heldByCapture } from '../../helpers/capture-hooks.ts';
import { installedChrome, launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startWebSession, type WebSession } from '../../helpers/web-session.ts';
import { gate } from '../../helpers/gate.ts';

/** A block that blinks forever beside a secure field, in a page that records whether each `pageshow` restored it from the cache. */
const MASKED = `<!doctype html>
<style>
  body { margin: 0; background: #fff; }
  @keyframes blink { from { background-color: rgb(255, 0, 0); } to { background-color: rgb(0, 0, 255); } }
  #blink { width: 40px; height: 40px; background: rgb(0, 128, 0); animation: blink 200ms linear infinite alternate; }
</style>
<div id="blink"></div>
<input type="password" value="hunter22" style="position:absolute;left:100px;top:100px;width:100px;height:30px">
<script>window.shown = []; addEventListener('pageshow', (event) => shown.push(event.persisted));</script>`;

describe('a document that leaves masked on a browser that keeps it in its back-forward cache', () => {
  let chrome: RemoteChrome;
  let session: WebSession;

  beforeAll(async () => {
    chrome = await launchRemoteChrome({ fullChrome: installedChrome() });
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint } } });
  }, 60_000);

  afterAll(async () => {
    await tearDownRemote({ ends: [() => vi.restoreAllMocks(), () => session?.close()], chrome });
  });

  it('comes back from the cache unmasked and animating', async () => {
    const masked = session.serve('/masked', MASKED);
    const next = session.serve('/next', '<!doctype html><title>Next</title><p>Next</p>');
    await session.open(masked);
    const during: string[] = [];
    const { held: whenLeft, release: left } = gate();
    aroundCapture({
      before: async (order) => {
        if (order > 1) return;
        during.push(await session.browser.evaluate(heldByCapture));
        await session.open(next);
        left();
      },
      // The driver reaches the tab once the document is gone, as it does when a navigation commits at once.
      unmask: () => whenLeft,
    });

    await session.observe({ pixels: true });
    vi.restoreAllMocks();
    await session.browser.back();

    expect(during).toEqual(['1 hosts, 1 sheets, 0 animations']);
    // The second `pageshow` restored the document the capture masked, where a load would have made a new one.
    expect(await session.browser.evaluate('window.shown')).toEqual([false, true]);
    expect(await session.browser.evaluate(heldByCapture)).toBe('0 hosts, 0 sheets, 1 animations');
    // A masking left behind would take over what each later capture cancels, and never play it again.
    await session.observe({ pixels: true });
    await expect.poll(() => session.browser.evaluate(() => Number(document.getElementById('blink')!.getAnimations()[0]?.currentTime ?? -1)), { timeout: 5_000 }).toBeGreaterThan(0);
  });
});
