/**
 * The app's main process: one launch through Playwright's `_electron`, the
 * windows it opens registered as they appear, and a quit that ends it within
 * a budget. Launches and quits run one at a time.
 */

import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { Deadline, EngineError, raceAbort, TestError, withTimeout, type EngineAppInfo, type EngineAttemptContext, type OperationContext } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { waitDeadline } from './input-gate.ts';
import type { ElectronMainModule } from './electron.ts';
import { invalidState } from './errors.ts';
import type { ResolvedElectronOptions } from './options.ts';
import type { Windows } from './windows.ts';

/** How long the app gets to close itself when its data is thrown away anyway: a `beforeunload` handler would otherwise hold every test end for the full budget. */
export const DISCARD_CLOSE_MS = 1_000;

/** How long it gets when `app.restart()` keeps its data: time to flush it. */
export const RESTART_CLOSE_MS = 5_000;

/** What a launch reads from the run and the attempt. */
export interface LaunchSetup {
  readonly executable: string;
  readonly projectRoot: string;
  readonly app: EngineAppInfo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataDir: string;
  readonly attempt: EngineAttemptContext;
}

export class AppProcess {
  private app: ElectronApplication | undefined;
  private attempt: EngineAttemptContext | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: ResolvedElectronOptions,
    private readonly windows: Windows,
    private readonly devtools: DevTools,
  ) {}

  /** The running app, if any. */
  get running(): ElectronApplication | undefined {
    return this.app;
  }

  /**
   * Runs a launch or a quit after the ones before it: `app.open()` and
   * `app.restart()` that overlap would each start a main process, and only
   * one is tracked.
   */
  serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Quits the running app, if any: a graceful close within `graceMs` and the budget, then the process killed. */
  async quit(budget: { readonly timeoutMs: number }, graceMs: number): Promise<void> {
    const app = this.app;
    this.app = undefined;
    this.windows.clear();
    if (app === undefined) return;
    // A beforeunload guard would keep its window open, and the app's quit handlers from running: Electron ignores one
    // whose will-prevent-unload event is prevented.
    await withTimeout(
      app.evaluate(({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) contents.on('will-prevent-unload', (event) => event.preventDefault());
      }),
      Math.max(1, Math.min(budget.timeoutMs, 500)),
      () => new Error('the app did not answer'),
    ).catch(() => undefined);
    const closed = await withTimeout(
      app.close().then(() => true, () => false),
      Math.max(1, Math.min(budget.timeoutMs, graceMs)),
      () => new Error('the app did not close in time'),
    ).catch(() => false);
    if (closed) return;
    // The process is read only for the kill: Playwright refuses it for an app that has already quit.
    const main = app.process();
    main.kill('SIGKILL');
    // Its files in the user-data directory are deleted next: wait, briefly, until it has let go of them.
    if (main.exitCode === null && main.signalCode === null) {
      await withTimeout(new Promise((resolve) => main.once('exit', resolve)), 2_000, () => new Error('the app did not exit')).catch(() => undefined);
    }
  }

  /** Launches the app on the attempt's user-data directory and waits for its first window to load, all within one budget. */
  async launch(setup: LaunchSetup, operation: OperationContext): Promise<void> {
    const { appPath, launchArguments } = setup.app;
    const args = [`--user-data-dir=${setup.userDataDir}`, ...this.options.args, ...(appPath === undefined ? [] : [path.resolve(setup.projectRoot, appPath)]), ...(launchArguments ?? [])];
    // One budget for the whole launch, ending a little before the operation does so the launch reports why it failed
    // rather than the operation timing out; each phase gets what the ones before it left.
    const timeout = Math.max(1, Math.min(waitDeadline(operation).remaining(), this.options.launchTimeoutMs));
    const deadline = new Deadline(timeout);
    const left = (): number => Math.max(1, deadline.remaining());
    const launching = _electron.launch({ executablePath: setup.executable, args, cwd: setup.projectRoot, env: launchEnv(setup.env, this.options.env), timeout });
    let app: ElectronApplication;
    try {
      app = await raceAbort(launching, operation.signal, 'launching the app');
    } catch (cause) {
      // A launch the caller stopped waiting for still finishes: the app it starts is closed, or it would outlive the test.
      void launching.then((late) => late.close().catch(() => late.process().kill('SIGKILL')), () => undefined);
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('ENGINE_FAILURE', `could not launch ${setup.executable}${appPath === undefined ? '' : ` with ${appPath}`}: ${launchFailure(cause)}`, { retryable: false, cause });
    }
    this.app = app;
    this.attempt = setup.attempt;
    let quit = false;
    app.process().stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim() !== '') this.attempt?.appLog({ source: 'console', level: 'warning', text: `[main stderr] ${line}` });
    });
    app.on('window', (page) => this.track(app, page));
    app.on('console', (message) => this.attempt?.appLog({ source: 'console', level: levelOf(message.type()), text: `[main] ${message.text()}` }));
    app.on('close', () => {
      quit = true;
      // The app quit on its own (its last window closed, or it called app.quit()): there is nothing left to close.
      if (this.app === app) {
        this.app = undefined;
        this.windows.clear();
      }
    });
    for (const page of app.windows()) this.track(app, page);
    try {
      const first = await raceAbort(() => app.firstWindow({ timeout: left() }), operation.signal, 'waiting for the first window');
      this.track(app, first);
      await raceAbort(() => first.waitForLoadState('domcontentloaded', { timeout: left() }), operation.signal, 'waiting for the first window to load');
    } catch (cause) {
      await this.quit({ timeoutMs: 5_000 }, DISCARD_CLOSE_MS);
      if (cause instanceof EngineError) throw cause;
      // Not OPERATION_TIMEOUT, whose message the harness replaces: this one says what the app did.
      throw new EngineError('INVALID_STATE', quit ? 'the app quit before it opened a window' : `the app opened no window within ${timeout}ms`, { retryable: false, cause });
    }
    try {
      const versions = await withTimeout(
        app.evaluate(() => ({ electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '' })),
        left(),
        () => new Error('no time left to read the versions'),
      );
      setup.attempt.environment({ electron: versions.electron, chromium: versions.chromium });
    } catch {
      // A packaged app may disable the inspector's evaluation, or the launch spent its budget; the versions are provenance only.
    }
  }

  /** Runs a function in the app's main process; a failure is the function's own unless the app quit under it. */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    const app = this.app;
    if (app === undefined) throw invalidState('the app is not running: open it with app.open()');
    try {
      // Playwright types the argument as it arrives after serialization (`Unboxed<A>`); the fixture's own overloads keep `A` honest.
      return await app.evaluate(fn as (electron: ElectronMainModule, arg: unknown) => R | Promise<R>, arg);
    } catch (cause) {
      // An app that exits under the function fails it before its close event arrives: wait for that a moment.
      if (this.app === app) await withTimeout(new Promise<void>((resolve) => app.once('close', () => resolve())), 500, () => new Error('still running')).catch(() => undefined);
      if (this.app !== app) throw new EngineError('INVALID_STATE', 'the app quit while electron.evaluate ran', { retryable: false, cause });
      // Its message is the test's, never read for a pattern.
      const message = (cause instanceof Error ? cause.message.split('\n')[0] : String(cause)) ?? '';
      throw new TestError('EVALUATE_FAILED', `electron.evaluate: ${message.replace(/^electronApplication\.evaluate: /, '')}`, { cause });
    }
  }

  /** Registers a window the app opened, and sends its log to the attempt. */
  private track(app: ElectronApplication, page: Page): void {
    if (this.app !== app) return;
    const window = this.windows.add(page);
    if (window === undefined) return;
    page.on('console', (message) => this.attempt?.appLog({ source: 'console', level: levelOf(message.type()), text: message.text() }));
    page.on('pageerror', (error) => this.attempt?.appLog({ source: 'error', level: 'error', text: error.message }));
    // A page with a dialog listener is not auto-dismissed: the dialog is dismissed here, and the log says the app asked.
    // A beforeunload guard is accepted instead: dismissing it would keep the window open through the engine's own quit.
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') {
        void dialog.accept().catch(() => undefined);
        return;
      }
      this.attempt?.appLog({ source: 'error', level: 'error', text: `unhandled ${dialog.type()} dialog dismissed: ${dialog.message()}` });
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.devtools.forgetWorld(page);
      if (this.windows.isShown(window)) this.attempt?.navigation(frame.url());
    });
  }
}

/**
 * A failed launch's own message and what the app wrote to stderr: Playwright
 * puts the app's output in its call log, below the first line, which is often
 * only a timeout.
 */
function launchFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const [first = '', ...rest] = cause.message.split('\n');
  const output = rest.flatMap((line) => {
    const match = /\[err\]\s?(.*)$/.exec(line);
    return match?.[1] !== undefined && match[1].trim() !== '' ? [match[1].trim()] : [];
  });
  return output.length === 0 ? first : `${first} The app wrote to stderr:\n${output.slice(-10).join('\n')}`;
}

/** The run's environment for the app, without `ELECTRON_RUN_AS_NODE`, with the engine's `env` option over it. */
function launchEnv(runEnv: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(runEnv)) if (value !== undefined) env[key] = value;
  // A runner started from an Electron-based editor inherits this, and the binary would run as plain Node.js.
  delete env['ELECTRON_RUN_AS_NODE'];
  return { ...env, ...extra };
}

function levelOf(type: string): 'error' | 'warning' | 'info' {
  return type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
}
