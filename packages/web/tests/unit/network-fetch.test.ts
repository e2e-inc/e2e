/**
 * A route's own fetch of the request it holds, from an attempt's network
 * over a scripted peer to an upstream server: what it sends, the cookies
 * it stores, the challenge it answers, and what ends it.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttemptNetwork } from '../../src/driver/network.ts';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';
import { network, request, route, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  describe('a route’s fetch of the request it holds', () => {
    /** What the upstream server received, in order. */
    const received: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
    /** Runs when the server gets a request for `/hang`, which it never answers. */
    let hang: () => void = () => undefined;
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((incoming, response) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => (body += chunk.toString()));
        incoming.on('end', () => {
          received.push({ url: incoming.url, method: incoming.method, headers: incoming.headers, body });
          if (incoming.url === '/hang') {
            hang();
            return;
          }
          if (incoming.url === '/private' && incoming.headers.authorization === undefined) {
            response.writeHead(401, { 'www-authenticate': 'Basic realm="preview"' }).end();
            return;
          }
          response.setHeader('set-cookie', ['sid=fresh; Path=/; HttpOnly', 'theme=dark']);
          response.writeHead(200, { 'content-type': 'text/plain' }).end('upstream');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /**
     * A network whose one route fetches the request it holds, then fulfills
     * it; resolves with what the fetch gave the route once `held`, a
     * `beforeRequestSent` event, went through it. `before` runs between the
     * request being held and the fetch.
     */
    async function fetched(fake: FakeBidi, options: Parameters<typeof network>[1], held: (origin: string) => Network.BeforeRequestSentParameters, before: (net: AttemptNetwork) => Promise<void> = async () => undefined) {
      received.length = 0;
      const created = network(fake, { site: origin, ...options });
      await created.net.bind('user-1');
      await created.open('tab');
      const outcome = new Promise<{ status?: number; headers?: Readonly<Record<string, string>>; body?: string; failure?: unknown }>((resolve) => {
        void created.net.addRoute(route('**', async (_request, decisions) => {
          await before(created.net);
          try {
            const response = await decisions.fetch({ signal: new AbortController().signal, timeoutMs: 5_000 });
            resolve({ status: response.status, headers: response.headers, body: (await response.body()).toString() });
          } catch (failure) {
            resolve({ failure });
          }
          await decisions.fulfill({ status: 204, headers: {} });
        })).then(() => fake.emit('network.beforeRequestSent', held(origin)));
      });
      return { ...created, outcome: await outcome };
    }

    it('sends the request as the browser sent it, with its cookies, its body, and the configured headers', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { outcome } = await fetched(fake, { headers: true, browser: 'firefox' }, (site) => {
        const posted = request('post', `${site}/form`);
        const cookie = (name: string, value: Network.BytesValue): Network.Cookie => ({ name, value, domain: new URL(site).hostname, path: '/', size: 0, httpOnly: false, secure: false, sameSite: 'lax' });
        const cookies = [cookie('sid', { type: 'string', value: 'old' }), cookie('lang', { type: 'base64', value: Buffer.from('en').toString('base64') })];
        return { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3, cookies } };
      });
      expect(outcome).toMatchObject({ status: 200, body: 'upstream', headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=fresh; Path=/; HttpOnly\ntheme=dark' } });
      expect(received).toEqual([{ url: '/form', method: 'POST', headers: expect.objectContaining({ accept: '*/*', cookie: 'sid=old; lang=en', 'x-preview': 'token' }), body: 'a=1' }]);
    });

    it('stores the cookies the response sets in the request’s user context', async () => {
      const fake = new FakeBidi();
      await fetched(fake, {}, (site) => request('r', `${site}/account/settings`));
      expect(fake.commands('storage.setCookie').map((command) => command.params)).toEqual([
        { cookie: { name: 'sid', value: { type: 'string', value: 'fresh' }, domain: '127.0.0.1', path: '/', httpOnly: true }, partition: { type: 'storageKey', userContext: 'user-1' } },
        { cookie: { name: 'theme', value: { type: 'string', value: 'dark' }, domain: '127.0.0.1', path: '/account' }, partition: { type: 'storageKey', userContext: 'user-1' } },
      ]);
    });

    it('stores no cookie of a user context the attempt has since replaced', async () => {
      const fake = new FakeBidi();
      const { outcome, failures } = await fetched(fake, {}, (site) => request('r', `${site}/`), (net) => net.bind('user-2'));
      expect(outcome).toMatchObject({ status: 200, body: 'upstream' });
      expect(fake.commands('storage.setCookie')).toEqual([]);
      expect(failures).toEqual([]);
    });

    it('answers a Basic challenge from a credential origin once, and from no other', async () => {
      const credentials = { username: 'ada', password: 'secret' };
      const answered = await fetched(new FakeBidi(), { credentials }, (site) => request('r', `${site}/private`));
      expect(answered.outcome.status).toBe(200);
      expect(received.map((one) => one.headers.authorization)).toEqual([undefined, `Basic ${Buffer.from('ada:secret').toString('base64')}`]);
      const elsewhere = await fetched(new FakeBidi(), { credentials, site: SITE }, (site) => request('r', `${site}/private`));
      expect([elsewhere.outcome.status, received]).toEqual([401, [expect.anything()]]);
    });

    it('refuses to fetch a request whose body the browser did not keep, rather than send none', async () => {
      const fake = new FakeBidi().on('network.getData', () => ({ error: 'no such network data', message: 'evicted' }));
      const { outcome } = await fetched(fake, { browser: 'firefox' }, (site) => {
        const posted = request('post', `${site}/upload`);
        return { ...posted, request: { ...posted.request, method: 'POST', bodySize: 30_000_000 } };
      });
      expect(outcome.failure).toMatchObject({ code: 'ACTION_FAILED', message: 'route.fetch: the browser kept none of the request body (too large or streamed), so the request cannot be replayed' });
      expect(received).toEqual([]);
    });

    it('sends the form of a held navigation that posts one', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { outcome } = await fetched(fake, { browser: 'firefox' }, (site) => {
        const posted = request('post', `${site}/form`);
        return { ...posted, navigation: 'nav-1', request: { ...posted.request, method: 'POST', bodySize: 3 } };
      });
      expect(outcome).toMatchObject({ status: 200, body: 'upstream' });
      expect(received).toEqual([expect.objectContaining({ url: '/form', method: 'POST', body: 'a=1' })]);
    });

    it('ends a fetch still waiting for its response when the attempt closes', async () => {
      const fake = new FakeBidi();
      const { net, open, lifetime } = network(fake, { site: origin });
      await net.bind('user-1');
      await open('tab');
      const { held: failure, release: failed } = gate<unknown>();
      await net.addRoute(route('**', async (_request, decisions) => {
        await decisions.fetch({ signal: new AbortController().signal, timeoutMs: 5_000 }).catch(failed);
        await decisions.abort();
      }));
      hang = () => lifetime.abort();
      fake.emit('network.beforeRequestSent', request('r', `${origin}/hang`));
      expect(await failure).toMatchObject({ name: 'AbortError' });
    });
  });
});
