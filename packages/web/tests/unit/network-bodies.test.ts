/**
 * Where an attempt's network reads the body of a request a route holds,
 * against a scripted peer: over CDP on Chromium, where the mapper's request
 * collector reports bytes as text, and from BiDi's request collector on
 * Firefox, which the first route adds and the last removes.
 */

import { describe, expect, it } from 'vitest';
import type { BrowserName } from '../../src/browsers.ts';
import { NO_POST_DATA, UNREPORTED_POST_DATA } from '../../src/driver/cdp-fixups.ts';
import type { InterceptedRequest, RouteDecisions } from '../../src/driver/network-decisions.ts';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, requestData, settle, type Reply } from '../helpers/bidi-fake.ts';
import { network, request as requestSent, route, SITE } from '../helpers/network-fake.ts';

/** A `beforeRequestSent` event of request `id` from `tab`, held by every intercept the fake handed out, with `fields` over its request. */
function held(id: string, fields: Partial<Network.RequestData>, navigation: string | null = null): Network.BeforeRequestSentParameters {
  const url = `${SITE}/upload`;
  return { ...requestSent(id, url, ['intercept-1', 'intercept-2']), navigation, request: requestData(id, url, { method: 'POST', ...fields }) };
}

/** What a route was handed for the one request `event` announces, and what its `fetch` did, when asked to: the response's status, or the failure. */
async function routed(fake: FakeBidi, browser: BrowserName, event: Network.BeforeRequestSentParameters, replay = false): Promise<{ request: InterceptedRequest | undefined; fetch: unknown; failures: Error[] }> {
  const { net, failures, open } = network(fake, { browser });
  await net.bind('user-1');
  await open('tab');
  let request: InterceptedRequest | undefined;
  let fetch: unknown;
  await net.addRoute(route('**', async (intercepted, decisions: RouteDecisions) => {
    request = intercepted;
    if (replay) fetch = await decisions.fetch({ signal: new AbortController().signal, timeoutMs: 1_000 }).then((response) => response.status, (failure: unknown) => failure);
    await decisions.fulfill({ status: 200, headers: {} });
  }));
  fake.emit('network.beforeRequestSent', event);
  await settle();
  await settle();
  return { request, fetch, failures };
}

/** The CDP commands the driver sent through the mapper, as `[session, method, params]`. */
const cdpCommands = (fake: FakeBidi): unknown[] => fake.commands('goog:cdp.sendCommand').map((command) => [command.params['session'], command.params['method'], command.params['params']]);

/** A fake whose CDP `Network.getRequestPostData` answers `reply`. */
const answering = (reply: Reply): FakeBidi => new FakeBidi().on('goog:cdp.sendCommand', reply);

