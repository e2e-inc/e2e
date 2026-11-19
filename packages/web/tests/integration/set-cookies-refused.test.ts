/**
 * `browser.setCookies` with a name or value no browser stores, against a
 * real browser: the cookie is refused by its name before anything is sent.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

let session: WebSession;

beforeAll(async () => {
  session = await startWebSession();
  await session.setContent('<title>Cookies</title>');
});

afterAll(async () => {
  await session.close();
});

it('refuses a value no browser stores by the name of the cookie, and stores nothing', async () => {
  await expect(session.browser.setCookies([{ name: 'k', value: 'v w;', url: session.origin }])).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
    message: 'browser.setCookies: the value of cookie "k" is one no browser stores: it holds a ";" or a control character, or starts or ends with a space',
  });
  expect(await session.browser.cookies()).toEqual([]);
});
