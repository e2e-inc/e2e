/**
 * `browser.setCookies` with a cookie Chromium itself refuses: the failure
 * names the cookie, where Chromium's own refusal arrives as an object turned
 * to text.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../../helpers/web-session.ts';

let session: WebSession;

beforeAll(async () => {
  session = await startWebSession();
  await session.setContent('<title>Cookies</title>');
});

afterAll(async () => {
  await session.close();
});

it('names a __Secure- cookie that is not secure, which Chromium refuses', async () => {
  await expect(session.browser.setCookies([{ name: '__Secure-token', value: '1', url: session.origin }])).rejects.toMatchObject({
    code: 'ENGINE_FAILURE',
    message: 'setCookies: storage.setCookie: unable to set cookie: the browser refused cookie "__Secure-token" for 127.0.0.1',
  });
});
