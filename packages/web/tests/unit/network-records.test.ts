/**
 * What an attempt's network keeps of a request, against a scripted peer,
 * and when it lets go of it: the basic-auth answer and the redirect policy
 * of its hops, a fulfilled body, and the bodies its collectors hold.
 */

import { describe, expect, it } from 'vitest';
import { FakeBidi, responseData, settle } from '../helpers/bidi-fake.ts';
import { LOCATION, network, request, responded, route, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  describe('what a request leaves behind once it is over', () => {
    it('forgets a basic-auth answer once its tab closed mid-redirect, so a new challenge gets the credentials', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/private`, []));
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      fake.emit('network.responseCompleted', responded('r', `${SITE}/private`, 302, { headers: LOCATION }));
      net.retire('tab');
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      await settle();
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials', 'provideCredentials']);
    });

    it('forgets a redirect policy once its tab closed mid-redirect', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      await settle();
      fake.emit('network.responseCompleted', responded('r', 'https://external.test/start', 302, { headers: LOCATION }));
      net.retire('tab');
      fake.emit('network.beforeRequestSent', { ...request('r', 'https://external.test/again'), redirectCount: 1 });
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
    });

    it.each([
      ['a 304', 304, []],
      ['a 304 that names a Location', 304, LOCATION],
      ['a redirect status with no Location', 302, []],
    ])('releases %s as a last hop, and keeps a redirect hop for its next one', async (_name, status, headers) => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      const start = 'https://external.test/start';
      for (const id of ['last', 'hop']) fake.emit('network.beforeRequestSent', request(id, start));
      await settle();
      await settle();
      fake.emit('network.responseCompleted', responded('last', start, status, { headers }));
      fake.emit('network.responseCompleted', responded('hop', start, 302, { headers: LOCATION }));
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'last' }]);
      for (const id of ['last', 'hop']) fake.emit('network.beforeRequestSent', { ...request(id, 'https://external.test/next'), redirectCount: 1 });
      await settle();
      const [last, hop] = fake.commands('network.continueRequest').slice(-2).map((command) => command.params);
      expect(last).toEqual({ request: 'last' });
      expect(hop).toMatchObject({ request: 'hop', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }]) });
    });

    it('keeps a fulfilled body only until its response completed', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'from the collector' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (_held, decisions) => {
        await decisions.fulfill({ status: 200, headers: {}, body: 'fulfilled' });
      }));
      const response = (id: string) => responded(id, `${SITE}/a`, 200);
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
      await settle();
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await first).body().then(String)).resolves.toBe('fulfilled');
      await net.removeRoutes(() => true);
      const again = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await again).body().then(String)).resolves.toBe('from the collector');
    });

    it.each([
      ['reports the redirect’s response, as Chromium does', true],
      ['reports none for the redirect, as Firefox does', false],
    ])('keeps the body of a fulfilled redirect off the hop it led to, on a browser that %s', async (_name, reported) => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'landed' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (_held, decisions) => {
        await decisions.fulfill({ status: 302, headers: { location: '/next' }, body: 'moved' });
      }));
      /** Request `id` is fulfilled with the redirect and followed to the page it names. */
      const follow = async (id: string): Promise<void> => {
        const moved = responded(id, `${SITE}/moved`, 302, { headers: LOCATION });
        const landed = { ...responded(id, `${SITE}/next`, 200), redirectCount: 1 };
        fake.emit('network.beforeRequestSent', request(id, `${SITE}/moved`));
        await settle();
        await settle();
        if (reported) for (const event of ['network.responseStarted', 'network.responseCompleted'] as const) fake.emit(event, moved);
        fake.emit('network.beforeRequestSent', { ...request(id, `${SITE}/next`), redirectCount: 1 });
        fake.emit('network.responseStarted', landed);
        fake.emit('network.responseCompleted', landed);
        await settle();
      };
      const waiting = net.waitForResponse((url) => url.endsWith('/next'), AbortSignal.timeout(5_000));
      await settle();
      await follow('read');
      await expect((await waiting).body().then(String)).resolves.toBe('landed');
      await follow('unread');
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'unread' }]);
    });
  });

  describe('collected bodies', () => {
    it('lets the collector go of a response body no wait matched, and of a body a wait read', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'read' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const done = (id: string, status = 200) => responded(id, `${SITE}/${id}`, status, { headers: status === 302 ? LOCATION : [] });
      fake.emit('network.responseCompleted', done('asset'));
      fake.emit('network.responseCompleted', done('hop', 302));
      const waiting = net.waitForResponse((url) => url.endsWith('/waited'), AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', done('waited'));
      fake.emit('network.responseCompleted', done('waited'));
      const response = await waiting;
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'asset' }]);
      await expect(Promise.all([response.body(), response.body()]).then((bodies) => bodies.map(String))).resolves.toEqual(['read', 'read']);
      expect(fake.commands('network.getData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'waited', disown: true }]);
    });

    it('reads a body two waits matched once, for both', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'shared' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      const event = responded('r', `${SITE}/r`, 200);
      fake.emit('network.responseStarted', event);
      fake.emit('network.responseCompleted', event);
      const bodies = await Promise.all([first, second].map(async (wait) => String(await (await wait).body())));
      expect(bodies).toEqual(['shared', 'shared']);
      expect(fake.commands('network.getData')).toHaveLength(1);
      expect(fake.commands('network.disownData')).toEqual([]);
    });

    it('lets the request collector go of a held request’s body once the request is over', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/api', async (_held, decisions) => decisions.continue({})));
      const posted = request('post', `${SITE}/form`);
      const post = { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3 } };
      fake.emit('network.beforeRequestSent', post);
      await settle();
      fake.emit('network.responseCompleted', { ...post, response: responseData(`${SITE}/form`, 200) });
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual({ dataType: 'request', collector: 'collector-1', request: 'post' });
    });

    it('lets go of a posted body the server answered with a redirect to a page fetched without one', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/api', async (_held, decisions) => decisions.continue({})));
      const posted = request('post', `${SITE}/form`);
      const post = { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3 } };
      fake.emit('network.beforeRequestSent', post);
      await settle();
      fake.emit('network.responseCompleted', { ...post, response: responseData(`${SITE}/form`, 303, { headers: [{ name: 'Location', value: { type: 'string', value: '/done' } }] }) });
      const followed = { ...request('post', `${SITE}/done`), redirectCount: 1 };
      fake.emit('network.beforeRequestSent', followed);
      await settle();
      fake.emit('network.responseCompleted', { ...followed, response: responseData(`${SITE}/done`, 200) });
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual({ dataType: 'request', collector: 'collector-1', request: 'post' });
    });
  });
});
