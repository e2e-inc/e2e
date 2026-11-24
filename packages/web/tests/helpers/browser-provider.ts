/**
 * What the browser provider tests share: a browser the mocked CDP attach
 * hands back, a scripted provider that remembers every call, and what the
 * harness tells each hook of run `run-1`. A test file that uses them mocks
 * `connectCdp` itself.
 */

import { writeFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright-core';
import { vi } from 'vitest';
import type { EngineAttemptContext, EngineCleanupContext, EngineFinishInfo, EngineInitInfo, EnginePrepareInfo, OperationContext } from '@e2e-dev/core/engine';
import { web, type WebEngine } from '../../src/index.ts';
import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '../../src/provider.ts';
import { attemptContext, cleanupContext, workerInfo } from './attempt.ts';

/** A browser the mocked attach hands back: enough of one for a context per attempt or a persistent default context. */
export function fakeBrowser(contextId: string) {
  let connected = true;
  const page = {
    // The tab listeners the session installs on every page it shows.
    on: () => undefined,
    once: () => undefined,
    isClosed: () => false,
    close: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
    screencast: { start: vi.fn(async ({ path: file, onFrame }: { path: string; onFrame?: () => void }) => { writeFileSync(file, 'webm'); onFrame?.(); }), stop: async () => undefined },
  } as unknown as Page;
  const context = {
    newPage: async () => page,
    addInitScript: async () => undefined,
    setDefaultTimeout: () => undefined,
    on: () => undefined,
    route: async () => undefined,
    close: async () => undefined,
    pages: () => [],
    _channel: { registerSelectorEngine: async () => undefined },
  };
  const browser = {
    isConnected: () => connected,
    newContext: async () => context,
    newBrowserCDPSession: async () => ({
      send: async () => ({ browserContextIds: [], defaultBrowserContextId: contextId }),
      detach: async () => undefined,
    }),
    contexts: () => [context],
    close: async () => { connected = false; },
  } as unknown as Browser;
  return { browser, drop: () => { connected = false; } };
}

/** A scripted provider: leases `lease-<n>` against `wss://<n>.example`, remembering every call. */
export function provider(options: { scope?: 'worker' | 'attempt'; failSlot?: number; failRelease?: boolean; reconnect?: boolean; sweep?: 'open' | 'fail' } = {}) {
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
        ...(options.reconnect === true ? { reconnectEndpoint: `wss://${n}.example/reconnect` } : {}),
        // A provider's own bookkeeping never reaches a worker.
        secret: 'x'.repeat(100),
      } as BrowserLease;
      open.set(lease.id, lease);
      return lease;
    },
    async release(lease) {
      released.push(lease);
      if (options.failRelease === true) throw new Error('stop failed');
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
export const finishInfo = (log: (line: string) => void = () => undefined): EngineFinishInfo => ({
  runId: 'run-1',
  targetName: 'web',
  env: { BROWSER_TOKEN: 't' },
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  log,
});
export const initInfo = (workerSlot: number, env: Readonly<Record<string, string | undefined>> = {}, log: (line: string) => void = () => undefined): EngineInitInfo =>
  workerInfo({ runId: 'run-1', projectRoot: '/project', env, workerSlot, log });
export const attempt = (attemptId: string): EngineAttemptContext => attemptContext({ attemptId, artifactsDir: '/tmp/e2e-provider-artifacts' });
export const cleanup = (): EngineCleanupContext => cleanupContext(1_000);
export const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run-1', attemptId: 'a1', origin: 'test' });

/** Runs `prepare` and returns the environment it left for the workers. */
export async function prepared(cloud: BrowserProvider, slots: number): Promise<{ runner: WebEngine; env: Record<string, string> }> {
  const runner = web({ browser: cloud });
  const result = await runner.prepare!(prepareInfo(slots));
  return { runner, env: (result?.env ?? {}) as Record<string, string> };
}
