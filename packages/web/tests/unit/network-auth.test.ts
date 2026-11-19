/**
 * The basic-auth challenges of an attempt's network, against a scripted
 * peer: which it holds and answers once with the credentials, the hop each
 * browser names one after, and when a response wait gets the 401.
 */

import { describe, expect, it } from 'vitest';
import type { BrowserName } from '../../src/browsers.ts';
import { FakeBidi, responseData, settle, type FakeEvent } from '../helpers/bidi-fake.ts';
import { LOCATION, network, request, responded, route, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  it('answers a basic-auth challenge once, then lets a refused one through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toContainEqual({ phases: ['authRequired'], contexts: ['tab'] });
    const challenge = { ...request('r1', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) };
    fake.emit('network.authRequired', challenge);
    fake.emit('network.authRequired', challenge);
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([
      { request: 'r1', action: 'provideCredentials', credentials: { type: 'password', username: 'ada', password: 'secret' } },
      { request: 'r1', action: 'cancel' },
    ]);
  });

  it('holds challenges on Firefox without credentials and lets each through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['authRequired'], contexts: ['tab'] }]);
    fake.emit('network.authRequired', { ...request('r1', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([{ request: 'r1', action: 'cancel' }]);
  });

  it('holds no challenge on Chromium without credentials', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept')).toEqual([]);
  });

  describe('a basic-auth challenge on each hop of a request', () => {
    type Emitted = FakeEvent;
    const first = `${SITE}/private`;
    const second = 'http://other.test/private';
    /** Hop `count` of the request starts at `url`, held by no intercept. */
    const sent = (url: string, count: number): Emitted => ['network.beforeRequestSent', { ...request('r', url, []), redirectCount: count }];
    /** A held challenge that names `url` as hop `count`. */
    const challenged = (url: string, count: number): Emitted => ['network.authRequired', { ...request('r', url), redirectCount: count, response: responseData(url, 401) }];
    /** The hop at `url` ends in a redirect. */
    const redirected = (url: string): Emitted => ['network.responseCompleted', responded('r', url, 302, { headers: LOCATION })];

    /**
     * Chromium announces each hop once and names the hop a challenge came
     * from. Firefox announces a hop again when it resends it with the
     * credentials, and names every challenge after the hop the request
     * started at.
     */
    it.each<[BrowserName, Emitted[]]>([
      ['chromium', [sent(first, 0), challenged(first, 0), redirected(first), sent(second, 1), challenged(second, 1), challenged(second, 1)]],
      ['firefox', [sent(first, 0), challenged(first, 0), sent(first, 0), redirected(first), sent(second, 1), challenged(first, 0), sent(second, 1), challenged(first, 0)]],
    ])('answers one from each credential origin a redirect leads through, and lets a second one on a hop through as the 401, as %s reports them', async (browser, events) => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' }, credentialOrigins: [new URL(second).origin], browser });
      await net.bind('user-1');
      await open('tab');
      fake.emitAll(events);
      await settle();
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials', 'provideCredentials', 'cancel']);
    });
  });

  it.each([
    ['its challenge was answered with', true],
    ['the browser holds for the realm, which raise no challenge', false],
  ])('sends a hop on as it is, past the routes and the redirect headers, when Firefox announces it again with the credentials %s', async (_name, challenged) => {
    const fake = new FakeBidi();
    const second = 'http://other.test/private';
    const { net, open } = network(fake, { headers: true, credentials: { username: 'ada', password: 'secret' }, credentialOrigins: [new URL(second).origin], browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    let routed = 0;
    await net.addRoute(route('**', async (_held, decisions) => {
      routed += 1;
      await decisions.continue({ headers: { 'x-route': 'routed' } });
    }));
    /** Hop `count` of the request is announced at `url`, held, and what it was continued with. */
    const announced = async (url: string, count: number): Promise<Record<string, unknown> | undefined> => {
      fake.emit('network.beforeRequestSent', { ...request('r', url), redirectCount: count });
      await settle();
      await settle();
      return fake.commands('network.continueRequest').at(-1)?.params;
    };
    /** Hop `count` is announced again at `url`, after its challenge when one is raised, and what it was continued with. */
    const resent = (url: string, count: number): Promise<Record<string, unknown> | undefined> => {
      if (challenged) fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      return announced(url, count);
    };
    const overridden = { request: 'r', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }]) };
    expect(await announced(`${SITE}/private`, 0)).toEqual(overridden);
    expect(await resent(`${SITE}/private`, 0)).toEqual({ request: 'r' });
    fake.emit('network.responseCompleted', responded('r', `${SITE}/private`, 302, { headers: LOCATION }));
    expect(await announced(second, 1)).toEqual(overridden);
    expect(await resent(second, 1)).toEqual({ request: 'r' });
    expect(routed).toBe(1);
    expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(challenged ? ['provideCredentials', 'provideCredentials'] : []);
  });

  describe('a response wait on a request whose basic-auth challenge is held', () => {
    type Emitted = FakeEvent;
    const url = `${SITE}/private`;
    /** The request's hop starts, held by no intercept. */
    const sent: Emitted = ['network.beforeRequestSent', request('r', url, [])];
    /** A held challenge of the hop. */
    const challenged: Emitted = ['network.authRequired', { ...request('r', url), response: responseData(url, 401) }];
    /** The hop's response as `event` reports it: a 401 names a `scheme` challenge. */
    const response = (event: 'responseStarted' | 'responseCompleted', status: number, scheme = 'Basic'): Emitted =>
      [`network.${event}`, responded('r', url, status, status === 401 ? { authChallenges: [{ scheme, realm: 'preview' }] } : {})];

    /** A wait for the request's response on `browser`, with `credentials` configured or not, and the status it resolved with so far. */
    async function waitOn(browser: BrowserName, credentials: boolean) {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'the page' } } });
      const { net, open } = network(fake, { ...(credentials ? { credentials: { username: 'ada', password: 'secret' } } : {}), browser });
      await net.bind('user-1');
      await open('tab');
      const resolved: number[] = [];
      const waiting = net.waitForResponse((matched) => matched === url, AbortSignal.timeout(5_000));
      void waiting.then((matched) => resolved.push(matched.status), () => undefined);
      await settle();
      /** Emits `events` and lets the wait settle on them. */
      const emit = async (...events: Emitted[]): Promise<void> => {
        fake.emitAll(events);
        await settle();
      };
      return { fake, waiting, resolved, emit };
    }

    it('keeps the 401 of a challenge it answers with credentials from the wait, which resolves on the response they got, as Firefox reports them', async () => {
      const { fake, waiting, resolved, emit } = await waitOn('firefox', true);
      await emit(sent, response('responseStarted', 401), challenged, sent);
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials']);
      expect(resolved).toEqual([]);
      await emit(response('responseStarted', 200), response('responseCompleted', 200));
      expect(resolved).toEqual([200]);
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it.each<[string, boolean, Emitted[]]>([
      ['the credentials were refused', true, [sent, response('responseStarted', 401), challenged, sent, response('responseStarted', 401)]],
      ['there are no credentials', false, [sent, response('responseStarted', 401)]],
    ])('hands the wait the 401 once its challenge goes through because %s, as Firefox reports them', async (_name, credentials, events) => {
      const { fake, waiting, resolved, emit } = await waitOn('firefox', credentials);
      await emit(...events);
      expect(resolved).toEqual([]);
      await emit(challenged);
      expect(fake.commands('network.continueWithAuth').at(-1)?.params['action']).toBe('cancel');
      expect(resolved).toEqual([401]);
      await emit(response('responseCompleted', 401));
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it('hands the wait a challenge the browser raises to nobody once its response completed', async () => {
      const { waiting, resolved, emit } = await waitOn('firefox', true);
      await emit(sent, response('responseStarted', 401, 'Bearer'));
      expect(resolved).toEqual([]);
      await emit(response('responseCompleted', 401, 'Bearer'));
      expect(resolved).toEqual([401]);
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it.each<[string, boolean, Emitted[]]>([
      ['no challenge is held', false, []],
      ['its challenge already went through', true, [challenged, challenged]],
    ])('hands the wait a 401 on its headers where %s, as Chromium reports them', async (_name, credentials, challenges) => {
      const { resolved, emit } = await waitOn('chromium', credentials);
      await emit(sent, ...challenges, response('responseStarted', 401));
      expect(resolved).toEqual([401]);
    });

    it('leaves a wait that ended with its match still parked out of the request', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      const ending = new AbortController();
      const waiting = net.waitForResponse(() => true, ending.signal);
      await settle();
      fake.emitAll([sent, response('responseStarted', 401)]);
      ending.abort();
      await expect(waiting).rejects.toThrow();
      fake.emitAll([challenged, response('responseCompleted', 401)]);
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'r' }]);
    });
  });
});
