/**
 * The Electron surface: one app per attempt, launched by `app.open()` with
 * an empty user-data directory of the attempt's own, its windows read
 * through Chromium's accessibility tree over the DevTools protocol and
 * driven with trusted input events. Everything here goes through public
 * APIs: Playwright's `_electron` launcher and `CDPSession`, and the engine
 * contract of `@e2e-dev/core/engine`.
 *
 * The state has three lifetimes, each in a module of its own: the worker's
 * (options, executable, `DevTools`), the attempt's (its user-data directory
 * and artifacts), and the running app's (`AppProcess` and `Windows`).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigurationError, Deadline, withTimeout } from '@e2e-dev/core/engine';
import type {
  EngineAppInfo,
  EngineAttemptContext,
  EngineCleanupContext,
  EngineDoctorCheck,
  EngineDoctorInfo,
  EngineInitInfo,
  EngineObserveOptions,
  EnginePrepareInfo,
  EngineSnapshot,
  LocatorAction,
  LocatorExpression,
  NodeRef,
  OperationContext,
  PointerAction,
  SemanticNode,
  ViewportPoint,
} from '@e2e-dev/core/engine';
import { performAtPoint, performOnNode, pressKey, swipeWindow, typeText, type ActionContext } from './actions.ts';
import { AppProcess, DISCARD_CLOSE_MS, RESTART_CLOSE_MS } from './app-process.ts';
import { screenshotFile, screenshotName, withPixels } from './capture.ts';
import { DevTools } from './devtools.ts';
import type { ElectronMainModule } from './electron.ts';
import { closedWindow, invalidState, notActionable } from './errors.ts';
import { appPathProblem, describeExecutable, ensureElectronBinary, resolveExecutable } from './executable.ts';
import { bounded, waitDeadline } from './input-gate.ts';
import { locateIn, projectRead, readWindow, type ProjectionContext, type RawRead } from './locate.ts';
import type { ResolvedElectronOptions } from './options.ts';
import { ROOT_ID, Windows, type AppWindow, type ElectronWindow, type WindowMatcher } from './windows.ts';

export type { ElectronWindow, WindowMatcher } from './windows.ts';

/** How long a read waits for a crashed window to load again. */
const CRASH_RELOAD_WAIT_MS = 2_000;

function crashed(): Error {
  return invalidState('the window\'s renderer crashed: reload it from the main process with electron.evaluate, or restart the app');
}

export class ElectronSurface {
  private projectRoot = process.cwd();
  private appInfo: EngineAppInfo = {};
  private runEnv: Readonly<Record<string, string | undefined>> = {};
  private executable: string | undefined;
  private attempt: EngineAttemptContext | undefined;
  private userDataDir: string | undefined;
  private artifactCounter = 0;
  private readonly devtools = new DevTools();
  private readonly windowList = new Windows();
  private readonly app: AppProcess;

  constructor(private readonly options: ResolvedElectronOptions) {
    this.app = new AppProcess(options, this.windowList, this.devtools);
  }

  // --- run and worker lifecycle ---

  async prepare(info: EnginePrepareInfo): Promise<void> {
    await ensureElectronBinary(info.projectRoot, this.options.executablePath, info.log, info.signal);
  }

  doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const executable = describeExecutable(info.projectRoot, this.options.executablePath);
    const checks: EngineDoctorCheck[] = [{ id: 'electron', status: executable.status, message: executable.message }];
    const problem = info.app.appPath === undefined ? undefined : appPathProblem(info.projectRoot, info.app.appPath);
    if (problem !== undefined) checks.push({ id: 'electron-app', status: 'fail', message: problem });
    return Promise.resolve(checks);
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.appInfo = info.app;
    this.runEnv = info.env;
    this.executable = await resolveExecutable(info.projectRoot, this.options.executablePath);
    // Checked once here, so a wrong path is one error rather than every test's launch failing.
    const problem = info.app.appPath === undefined ? undefined : appPathProblem(info.projectRoot, info.app.appPath);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', problem);
  }

  startAttempt(context: EngineAttemptContext): Promise<void> {
    this.attempt = context;
    this.artifactCounter = 0;
    // The app's data lives here for the whole attempt: `app.restart()` keeps it, `app.clearState()` empties it.
    this.userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-electron-'));
    return Promise.resolve();
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    await this.app.serialized(() => this.app.quit(context, DISCARD_CLOSE_MS));
    // Retried: Chromium's helper processes can still be closing their files in it.
    if (this.userDataDir !== undefined) rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.userDataDir = undefined;
    this.attempt = undefined;
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.endAttempt(context);
  }

  // --- the app ---

  /** `app.open()` and `app.restart()`: quits the app if it runs and launches it again on the attempt's app data. */
  restart(operation: OperationContext): Promise<void> {
    return this.app.serialized(async () => {
      await this.app.quit(operation, RESTART_CLOSE_MS);
      await this.launch(operation);
    });
  }

  /** `app.clearState()`: quits the app, empties its data, and launches it again. */
  reset(operation: OperationContext): Promise<void> {
    return this.app.serialized(async () => {
      await this.app.quit(operation, DISCARD_CLOSE_MS);
      if (this.userDataDir !== undefined) {
        rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        mkdirSync(this.userDataDir, { recursive: true });
      }
      await this.launch(operation);
    });
  }

  private async launch(operation: OperationContext): Promise<void> {
    const { attempt, userDataDir, executable } = this;
    if (attempt === undefined || userDataDir === undefined) throw invalidState('app.open() runs inside a test: no attempt is running');
    if (executable === undefined) throw invalidState('the electron engine was not initialized');
    await this.app.launch({ executable, projectRoot: this.projectRoot, app: this.appInfo, env: this.runEnv, userDataDir, attempt }, operation);
  }

  // --- reading ---

  private projection(): ProjectionContext {
    return { testIdAttribute: this.options.testIdAttribute, open: this.windowList.open() };
  }

  /**
   * Reads the shown window. A window can close between being picked and being
   * read, before its close event arrives: it is discarded and the window shown
   * in its place is read. A window whose renderer crashed answers nothing: the
   * read waits, until `deadline`, for the app to load it again, then says it
   * crashed. Undefined when no window is open.
   */
  private async readShown(deadline: Deadline): Promise<RawRead | undefined> {
    for (;;) {
      const window = this.windowList.current();
      if (window === undefined) return undefined;
      if (this.windowList.isCrashed(window)) {
        await withTimeout(new Promise<void>((resolve) => window.page.once('load', () => resolve())), Math.max(1, deadline.remaining()), () => crashed()).catch(() => undefined);
        if (this.windowList.isCrashed(window)) throw crashed();
      }
      // A read the renderer's crash leaves pending would never settle: the crash ends it, and the next pass waits.
      let onCrash: (() => void) | undefined;
      const crash = new Promise<'crashed'>((resolve) => {
        onCrash = () => resolve('crashed');
        window.page.once('crash', onCrash);
      });
      try {
        const raw = await Promise.race([readWindow(this.devtools, window), crash]);
        if (raw !== 'crashed') return raw;
      } catch (cause) {
        if (!window.page.isClosed() && !closedWindow(cause)) throw cause;
        this.windowList.discard(window.page);
      } finally {
        if (onCrash !== undefined) window.page.off('crash', onCrash);
      }
    }
  }

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    return await bounded(operation, 'observe', false, async () => {
      // An observation (the agent's, failure evidence) never waits on a crashed window.
      const raw = await this.readShown(new Deadline(0));
      if (raw === undefined) return { root: { ref: { id: ROOT_ID, revision: '' }, role: 'document' }, viewport: { width: 0, height: 0 } };
      const snapshot = projectRead(raw, 'tree', this.projection());
      return options?.pixels === true ? await withPixels(this.devtools, raw, snapshot) : snapshot;
    });
  }

  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    // An app that is not running has nothing to find, ever: say so rather than let the locator wait out its timeout.
    if (this.app.running === undefined) throw this.notRunning();
    return await bounded(operation, 'locate', false, async () => {
      // A crashed window is waited on briefly, for a reload already under way; every read waiting the whole timeout
      // would make each step of a test whose app crashed take it.
      const raw = await this.readShown(new Deadline(Math.min(CRASH_RELOAD_WAIT_MS, waitDeadline(operation).remaining())));
      if (raw === undefined) return [];
      const sink = this.attempt?.screen;
      if (sink !== undefined) {
        try {
          sink(projectRead(raw, 'tree', this.projection()));
        } catch {
          // The trace is evidence; a sink that throws never fails the step.
        }
      }
      return await locateIn(this.devtools, raw, expression, this.projection());
    });
  }

  /**
   * Hands the trace the screen an action left, as `locate` hands it the one
   * it matched against: bounded to a second, and never failing the action.
   */
  private async traceScreen(): Promise<void> {
    const sink = this.attempt?.screen;
    if (sink === undefined) return;
    try {
      const raw = await withTimeout(this.readShown(new Deadline(0)), 1_000, () => new Error('the read took too long'));
      if (raw !== undefined) sink(projectRead(raw, 'tree', this.projection()));
    } catch {
      // The trace is evidence; a read that fails or a sink that throws never fails the step.
    }
  }

  // --- acting ---

  private actions(): ActionContext {
    return { devtools: this.devtools, windows: this.windowList, projectRoot: this.projectRoot, settleMs: this.options.settleMs };
  }

  private requireWindow(): AppWindow {
    if (this.app.running === undefined) throw this.notRunning();
    return this.windowList.require(true);
  }

  /** Why nothing can be read: the app quit on its own during the test, or was never opened. */
  private notRunning(): Error {
    const exited = this.app.exited;
    return invalidState(exited === undefined ? 'the app is not running: open it with app.open()' : `the app quit on its own${exited === '' ? '' : ` ${exited}`}: open it again with app.open() or app.restart()`);
  }

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    if (ref.id === ROOT_ID) {
      const window = this.requireWindow();
      if (action.kind === 'scrollIntoView') return;
      if (action.kind !== 'swipe') throw notActionable(`the window takes swipe and scrollIntoView only, not ${action.kind}; act on a node`);
      await swipeWindow(this.actions(), window, action, operation);
      await this.traceScreen();
      return;
    }
    const { window, backendNodeId } = this.windowList.bind(ref);
    await performOnNode(this.actions(), window, backendNodeId, action, operation);
    await this.traceScreen();
  }

  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    await performAtPoint(this.actions(), this.requireWindow(), point, action, operation);
    await this.traceScreen();
  }

  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    await typeText(this.actions(), this.requireWindow(), text, options.replace, operation);
    await this.traceScreen();
  }

  async pressKey(key: string, operation: OperationContext): Promise<void> {
    await pressKey(this.actions(), this.requireWindow(), key, operation);
    await this.traceScreen();
  }

  // --- windows as tabs ---

  async switchTab(index: number, operation: OperationContext): Promise<void> {
    const window = this.windowList.show(index);
    await bounded(operation, 'switch window', false, () => window.page.bringToFront());
  }

  async closeTab(index: number, operation: OperationContext): Promise<void> {
    const window = this.windowList.closable(index);
    await bounded(operation, 'close window', true, () => window.page.close());
  }

  // --- what the fixture asks ---

  async windows(): Promise<readonly ElectronWindow[]> {
    return (await this.windowList.list((page) => this.app.windowTitle(page))).map(({ entry }) => entry);
  }

  /** Makes the first open window `which` matches the one read and acted in, waiting for it to open until the operation's deadline. */
  async useWindow(which: WindowMatcher, operation: OperationContext): Promise<ElectronWindow> {
    return await this.windowList.use(which, (page) => this.app.windowTitle(page), operation);
  }

  /** Runs a function in the app's main process. */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A, operation: OperationContext): Promise<R> {
    // Started outside the bound, so a failure of the function's own is reported as it is.
    const run = this.app.evaluate(fn, arg);
    // A cancelled step never awaits it.
    run.catch(() => undefined);
    // Not input: a timeout is the function's, and nothing the engine sent may have committed.
    return await bounded(operation, 'electron.evaluate', false, () => run);
  }

  // --- pixels ---

  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const window = this.requireWindow();
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('a screenshot is taken inside a test');
    return await bounded(operation, 'screenshot', false, async () => {
      this.artifactCounter += 1;
      return await screenshotFile(this.devtools, window, attempt.artifactsDir, screenshotName(this.artifactCounter, label));
    });
  }
}
