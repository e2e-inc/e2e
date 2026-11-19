/**
 * The surface's lifecycle on a scripted browser behind a browser provider
 * (the CDP attach mocked, as in browser-provider.test.ts): a reset given up
 * on never leaves the attempt between user contexts nor opens a tab later,
 * a failed setup keeps its cause while `endAttempt` tears down, an attach
 * the last attempt gave up on never holds up the next, and a video segment
 * that cannot start never fails the navigation that opened its tab.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineAttemptContext, EngineCleanupContext, OperationContext } from '@e2e-dev/core/engine';
import { connectBidiOverCdp, type BidiBrowser } from '../../src/driver/launch.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { web } from '../../src/index.ts';
import { gate } from '../helpers/gate.ts';
import { fakeBrowser, initInfo, prepared, provider } from '../helpers/provider-fake.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/driver/launch.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), connectBidiOverCdp: vi.fn() }));
const connectCdp = vi.mocked(connectBidiOverCdp);

afterEach(() => {
  connectCdp.mockReset();
});

const attempt = (id: string, signal = new AbortController().signal): EngineAttemptContext => ({ attemptId: id, artifactsDir: '/tmp/e2e-lifecycle-artifacts', signal, resolveSecret: noSecrets, ...ignoreTrace });
const cleanup = (): EngineCleanupContext => ({ timeoutMs: 2_000, signal: new AbortController().signal });
const op = (timeoutMs = 2_000): OperationContext => ({ timeoutMs, signal: new AbortController().signal, runId: 'run-1', attemptId: 'a1', origin: 'test' });

describe('a reset given up on', () => {
  it('leaves the user context in use, and the one it opens late removes itself instead of opening a tab', async () => {
    const fake = fakeBrowser();
    connectCdp.mockImplementation(async () => fake.browser);
    const leases = provider({ scope: 'worker' }).impl;
    const engine = web({ browser: leases });
    await engine.init!(initInfo(0, (await prepared(leases, 1)).env));
    await engine.startAttempt!(attempt('a1'));
    await engine.session!.open!('https://app.test/', op());
    const { held: landing, release: land } = gate();
    fake.peer.on('browser.createUserContext', () => landing.then(() => ({ result: { userContext: 'uc-late' } })));
    await expect(engine.session!.reset!(op(300))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(engine.session!.open!('https://app.test/', op())).resolves.toBeUndefined();
    land();
    await vi.waitFor(() => expect(fake.peer.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toContain('uc-late'));
    expect(fake.peer.commands('browsingContext.create').map((command) => command.params['userContext'])).toEqual(['uc-1']);
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});

describe('a failed attempt setup', () => {
  it('fails with its own cause, and endAttempt still gives the lease back once', async () => {
    const fake = fakeBrowser();
    fake.peer.on('script.addPreloadScript', { error: 'unknown error', message: 'SETUP BROKE' });
    connectCdp.mockImplementation(async () => fake.browser);
    const cloud = provider({ scope: 'attempt', failRelease: 'release failed' });
    const engine = web({ browser: cloud.impl });
    await engine.init!(initInfo(0, (await prepared(cloud.impl, 1)).env));
    await expect(engine.startAttempt!(attempt('a1'))).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('SETUP BROKE') });
    await expect(engine.endAttempt!(cleanup())).rejects.toThrow('release failed');
    expect(cloud.released.map((lease) => lease.id)).toEqual(['lease-0']);
  });
});

describe('an attach the last attempt gave up on', () => {
  it('never holds up the next attempt, which attaches to its own lease at once', async () => {
    connectCdp.mockImplementation(({ endpoint }) => new Promise<BidiBrowser>((_, reject) => setTimeout(() => reject(new Error(`slow endpoint ${endpoint}`)), endpoint.startsWith('wss://0') ? 3_000 : 0)));
    const leases = provider({ scope: 'attempt' }).impl;
    const engine = web({ browser: leases });
    await engine.init!(initInfo(0, (await prepared(leases, 1)).env));
    await expect(engine.startAttempt!(attempt('a1', AbortSignal.timeout(100)))).rejects.toMatchObject({ code: 'CANCELLED' });
    await engine.endAttempt!(cleanup());
    const started = Date.now();
    await expect(engine.startAttempt!(attempt('a2', AbortSignal.timeout(2_000)))).rejects.toThrow('slow endpoint wss://1.example');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connectCdp.mock.calls.map(([target]) => target.endpoint)).toEqual(['wss://0.example', 'wss://1.example']);
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});

describe('a video segment that cannot start', () => {
  it('lets the navigation that opened its tab pass, and fails stopVideo instead', async () => {
    const fake = fakeBrowser();
    fake.peer.on('goog:cdp.sendCommand', (params) => (params['method'] === 'Page.startScreencast' ? { error: 'unknown error', message: 'no screencast for this tab' } : { result: {} }));
    connectCdp.mockImplementation(async () => fake.browser);
    const leases = provider({ scope: 'worker' }).impl;
    const engine = web({ browser: leases });
    await engine.init!(initInfo(0, { ...(await prepared(leases, 1)).env, E2E_FFMPEG_PATH: process.execPath }));
    await engine.startAttempt!(attempt('a1'));
    await engine.artifacts!.startVideo!(op());
    await expect(engine.session!.open!('https://app.test/', op())).resolves.toBeUndefined();
    await expect(engine.artifacts!.stopVideo!(op())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('no screencast for this tab') });
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });

  it('lets a tab open when the window’s size cannot be read for its segment, and fails stopVideo instead', async () => {
    const fake = fakeBrowser();
    const answer = { result: { type: 'success', result: { type: 'undefined' }, realm: 'r' } };
    fake.peer.on('script.callFunction', (params) => (String(params['functionDeclaration']).includes('innerWidth') ? { error: 'unknown error', message: 'the window has no size' } : answer));
    fake.peer.on('browsingContext.startScreencast', { result: { screencast: 'cast' } });
    connectCdp.mockImplementation(async () => ({ ...fake.browser, traits: BROWSER_TRAITS.firefox }));
    const leases = provider({ scope: 'worker' }).impl;
    const engine = web({ browser: leases, viewport: null });
    await engine.init!(initInfo(0, (await prepared(leases, 1)).env));
    await engine.startAttempt!(attempt('a1'));
    await engine.artifacts!.startVideo!(op());
    await expect(engine.session!.open!('https://app.test/', op())).resolves.toBeUndefined();
    await expect(engine.artifacts!.stopVideo!(op())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('the window has no size') });
    expect(fake.peer.commands('browsingContext.startScreencast')).toEqual([]);
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  });
});
