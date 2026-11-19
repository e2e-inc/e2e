/**
 * The cookies of a response a route fetched itself reach the browser's jar
 * as the browser would have stored them: one with a `Domain` is read on
 * every host under that domain, one without on the response's host alone.
 * The app is served on `e2e.localhost` and a host under it, which both
 * browsers resolve to this machine themselves.
 */

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;
let port: string;

beforeAll(async () => {
  session = await startWebSession({ timeoutMs: 10_000 });
  port = new URL(session.origin).port;
  session.serve('/login', (_request, response) => {
    response.setHeader('Set-Cookie', ['shared=ok; Domain=e2e.localhost; Path=/', 'own=ok; Path=/']);
    response.end('<title>Signed in</title>');
  });
  session.serve('/read', '<title>Read</title>');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await session.close();
});

/** The cookies a page on `host` reads. */
async function cookiesOn(host: string): Promise<string[]> {
  await session.browser.goto(`http://${host}:${port}/read`);
  return (await session.browser.evaluate(() => document.cookie)).split('; ').toSorted();
}

it('stores a fetched Domain cookie for the hosts under the domain, and a cookie without one for its host alone', async () => {
  // The route's fetch leaves from this process, whose resolver need not know the name the browsers resolve themselves.
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => fetch(String(input).replace('//e2e.localhost:', '//127.0.0.1:'), init));
  await session.browser.route('**/login', async (route) => {
    const fetched = await route.fetch();
    await route.fulfill({ status: fetched.status, body: await fetched.text() });
  });

  await session.browser.goto(`http://e2e.localhost:${port}/login`);

  expect(await cookiesOn('e2e.localhost')).toEqual(['own=ok', 'shared=ok']);
  expect(await cookiesOn('sub.e2e.localhost')).toEqual(['shared=ok']);
});
