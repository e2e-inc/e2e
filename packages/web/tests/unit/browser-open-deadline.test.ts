/**
 * The deadline a worker's browser opens within, on the real surface with the
 * clock faked. Whichever stage the deadline finds the opening at (the
 * endpoint still resolving, the provider still leasing, the browser open and
 * its events not yet subscribed), the failure is `OPERATION_TIMEOUT` in the
 * deadline's own words, never the `CANCELLED` of a caller that gave up. The
 * attach is mocked, as in surface-lifecycle.test.ts; launch.test.ts covers
 * the stages inside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext } from '@e2e-dev/core/engine';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { BROWSER_OPEN_TIMEOUT_MS } from '../../src/driver/browser-source.ts';
import { connectBidiOverCdp, type BidiBrowser } from '../../src/driver/launch.ts';
import { web } from '../../src/index.ts';
import type { BrowserLease, BrowserProvider, BrowserRequest } from '../../src/provider.ts';
import { FakeBidi, type Reply } from '../helpers/bidi-fake.ts';
import { initInfo, prepareInfo } from '../helpers/provider-fake.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/driver/launch.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), connectBidiOverCdp: vi.fn() }));
const connectCdp = vi.mocked(connectBidiOverCdp);

afterEach(() => {
  vi.useRealTimers();
  connectCdp.mockReset();
});

/** What an opening the deadline ended fails with. */
const DEADLINE = { code: 'OPERATION_TIMEOUT', message: `the browser did not open within ${BROWSER_OPEN_TIMEOUT_MS}ms` };

const attempt = (id: string): EngineAttemptContext => ({ attemptId: id, artifactsDir: '/tmp/e2e-open-deadline-artifacts', signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });

/** An attached browser on a scripted peer, which answers the event subscription with what `subscribe` returns. */
function fakeBrowser(subscribe: () => Reply | Promise<Reply> = () => ({ result: { subscription: 's' } })): { browser: BidiBrowser; peer: FakeBidi } {
  const peer = new FakeBidi();
  peer.on('session.subscribe', subscribe).on('browsingContext.getTree', { result: { contexts: [] } });
  return { browser: { traits: BROWSER_TRAITS.chromium, version: '157', connection: peer.connection, exclusive: false, close: vi.fn(async () => peer.drop()) }, peer };
}

/**
 * A worker on a provider's browser that went away, so its next attempt
 * leases a replacement, which `replacement` grants. Returns the engine and
 * the leases given back.
 */
async function workerWithoutBrowser(replacement: (request: BrowserRequest) => Promise<BrowserLease>): Promise<{ engine: ReturnType<typeof web>; released: string[] }> {
  const released: string[] = [];
  let leased = 0;
  const provider: BrowserProvider = {
    name: 'toy',
    acquire: (request) => (leased++ === 0 ? Promise.resolve({ id: 'lease-0', cdpEndpoint: 'wss://0.example' }) : replacement(request)),
    release: async (lease) => void released.push(lease.id),
  };
  const prepared = await web({ browser: provider }).prepare!(prepareInfo(1, undefined, {}));
  const first = fakeBrowser();
  connectCdp.mockResolvedValueOnce(first.browser);
  const engine = web({ browser: provider });
  await engine.init!(initInfo(0, { ...(prepared?.env as Record<string, string>) }));
  first.peer.drop();
  return { engine, released };
}

describe('a browser that does not open within its deadline fails as that deadline', () => {
  it('while its endpoint still resolves', async () => {
    vi.useFakeTimers();
    let land: (endpoint: string) => void = () => undefined;
    const engine = web({ connect: { cdpEndpoint: () => new Promise<string>((resolve) => (land = resolve)) } });
    const failed = expect(engine.init!(initInfo(0))).rejects.toMatchObject(DEADLINE);
    await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
    land('ws://127.0.0.1:9');
    await failed;
    expect(connectCdp).not.toHaveBeenCalled();
  });

  it('while its endpoint still resolves, when the resolver stops at the abort', async () => {
    vi.useFakeTimers();
    const engine = web({ connect: { cdpEndpoint: (signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('resolver abandoned')))) } });
    const failed = expect(engine.init!(initInfo(0))).rejects.toMatchObject(DEADLINE);
    await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
    await failed;
  });

  it('once it opened and has yet to take the event subscription, and closes it', async () => {
    vi.useFakeTimers();
    let subscribed: () => void = () => undefined;
    const { browser } = fakeBrowser(() => new Promise((resolve) => (subscribed = () => resolve({ result: { subscription: 's' } }))));
    // The attach takes a second, so the subscription's own timeout ends after the deadline.
    connectCdp.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(browser), 1_000)));
    const engine = web({ connect: { cdpEndpoint: () => 'ws://127.0.0.1:9' } });
    const failed = expect(engine.init!(initInfo(0))).rejects.toMatchObject(DEADLINE);
    await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
    subscribed();
    await failed;
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('while its provider still leases the replacement, when the provider stops at the abort', async () => {
    const { engine } = await workerWithoutBrowser(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('lease abandoned')))));
    vi.useFakeTimers();
    const failed = expect(engine.startAttempt!(attempt('a1'))).rejects.toMatchObject(DEADLINE);
    await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
    await failed;
    expect(connectCdp).toHaveBeenCalledOnce();
  });

  it('when its provider grants the replacement after it, and gives that lease back', async () => {
    let grant: (lease: BrowserLease) => void = () => undefined;
    const { engine, released } = await workerWithoutBrowser(() => new Promise((resolve) => (grant = resolve)));
    vi.useFakeTimers();
    const failed = expect(engine.startAttempt!(attempt('a1'))).rejects.toMatchObject(DEADLINE);
    await vi.advanceTimersByTimeAsync(BROWSER_OPEN_TIMEOUT_MS);
    grant({ id: 'lease-1', cdpEndpoint: 'wss://1.example' });
    await failed;
    expect(released).toEqual(['lease-1']);
    expect(connectCdp).toHaveBeenCalledOnce();
  });
});
