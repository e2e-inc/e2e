/** Attempt transitions isolate callbacks and retain finalized artifacts after setup failure. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, Dialog, Route } from 'playwright-core';
import { secrets } from 'e2e';
import type { OperationContext } from '@e2e-dev/core/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Browser as BrowserFixture } from '../../src/browser.ts';
import type { PlaywrightSurface } from '../../src/surface.ts';
import type { WorkerBrowser } from '../../src/worker-browser.ts';
import { attemptContext, cleanupContext, openSurface, openWorker } from '../helpers/attempt.ts';

const acquire = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  BrowserConnection: class { acquire = acquire; dispose = async () => undefined; },
  connectCdp: vi.fn(),
}));

const operation = (): OperationContext => ({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run', attemptId: 'a1', origin: 'test' });
let artifactsDir: string;
let worker: WorkerBrowser;
let surface: PlaywrightSurface;
let fixture: BrowserFixture;
let close: () => Promise<void>;
let registered: ((route: Route) => Promise<void>) | undefined;
let browser: Browser;
let focus: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let press: ReturnType<typeof vi.fn<(key: string) => Promise<void>>>;
let type: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(async () => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-surface-lifecycle-'));
  registered = undefined;
  focus = vi.fn(async () => true);
  press = vi.fn(async (_key: string) => undefined);
  type = vi.fn(async (_text: string) => undefined);
  const page = {
    // The tab listeners the session installs on every page it shows.
    on: () => undefined,
    once: () => undefined,
    isClosed: () => false,
    close: async () => undefined,
    goto: async () => undefined,
    viewportSize: () => ({ width: 1280, height: 720 }),
    frames: () => [{ evaluate: focus }],
    keyboard: { press, type },
    screencast: {
      start: async ({ path: file, onFrame }: { path: string; onFrame?: () => void }) => { writeFileSync(file, 'recording'); onFrame?.(); },
      stop: async () => undefined,
    },
  };
  browser = {
    isConnected: () => true,
    newContext: vi.fn(async () => ({
      addInitScript: async () => undefined,
      pages: () => [],
      setDefaultTimeout: () => undefined,
      on: () => undefined,
      route: async (_predicate: unknown, handler: (route: Route) => Promise<void>) => { registered = handler; },
      close: async () => undefined,
      newPage: async () => page,
    })),
  } as unknown as Browser;
  acquire.mockResolvedValue(browser);
  ({ worker, surface, browser: fixture, close } = await openSurface({ attempt: { attemptId: 'a1', artifactsDir }, timeoutMs: 1_000 }));
});

afterEach(async () => {
  await close();
  rmSync(artifactsDir, { recursive: true, force: true });
});

it('names no handle mix-up when a started worker is read between attempts', async () => {
  await worker.endAttempt({ ...cleanupContext(), attemptId: 'a1' });
  expect(() => worker.attempt({ attemptId: 'a1' }).requireContext()).toThrow(/^no attempt is running$/);
});

it.each(['dialog', 'route'] as const)('keeps a late %s failure on the attempt that registered it', async (kind) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const oldLatch = surface.latch;
  let pending: Promise<void>;
  if (kind === 'dialog') {
    surface.dialogs.add(async () => { await waiting; throw new Error('old handler failed'); });
    pending = surface.dialogs.dispatch({ type: () => 'confirm', message: () => 'old', dismiss: async () => undefined } as unknown as Dialog);
  } else {
    await fixture.route('**/*', async () => { await waiting; throw new Error('old handler failed'); });
    pending = registered!({
      request: () => ({ postData: () => null, url: () => 'https://example.test/', method: () => 'GET', headers: () => ({}) }),
      abort: async () => undefined,
    } as unknown as Route);
  }
  await worker.endAttempt({ ...cleanupContext(), attemptId: 'a1' });
  const next = await openSurface({ worker, attempt: { attemptId: 'a2', artifactsDir } });
  release();
  await pending;
  expect(() => oldLatch.throwPending()).toThrow(/old handler failed/);
  await expect(next.surface.guard(operation(), 'next attempt', async () => 'clean')).resolves.toBe('clean');
});

