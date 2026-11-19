/**
 * The browser provider seam without a real browser, for unit tests that mock
 * the CDP attach: a scripted provider, the scripted browser the attach hands
 * back for a lease, and what the runner hands `prepare` and `init`.
 */

import type { EngineHandle, EngineInitInfo, EnginePrepareInfo } from '@e2e-dev/core/engine';
import type { BidiBrowser } from '../../src/driver/launch.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { web } from '../../src/index.ts';
import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '../../src/provider.ts';
import { FakeBidi } from './bidi-fake.ts';

/**
 * A browser the mocked attach hands back: a scripted BiDi peer that answers
 * what an attempt's setup and teardown send, its user contexts and tabs
 * numbered, refusing a tab in an empty user context as Chromium does. `drop`
 * ends its connection, as a browser that went away.
 */
export function fakeBrowser() {
  const peer = new FakeBidi();
  let userContexts = 0;
  let contexts = 0;
  peer
    .on('session.subscribe', { result: { subscription: 's' } })
    .on('browser.createUserContext', () => ({ result: { userContext: `uc-${++userContexts}` } }))
    .on('browsingContext.create', (params) => (params['userContext'] === '' ? { error: 'invalid argument', message: 'empty userContext' } : { result: { context: `ctx-${++contexts}` } }))
    .on('script.addPreloadScript', { result: { script: 'preload' } })
    .on('network.addIntercept', { result: { intercept: 'i' } })
    .on('browsingContext.getTree', { result: { contexts: [] } })
    .on('script.callFunction', { result: { type: 'success', result: { type: 'object', value: [['width', { type: 'number', value: 1280 }], ['height', { type: 'number', value: 720 }]] }, realm: 'r' } });
  const browser: BidiBrowser = {
    traits: BROWSER_TRAITS.chromium,
    version: '157',
    connection: peer.connection,
    exclusive: false,
    close: async () => peer.drop(),
  };
  return { browser, peer, drop: () => peer.drop() };
}

/** What the scripted provider does beside leasing. */
export interface ProviderOptions {
  readonly scope?: 'worker' | 'attempt';
  /** The slot it has no browser for. */
  readonly failSlot?: number;
  /** The message every release fails with, once it is remembered. */
  readonly failRelease?: string;
  /** Has it sweep: `open` gives back the leases still open, `fail` throws. */
  readonly sweep?: 'open' | 'fail';
}

/** A scripted provider: leases `lease-<n>` against `wss://<n>.example`, remembering every call. */
export function provider(options: ProviderOptions = {}) {
  const acquired: BrowserRequest[] = [];
  const released: BrowserLease[] = [];
  const open = new Map<string, BrowserLease>();
  const swept: BrowserReleaseContext[] = [];
  let sequence = 0;
  const impl: BrowserProvider = {
    name: 'toy-cloud',
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    async acquire(request) {
      acquired.push(request);
      if (request.slot === options.failSlot) throw new Error(`no capacity for slot ${request.slot}`);
      request.log('starting');
      const n = sequence++;
      const lease = {
        id: `lease-${n}`,
        cdpEndpoint: `wss://${n}.example`,
        // A provider's own bookkeeping never reaches a worker.
        secret: 'x'.repeat(100),
      } as BrowserLease;
      open.set(lease.id, lease);
      return lease;
    },
    async release(lease) {
      released.push(lease);
      if (options.failRelease !== undefined) throw new Error(options.failRelease);
      open.delete(lease.id);
    },
    ...(options.sweep === undefined
      ? {}
      : {
          async sweep(context: BrowserReleaseContext) {
            swept.push(context);
            if (options.sweep === 'fail') throw new Error('list failed');
            const ids = [...open.keys()];
            open.clear();
            return ids;
          },
        }),
  };
  return { impl, acquired, released, swept };
}

/** What the runner hands `prepare` for `slots` workers of run `run-1`. */
export const prepareInfo = (slots: number, log: (line: string) => void = () => undefined, env: Record<string, string> = { BROWSER_TOKEN: 't' }): EnginePrepareInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  app: {},
  slots,
  env,
  signal: new AbortController().signal,
  headed: false,
  log,
});

/** What the runner hands the `init` of the worker in `workerSlot` of run `run-1`. */
export const initInfo = (workerSlot: number, env: Readonly<Record<string, string | undefined>> = {}, log: (line: string) => void = () => undefined): EngineInitInfo => ({
  runId: 'run-1',
  targetName: 'web',
  projectRoot: '/project',
  app: {},
  env,
  headed: false,
  workerSlot,
  signal: new AbortController().signal,
  log,
});

/** Runs `prepare` for `slots` workers of `cloud` and returns the runner and the environment it left for the workers. */
export async function prepared(cloud: BrowserProvider, slots: number): Promise<{ runner: EngineHandle; env: Record<string, string> }> {
  const runner = web({ browser: cloud });
  const result = await runner.prepare!(prepareInfo(slots));
  return { runner, env: (result?.env ?? {}) as Record<string, string> };
}
