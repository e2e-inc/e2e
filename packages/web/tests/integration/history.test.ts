/**
 * `browser.back` and `browser.forward` past either end of the tab's
 * history: the tab stays where it is, and the next move through the history
 * still works. An unreachable address fails a navigation with the browser's
 * own name for it, which the runner reads to say nothing answered there.
 */

import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('history and unreachable addresses', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  it('stays on the page when there is no entry to go back or forward to', async () => {
    const first = page.serve('/history-first', '<title>First</title>');
    const second = page.serve('/history-second', '<title>Second</title>');
    await page.browser.goto(first);
    await page.browser.goto(second);
    await page.browser.forward();
    expect(await page.browser.title()).toBe('Second');
    await page.browser.back();
    expect(await page.browser.title()).toBe('First');
    await page.browser.forward();
    expect(await page.browser.title()).toBe('Second');
  });

  it('loads the page again that it goes back or forward to, on a browser launched without its back-forward cache', async () => {
    const shows = '<script>window.shown = []; addEventListener("pageshow", (event) => shown.push(event.persisted));</script>';
    const first = page.serve('/history-shown-first', `<title>First</title>${shows}`);
    const second = page.serve('/history-shown-second', `<title>Second</title>${shows}`);
    await page.browser.goto(first);
    await page.browser.goto(second);
    await page.browser.back();
    expect(await page.browser.evaluate('[document.title, window.shown]')).toEqual(['First', [false]]);
    await page.browser.forward();
    expect(await page.browser.evaluate('[document.title, window.shown]')).toEqual(['Second', [false]]);
  });

  it('fails a navigation to a port nothing listens on with the name the runner knows', async () => {
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    await expect(page.browser.goto(`http://127.0.0.1:${String(free)}/`)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining(onFirefox ? 'NS_ERROR_CONNECTION_REFUSED' : 'ERR_CONNECTION_REFUSED'),
    });
  });
});
