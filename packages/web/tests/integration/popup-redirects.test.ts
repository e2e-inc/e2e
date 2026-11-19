/**
 * A tab or a window the app opens that navigates while it opens: a first
 * document that sends it on at once, from a script or from the server, and
 * one that closes itself. `browser.waitForPopup` shows it at the attempt's
 * viewport whichever of its documents it was sized under, and its last
 * corner takes a tap.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

const VIEWPORT = { width: 1280, height: 720 } as const;
const TARGET = { width: 24, height: 12 } as const;

/** Where a popup ends up: a target in the viewport's bottom-right corner, which records each click with its point. */
const LANDED = `<!doctype html><title>Landed</title>
  <style>
    html { scrollbar-width: none }
    body { margin: 0 }
    button { position: fixed; bottom: 0; right: 0; width: ${String(TARGET.width)}px; height: ${String(TARGET.height)}px; padding: 0; border: 0; background: #00f }
  </style>
  <script>
    window.clicked = [];
    addEventListener('click', (event) => clicked.push(event.target.id + ' ' + event.clientX + ',' + event.clientY), true);
  </script>
  <button id="corner"></button>`;

/** A document that sends its tab on to `next` from a script in its head, before it has a body. */
function sendsOn(next: string): string {
  return `<!doctype html><html><head><title>Redirecting</title><script>location.replace(${JSON.stringify(next)})</script></head><body>Redirecting</body></html>`;
}

/** How long the page behind the slow hop takes to answer: long enough that the popup is sized under the document before it. */
const SLOW_HOP_MS = 300;

/** How many documents the chain sends a popup through before the last one. */
const CHAIN_HOPS = 8;

/** Each way a popup gets from its first URL to the landed page. */
const WAYS = {
  'a script in its first document': '/script',
  'a chain of scripts': `/chain?left=${String(CHAIN_HOPS)}`,
  'two redirects from the server': '/server',
  'a script, then a page that answers late': '/slow',
} as const;

const OPENER = `<!doctype html><title>Opener</title>
  <script>
    window.clicked = [];
    addEventListener('click', (event) => clicked.push(event.target.id), true);
  </script>
  <button id="opener-target">Target</button>
  ${[...Object.values(WAYS), '/closes'].flatMap((url, index) => [
    `<button id="window-${String(index)}" onclick="window.open('${url}', '', 'popup,width=500,height=600')">Window ${String(index)}</button>`,
    `<a id="tab-${String(index)}" href="${url}" target="_blank">Tab ${String(index)}</a>`,
  ]).join('')}`;

describe('a popup that navigates while it opens', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession();
    page.serve('/opener', OPENER);
    page.serve('/landed', LANDED);
    page.serve('/script', sendsOn('/landed'));
    page.serve('/chain', (request, response) => {
      const left = Number(new URL(request.url ?? '/', page.origin).searchParams.get('left'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(sendsOn(left > 1 ? `/chain?left=${String(left - 1)}` : '/landed'));
    });
    for (const [from, to] of [['/server', '/server-hop'], ['/server-hop', '/landed']] as const) {
      page.serve(from, (_request, response) => {
        response.writeHead(302, { location: to });
        response.end();
      });
    }
    page.serve('/slow', sendsOn('/slow-landed'));
    page.serve('/slow-landed', (_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(LANDED);
      }, SLOW_HOP_MS);
    });
    page.serve('/closes', '<!doctype html><title>Closes</title><body>Closing<script>setTimeout(() => window.close(), 5)</script></body>');
  });
  afterEach(async () => {
    for (const tab of page.browser.tabs().slice(1)) await tab.close();
  });
  afterAll(async () => {
    await page?.close();
  });

  describe.each(['window', 'tab'] as const)('opened as a %s', (kind) => {
    it.each(Object.keys(WAYS).map((way, index) => [way, index] as const))('is shown at the viewport, and its last corner takes a tap, after %s', async (_way, index) => {
      await page.open(`${page.origin}/opener`);
      const popup = await page.browser.waitForPopup(() => page.browser.locator(`#${kind}-${String(index)}`).tap());
      expect(popup.isActive()).toBe(true);
      await page.browser.locator('#corner').tap();
      expect(await popup.url()).toMatch(/\/(slow-)?landed$/);
      expect(await page.browser.evaluate('({ width: innerWidth, height: innerHeight })')).toEqual(VIEWPORT);
      const corner = { x: VIEWPORT.width - TARGET.width / 2, y: VIEWPORT.height - TARGET.height / 2 };
      expect(await page.browser.evaluate('window.clicked')).toEqual([`corner ${String(corner.x)},${String(corner.y)}`]);
    });

    it('is no failure when it closes itself, and the tab that opened it takes the next tap', async () => {
      await page.open(`${page.origin}/opener`);
      const popup = await page.browser.waitForPopup(() => page.browser.locator(`#${kind}-${String(Object.keys(WAYS).length)}`).tap());
      await expect.poll(() => popup.isClosed()).toBe(true);
      expect(page.browser.tabs()).toHaveLength(1);
      await page.browser.locator('#opener-target').tap();
      expect(await page.browser.title()).toBe('Opener');
      expect(await page.browser.evaluate('window.clicked.at(-1)')).toBe('opener-target');
    });
  });
});
