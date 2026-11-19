/**
 * The driver's surface: one browser per worker (or per attempt) and one
 * `BidiSession` per attempt, with the engine's lifecycle hooks and `guard`,
 * which bounds and classifies every operation. `engine.ts` binds each
 * contract hook, and the `browser` fixture each of its methods, to the
 * driver call that implements it through `guard`: the binder names the
 * label, the driver call, and how the guard treats it.
 */

import {
  EngineError,
  raceAbort,
  withTimeout,
  withinCleanupBudget,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type OperationContext,
  type ViewportSize,
} from '@e2e-dev/core/engine';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import { credentialOrigins, httpCredentials, ProtectedApp } from '../protected-app.ts';
import type { WebBasicAuth, WebMedia, WebScreencastOptions } from '../options.ts';
import { DispatchScope } from './input.ts';
import { abortError, afterDispatch, classify, invalidState, releaseQuietly } from '../errors.ts';
import { BROWSER_OPEN_TIMEOUT_MS, BrowserHandle, type BrowserSource } from './browser-source.ts';
import { TriggerFailure, withDeadline, type OperationBudget } from './budget.ts';
import { traceScreen } from './observe.ts';
import { BidiSession, type SessionSettings } from './session.ts';

/** What a BiDi surface is configured with, from `web()`. */
export interface BidiSurfaceOptions {
  readonly viewport: ViewportSize | null;
  readonly testIdAttribute: string;
  readonly initScripts: ConfiguredInitScripts;
  readonly screencast: WebScreencastOptions;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly basicAuth: WebBasicAuth | undefined;
  readonly credentialOrigins: readonly string[] | undefined;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  /** The configured media features every attempt starts from. */
  readonly media: WebMedia;
  /** Where the browser comes from. */
  readonly source: BrowserSource;
}

/** A browser being opened, which the next caller joins and `endAttempt` or `dispose` cancels. */
interface Acquisition {
  readonly controller: AbortController;
  readonly handle: Promise<BrowserHandle>;
}

/**
 * The engine surface on WebDriver BiDi: one browser per worker (or per
 * attempt, as the source says), one attempt at a time on it, and every
 * engine hook guarded by the operation's budget and the attempt's error
 * latch.
 */
export class BidiSurface {
  /** The browser the worker, or in `attempt` scope the running attempt, rides. */
  private handle: BrowserHandle | undefined;
  private acquiring: Acquisition | undefined;
  private session: BidiSession | undefined;
  private settings: SessionSettings | undefined;
  /** The exact origins the configured headers and credentials go to, which `init` reads off the app. */
  private origins: ReadonlySet<string> = new Set();
  /**
   * Aborted by `dispose`: a browser still being opened fails `CANCELLED`, and
   * one that opens after it is closed instead of published. Replaced by
   * `init`.
   */
  private disposal = new AbortController();

  constructor(private readonly options: BidiSurfaceOptions) {}

