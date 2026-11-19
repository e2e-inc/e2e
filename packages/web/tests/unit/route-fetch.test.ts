/**
 * A route's own fetch of the request it holds, without a browser: the
 * request sent again from Node to a local server, a Basic challenge answered
 * once, the response as the route reads it, and `Set-Cookie` headers as
 * cookies to store.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchedResponse, replayRequest, setCookieOf } from '../../src/driver/route-fetch.ts';

describe('replayRequest', () => {
  /** What the server received, in order. */
  const received: { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('latin1') });
        if (request.url === '/moved') {
          response.writeHead(302, { location: '/elsewhere' }).end();
        } else if (request.url === '/private' && request.headers.authorization !== `Basic ${Buffer.from('ada:secret').toString('base64')}`) {
          response.writeHead(401, { 'www-authenticate': 'Basic realm="preview"' }).end('denied');
        } else {
          response.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2']);
          response.writeHead(200, { 'content-type': 'text/plain' }).end('upstream');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Sends one request to `path` and returns the response with what the server received for it. */
  async function replay(path: string, credentials?: { username: string; password: string }, body?: Buffer) {
    received.length = 0;
    const headers = { accept: '*/*', cookie: 'sid=1', 'x-gate': 'open' };
    const fetched = await replayRequest({ url: `${origin}${path}`, method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body }) }, credentials, AbortSignal.timeout(5_000));
    return { fetched, received: [...received] };
  }

  it('sends the method, headers, and body bytes as given, and does not follow a redirect', async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const posted = await replay('/echo', undefined, bytes);
    expect(posted.received).toHaveLength(1);
    expect(posted.received[0]).toMatchObject({ method: 'POST', url: '/echo', headers: { cookie: 'sid=1', 'x-gate': 'open' }, body: bytes.toString('latin1') });
    const moved = await replay('/moved');
    expect([moved.fetched.status, moved.fetched.headers.get('location'), moved.received.map((request) => request.url)]).toEqual([302, '/elsewhere', ['/moved']]);
  });

  it('answers a Basic challenge once with the credentials, and lets a refused one through as the 401', async () => {
    const answered = await replay('/private', { username: 'ada', password: 'secret' });
    expect([answered.fetched.status, answered.received.map((request) => request.headers.authorization !== undefined)]).toEqual([200, [false, true]]);
    const refused = await replay('/private', { username: 'ada', password: 'wrong' });
    expect([refused.fetched.status, refused.received]).toEqual([401, [expect.anything(), expect.anything()]]);
    const none = await replay('/private');
    expect([none.fetched.status, none.received]).toEqual([401, [expect.anything()]]);
  });

  it('reports the response with its set-cookie values joined by a newline, and reads its body once', async () => {
    const { fetched } = await replay('/echo');
    const response = fetchedResponse(`${origin}/echo`, fetched);
    expect(response).toMatchObject({ url: `${origin}/echo`, status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1; HttpOnly\nb=2' } });
    const [first, second] = await Promise.all([response.body(), response.body()]);
    expect([first.toString(), second]).toEqual(['upstream', first]);
  });
});

describe('setCookieOf', () => {
  const url = new URL('https://app.test/account/settings');

  it('reads the attributes, with Max-Age over Expires and the default path from the URL', () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = setCookieOf('sid=abc=1; Domain=.app.test; Secure; HttpOnly; SameSite=Lax; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=60', url);
    expect(cookie).toMatchObject({ name: 'sid', value: { type: 'string', value: 'abc=1' }, domain: '.app.test', path: '/account', secure: true, httpOnly: true, sameSite: 'lax' });
    expect(cookie?.expiry).toBeGreaterThanOrEqual(now + 60);
    expect(setCookieOf('theme=dark; Path=/x', new URL('https://app.test/'))).toEqual({ name: 'theme', value: { type: 'string', value: 'dark' }, domain: 'app.test', path: '/x' });
  });

  it('refuses a Domain the response host does not belong to, and keeps a parent domain', () => {
    expect(setCookieOf('sid=x; Domain=app.test', new URL('https://other.test/'))).toBeUndefined();
    expect(setCookieOf('sid=x; Domain=evil-app.test', new URL('https://app.test/'))).toBeUndefined();
    expect(setCookieOf('sid=x; Domain=.app.test', new URL('https://api.app.test/'))).toMatchObject({ domain: '.app.test' });
  });

  it('stores a cookie with a Domain for every host under it, and one without for its host alone', () => {
    expect(setCookieOf('sid=x; Domain=app.test', new URL('https://app.test/'))).toMatchObject({ domain: '.app.test' });
    expect(setCookieOf('sid=x; Domain=APP.test', new URL('https://api.app.test/'))).toMatchObject({ domain: '.app.test' });
    expect(setCookieOf('sid=x; Domain=', new URL('https://app.test/'))).toMatchObject({ domain: 'app.test' });
    expect(setCookieOf('sid=x', new URL('https://app.test/'))).toMatchObject({ domain: 'app.test' });
  });

  it('skips a header with no name', () => {
    expect(setCookieOf('=orphan', url)).toBeUndefined();
    expect(setCookieOf('novalue', url)).toBeUndefined();
  });
});
