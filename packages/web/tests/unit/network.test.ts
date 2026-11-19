/**
 * One attempt's network on the BiDi driver against a scripted peer:
 * intercepts scoped to the attempt's tabs, routes newest first with
 * fallback, site headers, failures on unawaited paths, a blank-served tab,
 * the `networkidle` window, and what a new user context starts over with.
 */

import { describe, expect, it } from 'vitest';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';
import { network, request, responded, route, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  it('holds requests only for the attempt’s tabs, and starts over on a new user context', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      { phases: ['beforeRequestSent'], contexts: ['tab-1'] },
      { phases: ['beforeRequestSent'], contexts: ['tab-1', 'tab-2'] },
    ]);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    await net.bind('user-2');
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept']).slice(1).toSorted()).toEqual(['intercept-1', 'intercept-2']);
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
  });

  it('runs the newest matching route first and passes a fallback to the next', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const order: string[] = [];
    await net.addRoute(route('**', async (_request, decisions) => {
      order.push('older');
      await decisions.fulfill({ status: 201, headers: {}, json: [{ name: 'Stubbed' }] });
    }));
    await net.addRoute(route('**/api/users', async (_request, decisions) => {
      order.push('newer');
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/api/users`));
    await settle();
    await settle();
    expect(order).toEqual(['newer', 'older']);
    expect(fake.commands('network.provideResponse')[0]?.params).toEqual({
      request: 'r1',
      statusCode: 201,
      reasonPhrase: 'Created',
      headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }, { name: 'content-length', value: { type: 'string', value: '20' } }],
      body: { type: 'base64', value: Buffer.from('[{"name":"Stubbed"}]').toString('base64') },
    });
  });

  it('lets an unmatched request through, adding the site headers only for the app’s site', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab');
    fake.emit('network.beforeRequestSent', request('site', `${SITE}/page`));
    fake.emit('network.beforeRequestSent', request('other', 'https://cdn.test/lib.js'));
    await settle();
    const continued = fake.commands('network.continueRequest').map((command) => command.params);
    expect(continued).toContainEqual({
      request: 'site',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    });
    expect(continued).toContainEqual({ request: 'other' });
  });

  it('releases a held request whose route failed and reports the failure, but not a request the page already dropped', async () => {
    const fake = new FakeBidi();
    const { net, failures, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async () => {
      throw new Error('handler exploded');
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    await settle();
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
    expect(failures.map((error) => error.message)).toEqual(['handler exploded']);
    await net.removeRoutes(() => true);
    fake.on('network.continueRequest', { error: 'no such request', message: 'gone' });
    fake.emit('network.beforeRequestSent', request('r2', `${SITE}/b`));
    await settle();
    await settle();
    expect(failures).toHaveLength(1);
  });

  it('refuses a URL rewrite on Firefox before the request goes, and fails the request', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    const errors: unknown[] = [];
    await net.bind('user-1');
    await net.addRoute(route(`${SITE}/a`, (_request, decisions) => decisions.continue({ url: `${SITE}/other` }).catch((cause: unknown) => {
      errors.push(cause);
      throw cause;
    })));
    await open('tab');
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    expect(errors).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' })]);
    expect(fake.commands('network.continueRequest')).toEqual([]);
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
  });

  it('waits for 500 ms with no request in flight before calling the network idle', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/slow`, []));
    const started = Date.now();
    let idle = false;
    const waiting = net.waitForIdle(AbortSignal.timeout(5_000)).then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idle).toBe(false);
    fake.emit('network.responseCompleted', responded('r1', `${SITE}/slow`, 200));
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(690);
  });

  it('on a browser of its own, holds every tab with one intercept and lets another user context’s requests go untouched', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true, ours: (context) => context !== 'foreign' });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['beforeRequestSent'] }]);
    fake.emit('network.beforeRequestSent', { ...request('popup', `${SITE}/popup`), context: 'popup' });
    fake.emit('network.beforeRequestSent', { ...request('foreign', `${SITE}/x`), context: 'foreign' });
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([
      { request: 'popup', headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }] },
      { request: 'foreign' },
    ]);
  });

  it('decides a request an intercept it since replaced still holds', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/held`, ['intercept-1']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['held']);
  });

  it('answers a blank-served tab’s documents before any route, and fails its other requests', async () => {
    const fake = new FakeBidi();
    const { net, contexts } = network(fake);
    await net.bind('user-1');
    let routed = 0;
    await net.addRoute(route('**', async () => {
      routed += 1;
    }));
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    fake.emit('network.beforeRequestSent', { ...request('img', `${SITE}/a.png`), context: 'scratch' });
    await settle();
    expect(routed).toBe(0);
    expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['doc']);
    expect(fake.commands('network.failRequest').map((command) => command.params['request'])).toEqual(['img']);
    await undo();
    fake.emit('network.beforeRequestSent', { ...request('later', `${SITE}/`), context: 'scratch', navigation: 'nav-2' });
    await settle();
    expect(routed).toBe(1);
  });

  it('never covers a tab that opened and closed in the same burst, nor one that closed while its intercept was added', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake, { headers: true });
    let intercepts = 0;
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).includes('popup')) {
        void close('popup');
        return { error: 'no such frame', message: 'gone' };
      }
      return { result: { intercept: `intercept-${(intercepts += 1)}` } };
    });
    await net.bind('user-1');
    void open('flash');
    await close('flash');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab');
    await open('popup');
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab'], ['tab', 'popup'], ['tab']]);
  });

  it('calls the network idle while a tab the app opened is still busy', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', { ...request('poll', `${SITE}/poll`, []), context: 'popup' });
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(5_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a removal the browser refused, and takes one it no longer has as done', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.dispose()).rejects.toThrow('refused');
    const again = new FakeBidi();
    const { net: second, open: secondOpen } = network(again, { headers: true, exclusive: true });
    again.on('network.addIntercept', { result: { intercept: 'global' } });
    await second.bind('user-1');
    await secondOpen('tab');
    again.on('network.removeIntercept', { error: 'no such intercept', message: 'gone' });
    await expect(second.dispose()).resolves.toBeUndefined();
  });

  it('removes a replacement intercept whose predecessor would not go, when the network is released', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab-1');
    fake.on('network.removeIntercept', (params) => (params['intercept'] === 'intercept-1' ? { error: 'unknown error', message: 'stuck' } : { result: {} }));
    await expect(open('tab-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toContain('intercept-2');
  });

  it('calls a new user context idle while a request of the one it replaced never finished', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await net.bind('user-2');
    await net.track();
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(2_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops counting the requests of a tab that closed without their events', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await close('tab');
    await net.waitForIdle(AbortSignal.timeout(2_000));
  });

  it.each([
    ['the subscription', 'session.subscribe'],
    ['the intercept', 'network.addIntercept'],
  ])('takes a route back when %s fails to install, and installs everything on the next try', async (_step, method) => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    let failed = false;
    let intercepts = 0;
    const answers: Record<string, (params: Record<string, unknown>) => { result: unknown }> = {
      'session.subscribe': () => ({ result: { subscription: 'subscription-1' } }),
      'network.addIntercept': () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }),
    };
    fake.on(method, (params) => {
      if (!failed) {
        failed = true;
        return { error: 'unknown error', message: 'install failed' };
      }
      return answers[method]!(params);
    });
    const handled: string[] = [];
    await expect(net.addRoute(route('**', async (_held, decisions) => {
      handled.push('first');
      await decisions.continue({});
    }))).rejects.toThrow('install failed');
    await net.addRoute(route('**', async (_held, decisions) => {
      handled.push('second');
      await decisions.fallback();
    }));
    expect(fake.commands('session.subscribe')).toHaveLength(method === 'session.subscribe' ? 2 : 1);
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      ...(method === 'network.addIntercept' ? [{ phases: ['beforeRequestSent'], contexts: ['tab'] }] : []),
      { phases: ['beforeRequestSent'], contexts: ['tab'] },
    ]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
    await settle();
    await settle();
    expect(handled).toEqual(['second']);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  it('keeps a removal that failed while rebinding, and tries it again on dispose', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    await expect(net.bind('user-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').filter((command) => command.params['intercept'] === 'global').length).toBeGreaterThanOrEqual(2);
  });

  it('binds nothing for an attempt that ended while the old user context was released', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    const added = fake.commands('network.addIntercept').length;
    const { held: whenLetGo, release: letGo } = gate();
    fake.on('network.removeIntercept', async () => {
      await whenLetGo;
      return { result: {} };
    });
    const rebound = net.bind('user-2');
    await settle();
    const disposed = net.dispose();
    letGo();
    await Promise.all([rebound, disposed]);
    expect(added).toBeGreaterThan(0);
    expect(fake.commands('network.addIntercept')).toHaveLength(added);
  });

  it('binds the new user context with what the attempt needs when a removal for the old one failed, and still reports the removal', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { headers: true, exclusive: true });
    await net.bind('user-1');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    await expect(net.bind('user-2')).rejects.toThrow('stuck');
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/page`, ['intercept-2']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([{
      request: 'held',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    }]);
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
    await expect(waiting).resolves.toMatchObject({ url: `${SITE}/r`, status: 200 });
  });

  it('reports what the new user context could not install over a removal for the old one that failed, which dispose tries again', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { headers: true, exclusive: true });
    await net.bind('user-1');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    fake.on('network.addIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.bind('user-2')).rejects.toThrow('refused');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-1']);
  });

  it('takes a blank-served tab back out when what serves it could not be installed', async () => {
    const fake = new FakeBidi();
    const { net, contexts } = network(fake);
    await net.bind('user-1');
    contexts.created('scratch', 'user-1', null);
    fake.on('network.addIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.serveBlank('scratch')).rejects.toThrow('refused');
    fake.on('network.addIntercept', { result: { intercept: 'intercept-1' } });
    let routed = 0;
    await net.addRoute(route('**', async (_held, decisions) => {
      routed += 1;
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    await settle();
    await settle();
    expect(routed).toBe(1);
    expect(fake.commands('network.provideResponse')).toEqual([]);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['doc']);
  });

  it('adds no intercept for a tab that closed while its intercept was added, and leaves no failure behind', async () => {
    const fake = new FakeBidi();
    const { net, failures, close, contexts } = network(fake, { headers: true });
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).length === 0) return { error: 'invalid argument', message: 'contexts must not be empty' };
      void close('tab');
      return { error: 'no such frame', message: 'gone' };
    });
    await net.bind('user-1');
    contexts.created('tab', 'user-1', null);
    await expect(net.addContext('tab')).resolves.toBeUndefined();
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab']]);
    expect(failures).toEqual([]);
  });

  it('removes a route in call order with an addition still queued behind a tab change', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    const { held, release } = gate();
    let intercepts = 0;
    fake.on('network.addIntercept', async () => {
      intercepts += 1;
      if (intercepts === 1) await held;
      return { result: { intercept: `intercept-${intercepts}` } };
    });
    await net.bind('user-1');
    const opening = open('tab');
    let ran = false;
    const removed = route('**', async (_held, decisions) => {
      ran = true;
      await decisions.fulfill({ status: 200, headers: {} });
    });
    const added = net.addRoute(removed);
    const unrouted = net.removeRoutes((one) => one === removed);
    await settle();
    release();
    await Promise.all([opening, added, unrouted]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/x`));
    await settle();
    await settle();
    expect(ran).toBe(false);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  it('lets interception go once the last route or blank-served tab no longer needs it', async () => {
    const fake = new FakeBidi();
    const { net, open, contexts } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => decisions.fallback()));
    expect(fake.commands('network.addIntercept')).toHaveLength(1);
    await net.removeRoutes(() => true);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    expect(fake.commands('network.addIntercept').at(-1)?.params).toEqual({ phases: ['beforeRequestSent'], contexts: ['tab', 'scratch'] });
    await undo();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-2']);
  });

  it('fulfills with the body’s own length, without the encoding headers of the response it amends', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => {
      await decisions.fulfill({ status: 200, headers: { 'Content-Encoding': 'gzip', 'Content-Length': '42', 'Content-Type': 'text/plain' }, body: 'decoded body' });
    }));
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/gz`));
    await settle();
    await settle();
    const sent = fake.commands('network.provideResponse')[0]?.params['headers'] as { name: string; value: { value: string } }[];
    expect(Object.fromEntries(sent.map((header) => [header.name, header.value.value]))).toEqual({ 'content-type': 'text/plain', 'content-length': '12' });
  });

  it('derives a fulfilled type only when the response names none, and lets contentType replace either', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const named = { 'Content-Type': 'text/plain' };
    const answers = [{ json: 1 }, { json: 1, headers: named }, { json: 1, headers: named, contentType: 'application/vnd.one+json' }];
    await net.addRoute(route('**', async (held, decisions) => {
      await decisions.fulfill({ status: 200, headers: {}, ...answers[Number(new URL(held.url).searchParams.get('answer'))] });
    }));
    for (const index of answers.keys()) fake.emit('network.beforeRequestSent', request(`r${index}`, `${SITE}/quote?answer=${index}`));
    await settle();
    await settle();
    const types = fake.commands('network.provideResponse').map((command) =>
      (command.params['headers'] as { name: string; value: { value: string } }[]).find((header) => header.name === 'content-type')?.value.value);
    expect(types).toEqual(['application/json', 'text/plain', 'application/vnd.one+json']);
  });
});
