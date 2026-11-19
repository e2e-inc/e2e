/**
 * Which 3xx response ends a request, on both browsers: a redirect status
 * (301, 302, 303, 307, 308) that names a `Location` is followed, and every
 * other 3xx is the response the page gets, a 304 to a revalidation
 * included. A response wait resolves with each, the network goes idle
 * after it, and only a followed redirect has no body to read.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

/** The statuses a browser follows when the response names a `Location`. */
const FOLLOWED = [301, 302, 303, 307, 308];
/** Statuses of the 3xx class no browser follows, `Location` or not. */
const NOT_FOLLOWED = [300, 305, 306, 399];

describe('the 3xx response that ends a request', () => {
  let session: WebSession;
  let browser: Browser;
  let page: string;
  /** How many requests reached `/landed`, where every `Location` points. */
  let landed = 0;
  /** The `If-None-Match` of each request for `/revalidated.js`, in order. */
  const validators: (string | undefined)[] = [];

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    page = session.serve('/page', '<!doctype html><title>Statuses</title><h1>Statuses</h1><script src="/revalidated.js"></script>');
    session.serve('/landed', (_request, response) => {
      landed += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('landed');
    });
    for (const status of [...FOLLOWED, ...NOT_FOLLOWED]) {
      session.serve(`/status/${String(status)}`, (_request, response) => {
        response.writeHead(status, { location: '/landed', 'content-type': 'text/plain' });
        response.end(`body of ${String(status)}`);
      });
    }
    session.serve('/revalidated.js', (request, response) => {
      const validator = request.headers['if-none-match'];
      validators.push(validator);
      if (validator === '"v1"') {
        response.writeHead(304, { etag: '"v1"', 'cache-control': 'no-cache' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/javascript', etag: '"v1"', 'cache-control': 'no-cache' });
      response.end('window.revalidated = (window.revalidated ?? 0) + 1;');
    });
  });

  beforeEach(async () => {
    landed = 0;
    validators.length = 0;
    await session.startAttempt();
    browser = session.browser;
    await browser.goto(page);
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** Fetches `pathname` from the page; resolves with the status, the path of the response the page got, and its body. */
  const fetched = (pathname: string): Promise<{ status: number; path: string; body: string }> => browser.evaluate(async (target) => {
    const reply = await fetch(target);
    return { status: reply.status, path: new URL(reply.url).pathname, body: await reply.text() };
  }, pathname);

  it('resolves a response wait with the 304 that revalidated a script, and goes idle after it', async () => {
    const [response] = await Promise.all([
      browser.waitForResponse('**/revalidated.js'),
      browser.reload(),
    ]);
    expect(response.status).toBe(304);
    expect(validators).toEqual([undefined, '"v1"']);
    expect(await response.body()).toEqual(Buffer.alloc(0));
    await browser.goto(page, { waitUntil: 'networkidle' });
    expect(validators).toEqual([undefined, '"v1"', '"v1"']);
    expect(await browser.evaluate(() => (window as unknown as { revalidated?: number }).revalidated ?? 0)).toBe(1);
  });

  it.each(FOLLOWED)('follows a %s that names a Location, whose response has no body to read', async (status) => {
    const [response, outcome] = await Promise.all([
      browser.waitForResponse(`**/status/${String(status)}`),
      fetched(`/status/${String(status)}`),
    ]);
    expect(outcome).toEqual({ status: 200, path: '/landed', body: 'landed' });
    expect(landed).toBe(1);
    expect(response.status).toBe(status);
    await expect(response.text()).rejects.toThrow('Response body is unavailable for redirect responses');
  });

  it.each(NOT_FOLLOWED)('gives the page a %s that names a Location as its response, body and all', async (status) => {
    const [response, outcome] = await Promise.all([
      browser.waitForResponse(`**/status/${String(status)}`),
      fetched(`/status/${String(status)}`),
    ]);
    expect(outcome).toEqual({ status, path: `/status/${String(status)}`, body: `body of ${String(status)}` });
    expect(landed).toBe(0);
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe(`body of ${String(status)}`);
  });

  it('goes idle after every 3xx that ended a request, followed or not', async () => {
    // Requests are counted from the first idle wait on, so one comes before the fetches: Chromium listens to none until then.
    await browser.goto(page, { waitUntil: 'networkidle' });
    for (const status of [...FOLLOWED, ...NOT_FOLLOWED]) await fetched(`/status/${String(status)}`);
    expect(await browser.evaluate(() => fetch('/status/302', { redirect: 'manual' }).then((reply) => reply.type))).toBe('opaqueredirect');
    expect(landed).toBe(FOLLOWED.length);
    await browser.goto(page, { waitUntil: 'networkidle' });
    expect(await browser.title()).toBe('Statuses');
  });
});
