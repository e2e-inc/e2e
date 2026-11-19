/**
 * The response waits of an attempt's network, against a scripted peer: the
 * headers a wait resolves on, and the body it reads once the response
 * loaded, or fails to read when the load or the network ended first.
 */

import { describe, expect, it } from 'vitest';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';
import { network, request, responded, SITE } from '../helpers/network-fake.ts';

describe('AttemptNetwork', () => {
  it('resolves a response wait on the headers of the first match in the tab, and reads its body once loaded', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: '[1,2,3]' } } });
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    const waiting = net.waitForResponse((url) => url.endsWith('/api/users'), AbortSignal.timeout(5_000));
    await settle();
    const started = (id: string, url: string, context = 'tab'): Network.ResponseStartedParameters => ({
      ...responded(id, url, 200, { headers: [{ name: 'Content-Type', value: { type: 'string', value: 'application/json' } }] }),
      context,
    });
    fake.emit('network.responseStarted', started('other', `${SITE}/other`));
    fake.emit('network.responseStarted', started('popup', `${SITE}/api/users`, 'popup'));
    fake.emit('network.responseStarted', started('users', `${SITE}/api/users`));
    const response = await waiting;
    expect(response).toMatchObject({ url: `${SITE}/api/users`, status: 200, headers: { 'content-type': 'application/json' } });
    let read = false;
    const body = response.body().then((bytes) => {
      read = true;
      return bytes.toString();
    });
    await settle();
    expect(read).toBe(false);
    fake.emit('network.responseCompleted', started('users', `${SITE}/api/users`));
    await expect(body).resolves.toBe('[1,2,3]');
    expect(fake.commands('network.getData')[0]?.params).toEqual({ dataType: 'response', request: 'users', collector: 'collector-1', disown: true });
  });

  it('rejects a body read with the browser’s error when the load failed', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('cut', `${SITE}/cut`, 200));
    const response = await waiting;
    fake.emit('network.fetchError', { ...request('cut', `${SITE}/cut`, []), errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH' });
    await expect(response.body()).rejects.toThrow('net::ERR_CONTENT_LENGTH_MISMATCH');
  });

  it('tells a wait how its load ended after its tab closed', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('gone', `${SITE}/gone`, 200));
    const response = await waiting;
    await close('tab');
    fake.emit('network.fetchError', { ...request('gone', `${SITE}/gone`, []), errorText: 'net::ERR_ABORTED' });
    await expect(response.body()).rejects.toThrow('net::ERR_ABORTED');
  });

  it('adds one response collector for concurrent waits', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
    await Promise.all([first, second]);
    expect(fake.commands('network.addDataCollector')).toHaveLength(1);
    await net.bind('user-2');
    expect(fake.commands('network.removeDataCollector')).toHaveLength(1);
  });

  it('reads the body of a response whose load completes in the same burst as its headers', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'fast' } } });
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const event = responded('fast', `${SITE}/fast`, 200);
    fake.emit('network.responseStarted', event);
    fake.emit('network.responseCompleted', event);
    const response = await waiting;
    await expect(response.body().then(String)).resolves.toBe('fast');
  });

  it('says the browser kept no body, and past what size it keeps none, when a read finds none collected', async () => {
    const fake = new FakeBidi().on('network.getData', () => ({ error: 'no such network data', message: 'Collector c did not collect response data' }));
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const event = responded('big', `${SITE}/big`, 200);
    fake.emit('network.responseStarted', event);
    fake.emit('network.responseCompleted', event);
    await expect((await waiting).body()).rejects.toThrow('the browser kept none of the response body (it keeps none over 20 MB)');
  });

  describe('a response body still loading', () => {
    /** A network bound to user-1, and a response whose headers arrived but whose body never finished. */
    async function pending() {
      const fake = new FakeBidi();
      const { net } = network(fake);
      await net.bind('user-1');
      const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
      return { fake, net, response: await waiting };
    }

    it('fails its read once the network is disposed', async () => {
      const { net, response } = await pending();
      await net.dispose();
      await expect(response.body()).rejects.toThrow('the network ended before the response finished loading');
    });

    it('fails a read already waiting when the network is disposed', async () => {
      const { net, response } = await pending();
      const body = response.body();
      await net.dispose();
      await expect(body).rejects.toThrow('the network ended');
    });

    it('fails its read once the user context is replaced', async () => {
      const { net, response } = await pending();
      await net.bind('user-2');
      await expect(response.body()).rejects.toThrow('the network ended');
    });

    it('fails its read once the connection closes', async () => {
      const { fake, response } = await pending();
      fake.drop();
      await expect(response.body()).rejects.toThrow('the BiDi connection closed');
    });
  });

  it('leaves cookie headers out of a response wait', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    const headers: Network.Header[] = [
      { name: 'Set-Cookie', value: { type: 'string', value: 'sid=secret; HttpOnly' } },
      { name: 'Content-Type', value: { type: 'string', value: 'text/plain' } },
    ];
    fake.emit('network.responseStarted', responded('r', `${SITE}/login`, 200, { headers }));
    expect((await waiting).headers).toEqual({ 'content-type': 'text/plain' });
  });
});
