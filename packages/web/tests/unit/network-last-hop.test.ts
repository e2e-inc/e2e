/**
 * Which response ends a request for an attempt's network, against a
 * scripted peer: only a redirect status that names a `Location` leads to
 * another hop, so its record stays with what the next hop goes on with;
 * any other 3xx is the request's last hop, and its record goes.
 */

import { describe, expect, it } from 'vitest';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, responseData, settle } from '../helpers/bidi-fake.ts';
import { LOCATION, network, request, route } from '../helpers/network-fake.ts';

const START = 'https://external.test/start';

/**
 * Sends request `r` through a route that continues it with an `x-route`
 * header, answers it with `status` and `headers`, then announces another
 * hop under the same id. Returns whether the response collector was told to
 * let go of the response, and what the second hop was continued with.
 */
async function answered(status: number, headers: Network.Header[]): Promise<{ released: boolean; next: Record<string, unknown> | undefined }> {
  const fake = new FakeBidi();
  const { net, open } = network(fake);
  await net.bind('user-1');
  await open('tab');
  await net.addRoute(route('**', (held, decisions) => decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } })));
  fake.emit('network.beforeRequestSent', request('r', START));
  await settle();
  await settle();
  fake.emit('network.responseCompleted', { ...request('r', START), isBlocked: false, response: responseData(START, status, { headers }) });
  await settle();
  fake.emit('network.beforeRequestSent', { ...request('r', 'https://external.test/next'), redirectCount: 1 });
  await settle();
  return {
    released: fake.commands('network.disownData').some((command) => command.params['dataType'] === 'response' && command.params['request'] === 'r'),
    next: fake.commands('network.continueRequest').at(-1)?.params,
  };
}

describe('the last hop of a request', () => {
  it.each([301, 302, 303, 307, 308])('keeps a %s that names a Location for the hop it leads to, which goes on with the route\'s headers', async (status) => {
    const { released, next } = await answered(status, LOCATION);
    expect(released).toBe(false);
    expect(next).toMatchObject({ request: 'r', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }]) });
  });

  it.each([300, 304, 305, 306, 399])('takes a %s that names a Location as the last hop, which no browser follows', async (status) => {
    const { released, next } = await answered(status, LOCATION);
    expect(released).toBe(true);
    expect(next).toEqual({ request: 'r' });
  });

  it.each([204, 304])('reads the body of a %s as empty without asking the browser for it', async (status) => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'never read' } } });
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.beforeRequestSent', request('r', START));
    await settle();
    const answer = { ...request('r', START), isBlocked: false, response: responseData(START, status) };
    fake.emit('network.responseStarted', answer);
    fake.emit('network.responseCompleted', answer);
    expect(await (await waiting).body()).toEqual(Buffer.alloc(0));
    expect(fake.commands('network.getData')).toEqual([]);
    expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual(expect.objectContaining({ dataType: 'response', request: 'r' }));
  });

  it.each([301, 302, 303, 307, 308])('takes a %s that names no Location as the last hop', async (status) => {
    const { released, next } = await answered(status, []);
    expect(released).toBe(true);
    expect(next).toEqual({ request: 'r' });
  });
});
