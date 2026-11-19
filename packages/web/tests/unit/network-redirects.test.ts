/**
 * The hops of a redirected request on an attempt's network, against a
 * scripted peer: which of them go on with the configured headers and with
 * a route's header overrides.
 */

import { describe, expect, it } from 'vitest';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';
import { network, request, route, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  describe('redirect hops and the configured headers', () => {
    /** The `x-preview` header and the route's own on a redirect hop's continue, or undefined when it went on untouched. */
    async function hop(fake: FakeBidi, id: string, url: string, count: number, carried: Record<string, string>): Promise<Record<string, string> | undefined> {
      const base = request(id, url);
      const headers = Object.entries({ Accept: '*/*', ...carried }).map(([name, value]): Network.Header => ({ name, value: { type: 'string', value } }));
      fake.emit('network.beforeRequestSent', { ...base, redirectCount: count, request: { ...base.request, headers } });
      await settle();
      await settle();
      const sent = fake.commands('network.continueRequest').at(-1)?.params;
      if (sent?.['request'] !== id) throw new Error(`no continue for ${id}`);
      const wire = sent['headers'] as { name: string; value: { value: string } }[] | undefined;
      return wire === undefined ? undefined : Object.fromEntries(wire.map((header) => [header.name, header.value.value]));
    }

    it('keeps the configured headers a request started with on every hop, wherever it goes, for a request no route matched', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params['headers']).toContainEqual({ name: 'x-preview', value: { type: 'string', value: 'token' } });
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token' })).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/again', 3, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
    });

    it('applies a route’s header overrides and the configured headers to every hop', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'X-Route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      await settle();
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token', 'x-route': 'routed' })).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
    });

    it.each(['POST', 'PUT'])('leaves the headers of a request body off every hop once a redirect turned the %s into a GET', async (method) => {
      const fake = new FakeBidi().on('goog:cdp.sendCommand', { result: { result: { postData: 'a=1', base64Encoded: false } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      const posted = request('r', `${SITE}/form`);
      const headers: Network.Header[] = [{ name: 'Accept', value: { type: 'string', value: '*/*' } }, { name: 'Content-Type', value: { type: 'string', value: 'application/x-www-form-urlencoded' } }];
      fake.emit('network.beforeRequestSent', { ...posted, request: { ...posted.request, method, bodySize: 3, headers } });
      await settle();
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params['headers']).toContainEqual({ name: 'content-type', value: { type: 'string', value: 'application/x-www-form-urlencoded' } });
      expect(await hop(fake, 'r', `${SITE}/done`, 1, {})).toEqual({ accept: '*/*', 'x-route': 'routed' });
      expect(await hop(fake, 'r', `${SITE}/again`, 2, {})).toEqual({ accept: '*/*', 'x-route': 'routed' });
    });

    it('keeps the configured headers on the hop a redirect a route fulfilled leads to, for a request that started at the app’s origin', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/moved', async (_held, decisions) => {
        await decisions.fulfill({ status: 302, headers: { location: `${SITE}/home` } });
      }));
      for (const [id, origin] of [['app', SITE], ['external', 'https://external.test']] as const) fake.emit('network.beforeRequestSent', request(id, `${origin}/moved`));
      await settle();
      await settle();
      expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['app', 'external']);
      expect(await hop(fake, 'app', `${SITE}/home`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'external', `${SITE}/home`, 1, {})).toBeUndefined();
    });

    it('sends nothing configured on a request that starts at another origin and redirects to the app’s', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
      expect(await hop(fake, 'r', `${SITE}/in`, 1, {})).toBeUndefined();
      expect(await hop(fake, 'r', 'https://external.test/out', 2, {})).toBeUndefined();
    });
  });
});
