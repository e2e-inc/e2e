/**
 * Opens an attempt for an engine test, with the harness's side of it
 * stubbed. `openAttempt` goes through `web()`, as a run does, and is for a
 * test that needs a page and the `browser` fixture; `openSurface` hands a
 * test the worker's browser and the attempt's surface themselves.
 */

import { tmpdir } from 'node:os';
import type { Page } from 'playwright-core';
import type { EngineAttemptContext, EngineCleanupContext, EngineFixtureContext, EngineInitInfo, OperationContext } from '@e2e-dev/core/engine';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { surfaceOf, web, type WebEngine } from '../../src/engine.ts';
import type { PlaywrightSurface, WebOptions } from '../../src/surface.ts';
import { WorkerBrowser } from '../../src/worker-browser.ts';
import { ignoreTrace, noSecrets } from './secrets.ts';

/** What `init` is told about a worker whose test reads none of it; `overrides` replace fields. */
export function workerInfo(overrides: Partial<EngineInitInfo> = {}): EngineInitInfo {
  return {
    runId: 'run',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: {},
    env: {},
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

/** The context of an attempt that declares no secrets and keeps no trace; `overrides` replace fields. */
export function attemptContext(overrides: Partial<EngineAttemptContext> = {}): EngineAttemptContext {
  return { attemptId: 'attempt', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace, ...overrides };
}

/** A cleanup budget nothing cancels. */
export function cleanupContext(timeoutMs = 5_000): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs };
}

/** The context of one call on an attempt, with the attempt's default budget or `timeoutMs`. */
export type Operation = (timeoutMs?: number) => OperationContext;

/** What a worker runs on: the engine's options, and fields of what `init` is told over `workerInfo`'s. */
export interface WorkerSetup {
  readonly options?: WebOptions;
  readonly init?: Partial<EngineInitInfo>;
}

/** What an attempt runs on, every part optional. */
export interface AttemptSetup extends WorkerSetup {
  /** Fields of the attempt's context over `attemptContext`'s: its id, its artifact directory, what it tells the trace. */
  readonly attempt?: Partial<EngineAttemptContext>;
  /** What the `browser` fixture resolves a relative URL against, as a target's `app.url`; without one a URL is taken as written. */
  readonly baseUrl?: string;
  /** The budget of an operation that names none; 5 seconds by default. */
  readonly timeoutMs?: number;
  /** Fields of the `browser` fixture's context over `fixtureContext`'s. */
  readonly fixture?: Partial<EngineFixtureContext>;
}

/**
 * The harness's context for a `browser` fixture, as far as the fixture
 * reaches into it: a URL is taken as written, nothing is recorded, and no
 * stub mints a locator, a screen, or a matcher surface, which is why the
 * object is cast. `overrides` replace fields.
 */
export function fixtureContext(overrides: Partial<EngineFixtureContext> = {}): EngineFixtureContext {
  const signal = new AbortController().signal;
  return {
    targetName: 'web',
    signal,
    operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' }),
    app: { resolveUrl: (url: string) => url },
    timeouts: { test: 30_000, action: 30_000, assertion: 5_000 },
    fixture: (_name: string, target: object) => target,
    expectable: (target: object) => target,
    attachArtifact: () => undefined,
    attachViewport: () => undefined,
    ...overrides,
  } as unknown as EngineFixtureContext;
}

/** The contexts one attempt is opened with. */
function contextsOf(setup: AttemptSetup): { attempt: EngineAttemptContext; operation: Operation; fixture: EngineFixtureContext } {
  const init = workerInfo(setup.init);
  const attempt = attemptContext(setup.attempt);
  const operation: Operation = (timeoutMs = setup.timeoutMs ?? 5_000) => ({ signal: attempt.signal, timeoutMs, runId: init.runId, attemptId: attempt.attemptId, origin: 'test' });
  const { baseUrl } = setup;
  const fixture = fixtureContext({
    targetName: init.targetName,
    attemptId: attempt.attemptId,
    signal: attempt.signal,
    operation,
    app: { ...init.app, resolveUrl: (url) => (baseUrl === undefined ? url : new URL(url, baseUrl).href) },
    ...setup.fixture,
  });
  return { attempt, operation, fixture };
}

/** One `web()` engine, initialized: what the attempts of a file that shares a browser run on. The caller disposes it. */
export async function openEngine(setup: WorkerSetup = {}): Promise<WebEngine> {
  const engine = web(setup.options);
  await engine.init!(workerInfo(setup.init));
  return engine;
}

/** One attempt on a `web()` engine. */
export interface OpenAttempt {
  /** The engine's `browser` fixture for the attempt. */
  readonly browser: Browser;
  /** The attempt's page, open at `about:blank`. */
  readonly page: Page;
  readonly operation: Operation;
  /** Ends the attempt, and disposes the engine unless the caller passed it in. */
  readonly close: () => Promise<void>;
}

/** Starts one attempt through `web()`, on `setup.engine` or an engine of its own, and opens its page. */
export async function openAttempt(setup: AttemptSetup & { readonly engine?: WebEngine } = {}): Promise<OpenAttempt> {
  const engine = setup.engine ?? (await openEngine(setup));
  const { attempt, operation, fixture } = contextsOf(setup);
  const close = async (): Promise<void> => {
    try {
      await engine.endAttempt!({ ...cleanupContext(), attemptId: attempt.attemptId });
    } finally {
      if (setup.engine === undefined) await engine.dispose!(cleanupContext());
    }
  };
  try {
    await engine.startAttempt!(attempt);
    await engine.session!.open!('about:blank', operation());
    // A fixture factory returns `object` to the harness, which knows no engine's fixture types.
    const browser = engine.fixtures!['browser']!(fixture) as Browser;
    return { browser, page: surfaceOf(engine, attempt.attemptId)!.page(), operation, close };
  } catch (cause) {
    await close().catch(() => undefined);
    throw cause;
  }
}

/** One worker's browser, initialized: what the attempts of a file that shares a browser run on. The caller disposes it. */
export async function openWorker(setup: WorkerSetup = {}): Promise<WorkerBrowser> {
  const worker = new WorkerBrowser(setup.options ?? {});
  await worker.init(workerInfo(setup.init));
  return worker;
}

/** One attempt on a worker's browser, with what `web()` keeps to itself. */
export interface OpenSurface {
  readonly worker: WorkerBrowser;
  readonly surface: PlaywrightSurface;
  /** The `browser` fixture over the surface. */
  readonly browser: Browser;
  readonly operation: Operation;
  /** Ends the attempt, and disposes the worker unless the caller passed it in. */
  readonly close: () => Promise<void>;
}

/** Starts one attempt on `setup.worker` or a worker of its own, with no page open yet. */
export async function openSurface(setup: AttemptSetup & { readonly worker?: WorkerBrowser } = {}): Promise<OpenSurface> {
  const worker = setup.worker ?? (await openWorker(setup));
  const { attempt, operation, fixture } = contextsOf(setup);
  const close = async (): Promise<void> => {
    try {
      await worker.endAttempt({ ...cleanupContext(), attemptId: attempt.attemptId });
    } finally {
      if (setup.worker === undefined) await worker.dispose(cleanupContext());
    }
  };
  try {
    await worker.startAttempt(attempt);
    const surface = worker.attempt(attempt);
    return { worker, surface, browser: createBrowserFixture(surface, fixture), operation, close };
  } catch (cause) {
    await close().catch(() => undefined);
    throw cause;
  }
}