describe('the body of a held request on Chromium', () => {
  it('reads it over CDP on the session of the request\'s context, and adds no request collector', async () => {
    const fake = answering({ result: { result: { postData: 'aGVsbG8=', base64Encoded: true } } });
    const { request, failures } = await routed(fake, 'chromium', held('post', {}));
    expect(request?.postData).toBe('hello');
    expect(cdpCommands(fake)).toEqual([['session-of-tab', 'Network.getRequestPostData', { requestId: 'post' }]]);
    expect(fake.commands('network.addDataCollector').map((command) => command.params['dataTypes'])).toEqual([['response']]);
    expect(fake.commands('network.getData')).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('takes an answer that is not base64 as text, and bytes that are no text as text with U+FFFD', async () => {
    const text = await routed(answering({ result: { result: { postData: 'zażółć', base64Encoded: false } } }), 'chromium', held('post', {}));
    expect(text.request?.postData).toBe('zażółć');
    const bytes = await routed(answering({ result: { result: { postData: '//4AgEE=', base64Encoded: true } } }), 'chromium', held('post', {}));
    expect(bytes.request?.postData).toBe('��\u0000�A');
  });

  it('asks whatever size BiDi gives the request, which is nothing for a Blob', async () => {
    const fake = answering({ result: { result: { postData: 'QkxPQkRBVEE=', base64Encoded: true } } });
    const { request } = await routed(fake, 'chromium', held('post', { bodySize: 0 }));
    expect(request?.postData).toBe('BLOBDATA');
  });

  it('hands a request Chrome has no post data for to the route without a body', async () => {
    const fake = answering({ error: 'unknown error', message: NO_POST_DATA });
    const { request, failures } = await routed(fake, 'chromium', held('post', {}));
    expect(request).toMatchObject({ id: 'post', method: 'POST' });
    expect(request).not.toHaveProperty('postData');
    expect(failures).toEqual([]);
  });

  it('gives no postData for a body with a part that has no bytes, and refuses to replay it', async () => {
    const fake = answering({ error: 'unknown error', message: UNREPORTED_POST_DATA });
    const { request, fetch, failures } = await routed(fake, 'chromium', held('post', {}), true);
    expect(request).not.toHaveProperty('postData');
    expect(fetch).toMatchObject({
      code: 'ACTION_FAILED',
      message: 'route.fetch: the browser reports no bytes for a part of the request body (a file on disk, or a stream), so the request cannot be replayed',
    });
    expect(failures).toEqual([]);
  });

  it('fails the request and the attempt when the read fails any other way', async () => {
    const fake = answering({ error: 'unknown error', message: 'Session with given id not found' });
    const { request, failures } = await routed(fake, 'chromium', held('post', {}));
    expect(request).toBeUndefined();
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'post' }]);
    expect(failures.map((failure) => failure.message)).toEqual([expect.stringContaining('Session with given id not found')]);
  });

  it('takes a request whose tab closed under the read as unreadable, which is no failure of the attempt', async () => {
    const fake = new FakeBidi();
    const { net, failures, contexts, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    fake.on('goog:cdp.sendCommand', () => {
      contexts.destroyed('tab');
      return { error: 'unknown error', message: 'Session with given id not found' };
    });
    const seen: InterceptedRequest[] = [];
    await net.addRoute(route('**', async (intercepted, decisions) => {
      seen.push(intercepted);
      await decisions.continue({});
    }));
    fake.emit('network.beforeRequestSent', held('post', {}));
    await settle();
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('postData');
    expect(failures).toEqual([]);
  });

  it.each(['GET', 'HEAD'])('asks for no body of a %s', async (method) => {
    const fake = new FakeBidi();
    const { request } = await routed(fake, 'chromium', held('read', { method }));
    expect(request).toMatchObject({ method });
    expect(request).not.toHaveProperty('postData');
    expect(cdpCommands(fake)).toEqual([]);
  });

  it('reads the body of a navigation that posts a form as any other', async () => {
    const fake = answering({ result: { result: { postData: 'YT0x', base64Encoded: true } } });
    const { request } = await routed(fake, 'chromium', held('submit', { bodySize: 3 }, 'nav-1'));
    expect(request?.postData).toBe('a=1');
    expect(cdpCommands(fake)).toEqual([['session-of-tab', 'Network.getRequestPostData', { requestId: 'submit' }]]);
  });
});

describe('the body of a held request on Firefox', () => {
  it('reads it from the request collector, which the first route adds and the last removes', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'base64', value: '//4AgEE=' } } });
    const { net, open } = network(fake, { browser: 'firefox', numberedCollectors: true });
    await net.bind('user-1');
    await open('tab');
    const seen: (string | undefined)[] = [];
    const first = route('**', async (intercepted, decisions) => {
      seen.push(intercepted.postData);
      await decisions.fulfill({ status: 200, headers: {} });
    });
    await net.addRoute(first);
    await net.addRoute(route('**', async (_intercepted, decisions) => decisions.fallback()));
    fake.emit('network.beforeRequestSent', held('post', { bodySize: 5 }));
    await settle();
    await settle();
    expect(seen).toEqual(['��\u0000�A']);
    expect(fake.commands('network.getData').map((command) => command.params)).toEqual([{ dataType: 'request', request: 'post', collector: 'collector-2' }]);
    expect(fake.commands('goog:cdp.sendCommand')).toEqual([]);
    await net.removeRoutes((one) => one === first);
    expect(fake.commands('network.removeDataCollector')).toEqual([]);
    await net.removeRoutes(() => true);
    expect(fake.commands('network.removeDataCollector').map((command) => command.params)).toEqual([{ collector: 'collector-2' }]);
  });

  it('asks the collector for nothing of a request BiDi sizes at nothing', async () => {
    const fake = new FakeBidi();
    const { request } = await routed(fake, 'firefox', held('post', { bodySize: 0 }));
    expect(request).not.toHaveProperty('postData');
    expect(fake.commands('network.getData')).toEqual([]);
  });

  it('takes a route back when the request collector fails to install, and installs it with the next route', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    let failed = false;
    fake.on('network.addDataCollector', (params) => {
      if (failed || !(params['dataTypes'] as string[]).includes('request')) return { result: { collector: 'collector-9' } };
      failed = true;
      return { error: 'unknown error', message: 'install failed' };
    });
    const handled: string[] = [];
    await expect(net.addRoute(route('**', async (_intercepted, decisions) => {
      handled.push('first');
      await decisions.continue({});
    }))).rejects.toThrow('install failed');
    await net.addRoute(route('**', async (_intercepted, decisions) => {
      handled.push('second');
      await decisions.continue({});
    }));
    fake.emit('network.beforeRequestSent', held('read', { method: 'GET' }));
    await settle();
    expect(handled).toEqual(['second']);
    expect(fake.commands('network.addDataCollector').filter((command) => (command.params['dataTypes'] as string[]).includes('request'))).toHaveLength(2);
  });
});
