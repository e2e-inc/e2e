/**
 * A page that loads a web font while its requests are held: the page
 * finishes loading with the font fetched from the server once, whether a
 * route matches the font or not, and the request that reaches the server
 * carries what it was continued with (a route's headers, the configured
 * headers). Chromium asks its HTTP cache alone for a font first and starts
 * the load over on a miss, which pauses the one request twice.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

/** A 288-byte WOFF2 font named Repro with one glyph, a box for `A`. */
const FONT = Buffer.from(
  'd09GMgABAAAAAAEgAAoAAAAAAmwAAADYAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAocNgE2AiQDBgsGAAQgBVoHJhvJAUCfBXajcyuuhEWSzKQHb0I8//6ynfv+m1C7q8I2R9ajUBM/CONWoVAO4kGvbm6am6EaigiK5aAM3iA8kPTyH7hVJ8cnOogfD6otsAjbovCesoZikxXlIT3RqDmZNDHA2xqs2GDzyrj1DQC4BYWBc0Nwrt2itWC14cMWAAUaQWMCNCC9Nx30sm4NBOHl5v0pjvzfHuMXfu6+4myB/NUaQ4Fw+aOalcoCAEjNYCEoLaAAANCeBcSEgLJlMqR3xK79bsqhy4/P476JKuDaoUXE+J5EKlr8CAAA',
  'base64',
);

const PAGE = `<!doctype html><title>Font</title>
<style>
@font-face { font-family: Repro; src: url("/font.woff2") format("woff2"); }
body { font-family: Repro, sans-serif; }
</style>
<h1>Hello font A</h1>`;

/** The page as it reads once it and its font loaded. */
const LOADED = { heading: 'Hello font A', readyState: 'complete', fonts: 'loaded', loaded: true };

/** Serves the font page and its font on `session`; returns the headers of each font request the server got, in order. */
function serveFontPage(session: WebSession): IncomingHttpHeaders[] {
  const requests: IncomingHttpHeaders[] = [];
  session.serve('/font-page', PAGE);
  session.serve('/font.woff2', (request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { 'content-type': 'font/woff2', 'content-length': String(FONT.length) });
    response.end(FONT);
  });
  return requests;
}

/** What the page reports of its load and of the font it asked for, once its fonts settled. */
const loadState = (browser: Browser): Promise<typeof LOADED> => browser.evaluate(async () => {
  await document.fonts.ready;
  return {
    heading: document.querySelector('h1')?.textContent ?? '',
    readyState: document.readyState,
    fonts: document.fonts.status,
    loaded: document.fonts.check('16px Repro', 'A'),
  };
});

describe('a web font under a route', () => {
  let session: WebSession;
  let browser: Browser;
  let fontRequests: IncomingHttpHeaders[];

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    fontRequests = serveFontPage(session);
  });

  beforeEach(async () => {
    fontRequests.length = 0;
    await session.startAttempt();
    browser = session.browser;
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  it('finishes loading a page whose font no route matches', async () => {
    await browser.route('**/api/x', (route) => route.fulfill({ body: 'mocked' }));
    await browser.goto('/font-page');
    expect(await loadState(browser)).toEqual(LOADED);
    expect(fontRequests).toHaveLength(1);
  });

  it('hands the font request to a route that matches it once, and sends it with the route\'s headers', async () => {
    const seen: string[] = [];
    await browser.route('**/font.woff2', async (route) => {
      seen.push(route.request.url);
      await route.continue({ headers: { ...route.request.headers, 'x-route': 'continued' } });
    });
    await browser.goto('/font-page');
    expect(await loadState(browser)).toEqual(LOADED);
    expect(seen).toEqual([`${session.origin}/font.woff2`]);
    expect(fontRequests.map((headers) => headers['x-route'])).toEqual(['continued']);
  });

  it('answers the font from a route without asking the server', async () => {
    await browser.route('**/font.woff2', (route) => route.fulfill({ body: FONT, contentType: 'font/woff2' }));
    await browser.goto('/font-page');
    expect(await loadState(browser)).toEqual(LOADED);
    expect(fontRequests).toEqual([]);
  });

  it('fails the font a route aborts and still finishes loading the page', async () => {
    await browser.route('**/font.woff2', (route) => route.abort());
    await browser.goto('/font-page');
    expect(await loadState(browser)).toEqual({ ...LOADED, loaded: false });
    expect(fontRequests).toEqual([]);
  });
});

describe('a web font under configured headers', () => {
  let session: WebSession;
  let fontRequests: IncomingHttpHeaders[];

  beforeAll(async () => {
    session = await startWebSession({ web: { headers: { 'x-gate': 'open-sesame' } }, timeoutMs: 10_000 });
    fontRequests = serveFontPage(session);
  });

  afterAll(async () => {
    await session.close();
  });

  it('sends the font request with the configured headers', async () => {
    await session.browser.goto('/font-page');
    expect(await loadState(session.browser)).toEqual(LOADED);
    expect(fontRequests.map((headers) => headers['x-gate'])).toEqual(['open-sesame']);
  });
});
