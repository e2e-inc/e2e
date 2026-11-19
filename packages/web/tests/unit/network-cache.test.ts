/**
 * When an attempt's network bypasses the browser's HTTP cache, against a
 * scripted peer: only while it has a route, for the whole browser when no
 * other client drives it and for each of the attempt's open tabs otherwise,
 * and back to the default with the last route, a rebind, and the dispose.
 */

import { describe, expect, it } from 'vitest';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { network, route } from '../helpers/network-fake.ts';

/** The parameters of every `network.setCacheBehavior` sent so far, in order. */
const cacheCommands = (fake: FakeBidi): Record<string, unknown>[] => fake.commands('network.setCacheBehavior').map((command) => command.params);

describe('AttemptNetwork and the HTTP cache', () => {
  it('leaves the cache alone without a route, under configured headers too', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { exclusive: true, headers: true });
    await net.bind('user-1');
    await open('tab');
    await net.track();
    await net.dispose();
    expect(fake.commands('network.addIntercept')).toHaveLength(1);
    expect(cacheCommands(fake)).toEqual([]);
  });

  it('bypasses the cache of a browser of its own from the first route to the last', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { exclusive: true });
    await net.bind('user-1');
    await open('tab-1');
    const first = route('**/a');
    const second = route('**/b');
    await net.addRoute(first);
    await net.addRoute(second);
    await open('tab-2');
    expect(cacheCommands(fake)).toEqual([{ cacheBehavior: 'bypass' }]);
    await net.removeRoutes((one) => one === first);
    expect(cacheCommands(fake)).toEqual([{ cacheBehavior: 'bypass' }]);
    await net.removeRoutes(() => true);
    expect(cacheCommands(fake)).toEqual([{ cacheBehavior: 'bypass' }, { cacheBehavior: 'default' }]);
  });

  it('bypasses the cache before the intercept that holds requests for the route is added', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { exclusive: true });
    await net.bind('user-1');
    await net.addRoute(route('**'));
    const order = fake.sent.map((command) => command.method).filter((method) => method === 'network.setCacheBehavior' || method === 'network.addIntercept');
    expect(order).toEqual(['network.setCacheBehavior', 'network.addIntercept']);
  });

  it('turns the cache of a browser of its own back on when the attempt ends with a route', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { exclusive: true });
    await net.bind('user-1');
    await net.addRoute(route('**'));
    await net.dispose();
    expect(cacheCommands(fake)).toEqual([{ cacheBehavior: 'bypass' }, { cacheBehavior: 'default' }]);
  });

  it('bypasses the cache again on the user context a reset binds, after the old one let go of it', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { exclusive: true });
    await net.bind('user-1');
    await net.addRoute(route('**'));
    await net.bind('user-2');
    expect(cacheCommands(fake)).toEqual([{ cacheBehavior: 'bypass' }, { cacheBehavior: 'default' }, { cacheBehavior: 'bypass' }]);
  });

  it('bypasses the cache of its own open tabs only, on a browser other clients drive', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake, { exclusive: false });
    await net.bind('user-1');
    await open('tab-1');
    await net.addRoute(route('**'));
    await open('tab-2');
    expect(cacheCommands(fake)).toEqual([
      { cacheBehavior: 'bypass', contexts: ['tab-1'] },
      { cacheBehavior: 'bypass', contexts: ['tab-2'] },
    ]);
    await close('tab-1');
    await net.removeRoutes(() => true);
    expect(cacheCommands(fake).slice(2)).toEqual([{ cacheBehavior: 'default', contexts: ['tab-2'] }]);
  });

  it('turns the cache of each tab that bypasses it back on when the attempt ends with a route', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { exclusive: false });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    await net.addRoute(route('**'));
    await net.dispose();
    expect(cacheCommands(fake).slice(2)).toEqual([
      { cacheBehavior: 'default', contexts: ['tab-1'] },
      { cacheBehavior: 'default', contexts: ['tab-2'] },
    ]);
  });

  it('takes a tab that closed under the call as done, and one that closed before the attempt ended', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake, { exclusive: false });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    let closing: Promise<void> | undefined;
    fake.on('network.setCacheBehavior', (params) => {
      if ((params['contexts'] as string[])[0] !== 'tab-1') return { result: {} };
      closing ??= close('tab-1');
      return { error: 'no such frame', message: 'tab-1 closed' };
    });
    await net.addRoute(route('**'));
    await closing;
    await net.dispose();
    expect(cacheCommands(fake)).toEqual([
      { cacheBehavior: 'bypass', contexts: ['tab-1'] },
      { cacheBehavior: 'bypass', contexts: ['tab-2'] },
      { cacheBehavior: 'default', contexts: ['tab-2'] },
    ]);
  });

  it('refuses a route whose cache bypass the browser refused, and sets it with the next route', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { exclusive: false });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.setCacheBehavior', { error: 'unknown error', message: 'refused' });
    await expect(net.addRoute(route('**/a'))).rejects.toThrow('refused');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    fake.on('network.setCacheBehavior', { result: {} });
    await net.addRoute(route('**/b'));
    expect(cacheCommands(fake)).toEqual([
      { cacheBehavior: 'bypass', contexts: ['tab'] },
      { cacheBehavior: 'bypass', contexts: ['tab'] },
    ]);
    expect(fake.commands('network.addIntercept')).toHaveLength(1);
  });
});