  /** The checks of `e2e doctor`: the init scripts `prepare` reads, and what the browser source needs on this machine. */
  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const scripts = await this.options.initScripts.doctor(info.projectRoot);
    return [...scripts, ...(await this.options.source.doctor(info))];
  }

  /** Reads the init scripts and has the source provision the run's browsers, once per run. */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.options.initScripts.load(info.projectRoot);
    return this.options.source.prepare(info);
  }

  /** Releases what `prepare` provisioned. */
  finish(info: EngineFinishInfo): Promise<void> {
    return this.options.source.finish(info);
  }

  /**
   * Records the run and, in `worker` scope, opens the worker's browser. A
   * new tenure: a browser an earlier init was still opening is cancelled,
   * and one it left open is closed, so nothing it opened is reused.
   */
  async init(info: EngineInitInfo): Promise<void> {
    this.disposal.abort();
    this.disposal = new AbortController();
    this.acquiring = undefined;
    const stale = this.handle;
    this.handle = undefined;
    if (stale !== undefined) await releaseQuietly(stale.close());
    const { source, headers: _headers, basicAuth: _basicAuth, credentialOrigins: extraOrigins, ...configured } = this.options;
    const site = info.app.site;
    this.origins = credentialOrigins(info.app.origin, extraOrigins);
    this.settings = {
      ...configured,
      site,
      projectRoot: info.projectRoot,
      permissions: Object.keys(info.app.permissions ?? {}),
      remoteFiles: source.files === 'remote',
      userContext: source.userContext.mode,
      withoutUserContexts: source.userContext.mode === 'fresh' ? source.userContext.instead : undefined,
      env: info.env,
    };
    source.init(info);
    await this.options.initScripts.load(info.projectRoot);
    if (source.scope === 'worker') await this.browserFor(info.signal);
  }

  /**
   * The worker's live browser, opened when there is none or the last one
   * went away; in `attempt` scope (`attempt` given) always a fresh one for
   * the attempt. A caller joins the worker's opening in flight, and its
   * `signal` bounds only its own wait, so a browser a caller gave up on
   * still opens and is published for the next one; an attempt's opening is
   * the attempt's alone.
   */
  private async browserFor(signal: AbortSignal, attempt?: EngineAttemptContext): Promise<BrowserHandle> {
    if (attempt === undefined && this.handle?.alive === true) return this.handle;
    const verb = this.options.source.opening;
    if (signal.aborted) throw abortError(signal, `browser ${verb}`);
    const acquiring = attempt === undefined ? (this.acquiring ?? this.acquire(undefined)) : this.acquire(attempt);
    try {
      return await raceAbort(acquiring.handle, signal, `browser ${verb}`);
    } catch (cause) {
      throw classify(cause, `browser ${verb} failed`);
    }
  }

  /**
   * Opens a browser in the background: the one that went away is closed
   * first, so a launched browser whose mapper died leaves no process or
   * profile behind. The opening ends `CANCELLED` once the surface is
   * disposed, its attempt ends, or (in `attempt` scope) the attempt's signal
   * aborts; a worker's opening is also bounded by `BROWSER_OPEN_TIMEOUT_MS`,
   * and ends `OPERATION_TIMEOUT` at whichever stage that deadline finds it,
   * however the stage itself failed on the abort (a resolver or a provider
   * rejects with an error of its own). It publishes the browser unless
   * either ended it by then.
   */
  private acquire(attempt: EngineAttemptContext | undefined): Acquisition {
    this.acquiring?.controller.abort();
    const controller = new AbortController();
    const timeout = new AbortController();
    const timer = attempt === undefined
      ? setTimeout(() => timeout.abort(new EngineError('OPERATION_TIMEOUT', `the browser did not open within ${BROWSER_OPEN_TIMEOUT_MS}ms`, { retryable: false })), BROWSER_OPEN_TIMEOUT_MS)
      : undefined;
    const signal = AbortSignal.any([controller.signal, this.disposal.signal, timeout.signal, ...(attempt === undefined ? [] : [attempt.signal])]);
    const stale = this.handle;
    this.handle = undefined;
    const acquisition: Acquisition = {
      controller,
      handle: (async () => {
        try {
          if (stale !== undefined) await releaseQuietly(stale.close());
          const browser = await this.options.source.open({ signal, attempt });
          const handle = await BrowserHandle.open(browser, () => this.session, signal);
          this.handle = handle;
          return handle;
        } catch (cause) {
          if (signal.aborted) throw abortError(signal, `browser ${this.options.source.opening}`);
          throw cause;
        }
      })().finally(() => {
        clearTimeout(timer);
        if (this.acquiring === acquisition) this.acquiring = undefined;
      }),
    };
    this.acquiring = acquisition;
    return acquisition;
  }

  /**
   * Opens the attempt's session on the browser and sets up its user
   * context, network, downloads, and emulation. The session is the
   * attempt's from the start, so `endAttempt`, which the harness runs after
   * a failed start too, tears down whatever the setup reached; a user
   * context that lands after the attempt ended removes itself.
   */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    const settings = this.settings;
    if (settings === undefined) throw invalidState('the engine is not initialized');
    const { source } = this.options;
    const basicAuth = this.options.basicAuth;
    const credentials = basicAuth === undefined
      ? undefined
      : await raceAbort(() => httpCredentials(basicAuth, context.resolveSecret), context.signal, 'resolving the basic-auth password');
    const signal = AbortSignal.any([context.signal, this.disposal.signal]);
    const handle = await this.browserFor(signal, source.scope === 'attempt' ? { ...context, signal } : undefined);
    const session = new BidiSession(
      handle.browser,
      settings,
      {
        artifactsDir: context.artifactsDir,
        appLog: context.appLog,
        navigation: context.navigation,
        screen: context.screen,
        protectedApp: new ProtectedApp(this.origins, this.options.headers, credentials),
        remoteDownloads: source.downloads(),
        recorder: source.recorder(context.attemptId),
      },
      handle.contexts,
    );
    this.session = session;
    try {
      await raceAbort(session.openUserContext(signal), context.signal, 'attempt setup');
    } catch (cause) {
      throw classify(cause, 'attempt setup');
    }
    context.environment({ browser: `${handle.browser.traits.name} ${handle.browser.version}`, driver: 'webdriver-bidi' });
  }

  /** Waits for a dialog or route handler still running, then rethrows what it latched. */
  async settleAttempt(context: EngineCleanupContext): Promise<void> {
    await this.session?.latch.settle(context);
  }

  /**
   * Ends the attempt's session, also after a failed `startAttempt`.
   * Idempotent. A close that fails or outlives the cleanup budget leaves
   * resources the browser may still hold, so the browser is retired (the
   * next attempt opens a fresh one) and the failure reported. In `attempt`
   * scope the attempt's browser is closed and given back on every path.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    const { source } = this.options;
    try {
      if (session !== undefined) {
        try {
          await boundedCleanup(session.close(), context, 'attempt cleanup');
        } catch (cause) {
          await this.retireBrowser(context);
          throw classify(cause, 'attempt cleanup');
        }
      }
    } finally {
      if (source.scope === 'attempt') {
        await this.retireBrowser(context);
        await source.endAttempt(context);
      }
    }
  }

  /**
   * Closes the browser within the cleanup budget, best effort, so the next
   * attempt opens a fresh one. In `attempt` scope an opening still in flight
   * is the ending attempt's, so it is cancelled: a browser it opens after
   * closes itself, and a lease it gets is given back.
   */
  private async retireBrowser(context: EngineCleanupContext): Promise<void> {
    if (this.options.source.scope === 'attempt') {
      this.acquiring?.controller.abort();
      this.acquiring = undefined;
    }
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) await withinCleanupBudget(handle.close(), context);
  }

  /** Ends the attempt, cancels a browser still opening, closes the browser, and releases what the source holds, each attempted whatever the others did. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    this.disposal.abort();
    const results = await Promise.allSettled([this.endAttempt(context)]);
    const acquiring = this.acquiring;
    this.acquiring = undefined;
    if (acquiring !== undefined) {
      acquiring.controller.abort();
      await withinCleanupBudget(acquiring.handle, context);
    }
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) results.push(...(await Promise.allSettled([boundedCleanup(handle.close(), context, 'browser close')])));
    results.push(...(await Promise.allSettled([this.options.source.dispose(context)])));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw classify(failed.reason, 'dispose');
  }

  /** The running attempt, which the `browser` fixture built for it reads once; `INVALID_STATE` between attempts. */
  attempt(): BidiSession {
    if (this.session === undefined) throw invalidState('no attempt is running');
    return this.session;
  }

  /**
   * Bounds one operation by its budget, fails it with an error a handler
   * latched, and classifies what it threw. An input operation that fails
   * once its input went out may have reached the app
   * (`ACTION_MAY_HAVE_COMMITTED`), so the harness never repeats it blindly;
   * a sensitive value never leaves in a message or a cause. A step that
   * changed the page hands the trace the screen it left. A wait on the
   * test's own trigger (`afterTrigger`) keeps the whole budget and its own
   * deadline, so only cancellation ends it here, and what the trigger threw
   * leaves as it was thrown.
   */
  async guard<T>(
    operation: OperationContext,
    label: string,
    work: (session: BidiSession, budget: OperationBudget) => Promise<T>,
    kind: GuardKind = {},
  ): Promise<T> {
    this.session?.latch.throwPending();
    const session = this.session;
    const dispatches = new DispatchScope();
    const run = (budget: OperationBudget): Promise<T> => dispatches.run(async () => {
      const current = this.attempt();
      // A tab change already queued (a tab that closed, one a test showed) lands before the operation reads or acts on one.
      await current.tabs.settled();
      return work(current, budget);
    });
    let result: T;
    try {
      result = await (kind.trigger === true ? raceAbort(() => run(operation), operation.signal, label) : withDeadline(operation, label, run));
    } catch (cause) {
      // A handler error latched while the operation ran is its cause: a route that refused its own arguments aborts the request the step waited on.
      session?.latch.throwPending();
      if (cause instanceof TriggerFailure) throw cause.thrown;
      const dispatched = kind.input === true && dispatches.dispatched;
      throw afterDispatch(classify(cause, label, kind.testCode === true || kind.trigger === true), label, dispatched, kind.sensitive);
    }
    if (kind.traced === true && session !== undefined) await traceScreen(session, operation.signal);
    return result;
  }
}

/**
 * How `guard` treats an operation: whether it sends input, fills a sensitive
 * value, shows the trace the screen it left, runs the test's own code, or
 * waits on the test's own trigger (`afterTrigger`), which is test code that
 * owns the operation's deadline.
 */
export interface GuardKind {
  readonly input?: boolean;
  readonly sensitive?: string;
  readonly traced?: boolean;
  readonly testCode?: boolean;
  readonly trigger?: boolean;
}

/**
 * Waits for a cleanup step within the cleanup budget, keeping its failure:
 * one that outlives the budget fails as `OPERATION_TIMEOUT`, one cancelled
 * as `CANCELLED`.
 */
function boundedCleanup(work: Promise<unknown>, budget: EngineCleanupContext, label: string): Promise<void> {
  return withTimeout(
    raceAbort(work.then(() => undefined), budget.signal, label),
    budget.timeoutMs,
    () => new EngineError('OPERATION_TIMEOUT', `${label} did not finish within ${budget.timeoutMs}ms`, { retryable: false }),
  );
}