it('collects saved video segments after ordinary context replacement fails', async () => {
  await surface.startVideo(operation());
  vi.mocked(browser.newContext).mockRejectedValueOnce(new Error('replacement failed'));
  await expect(surface.reset(operation())).rejects.toThrow(/replacement failed/);
  const videos = await surface.stopVideo(operation());
  expect(videos).toHaveLength(1);
  expect(videos[0]).toMatchObject({ path: 'video/video.webm' });
  expect(readFileSync(path.join(artifactsDir, 'video/video.webm'), 'utf8')).toBe('recording');
  await expect(surface.open('https://example.test/', operation())).rejects.toThrow(/replacement failed/);
});

it.each(['focus', 'select-all', 'delete'] as const)('stops remaining typing after cancellation during %s', async (stage) => {
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  if (stage === 'focus') {
    focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  } else {
    press.mockImplementation(async (key) => {
      if (key === (stage === 'select-all' ? 'ControlOrMeta+A' : 'Delete')) { entered(); await paused; }
    });
  }
  const controller = new AbortController();
  const pending = surface.typeText('replacement', { replace: true }, { ...operation(), signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  try {
    await reached;
    controller.abort();
    await rejected;
  } finally {
    release();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const expected = stage === 'focus' ? [] : stage === 'select-all' ? ['ControlOrMeta+A'] : ['ControlOrMeta+A', 'Delete'];
  expect(press.mock.calls.map(([key]) => key)).toEqual(expected);
  expect(type).not.toHaveBeenCalled();
});

it('rejects a focus read from a context replaced before typing dispatches', async () => {
  await surface.open('https://example.test/', operation());
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  focus.mockImplementationOnce(async () => { entered(); await paused; return true; });
  const pending = surface.typeText('replacement', { replace: true }, operation());
  const rejected = expect(pending).rejects.toMatchObject({ code: 'NODE_STALE' });
  try {
    await reached;
    await surface.reset(operation());
  } finally {
    release();
  }
  await rejected;
  expect(press).not.toHaveBeenCalled();
  expect(type).not.toHaveBeenCalled();
});

it('refuses headers or basicAuth from a runner that passes no app origin', async () => {
  for (const options of [{ headers: { 'x-gate': 'on' } }, { basicAuth: { username: 'ada', password: 'pw' } }]) {
    await expect(openWorker({ options })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  }
});

it('opens no session for an attempt the runner gave up on while its basic-auth password resolved', async () => {
  const protectedWorker = await openWorker({
    options: { basicAuth: { username: 'ada', password: secrets.get('stagingPassword') } },
    init: { app: { origin: 'http://127.0.0.1:3000' } },
  });
  try {
    let resolvePassword!: (value: string) => void;
    const slow = new Promise<string>((resolve) => { resolvePassword = resolve; });
    const controller = new AbortController();
    const starting = protectedWorker.startAttempt(attemptContext({ attemptId: 'slow', artifactsDir, signal: controller.signal, resolveSecret: () => slow }));
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    await protectedWorker.endAttempt({ ...cleanupContext(), attemptId: 'slow' });
    resolvePassword('late-password');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The attempt the runner gave up on opened no context: the one call is `beforeEach`'s.
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    await protectedWorker.startAttempt(attemptContext({ attemptId: 'next', artifactsDir, resolveSecret: async () => 'next-password' }));
    expect(vi.mocked(browser.newContext).mock.lastCall?.[0]).toMatchObject({ httpCredentials: [{ username: 'ada', password: 'next-password', origin: 'http://127.0.0.1:3000' }] });
  } finally {
    await protectedWorker.dispose(cleanupContext());
  }
});
