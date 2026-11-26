/**
 * The app's main process: one launch through Playwright's `_electron`, the
 * windows it opens registered as they appear, and a quit that ends it within
 * a budget. Launches and quits run one at a time.
 */

import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { Deadline, EngineError, raceAbort, TestError, type EngineAppInfo, type EngineAttemptContext, type OperationContext } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { answerWithin, Budget } from './budget.ts';
import type { ElectronMainModule } from './electron.ts';
import { closedWindow, invalidState } from './errors.ts';
import type { ResolvedElectronOptions } from './options.ts';
import type { AppWindow, Windows } from './windows.ts';

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

/** How long the main process gets to answer a question whose answer is optional. */
const ANSWER_MS = 500;

/** How long a killed app gets to exit, and let go of its files, before its data is deleted. */
const EXIT_WAIT_MS = 2_000;

/** How long setting the downloads directory may take of a launch's budget. */
const DOWNLOADS_SETUP_MS = 2_000;

/** How long an app whose launch failed gets to quit. */
const FAILED_LAUNCH_QUIT_MS = 5_000;

/** How long reading a window's OS title may take. */
const TITLE_MS = 1_000;

/** Where one launched app's events go: the attempt that launched it, for as long as that app is the running one. */
interface AppReport {
  log(entry: Parameters<EngineAttemptContext['appLog']>[0]): void;
  navigated(url: string): void;
}

export class AppProcess {
  private app: ElectronApplication | undefined;
  private exit: string | undefined;
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

  /** Why nothing can be read or run: the app quit on its own during the test, or was never opened. */
  notRunning(): Error {
    const { exit } = this;
    return invalidState(exit === undefined ? 'the app is not running: open it with app.open()' : `the app quit on its own${exit === '' ? '' : ` ${exit}`}: open it again with app.open() or app.restart()`);
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
    this.exit = undefined;
    this.windows.clear();
    if (app === undefined) return;
    // A beforeunload guard would keep its window open, and the app's quit handlers from running: Electron ignores one
    // whose will-prevent-unload event is prevented.
    await answerWithin(
      app.evaluate(({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) contents.on('will-prevent-unload', (event) => event.preventDefault());
      }),
      Math.min(budget.timeoutMs, ANSWER_MS),
    );
    if ((await answerWithin(app.close().then(() => true), Math.min(budget.timeoutMs, graceMs))) === true) return;
    // The process is read only for the kill: Playwright refuses it for an app that has already quit.
    const main = app.process();
    main.kill('SIGKILL');
    // Its files in the user-data directory are deleted next: wait, briefly, until it has let go of them.
    if (main.exitCode === null && main.signalCode === null) await answerWithin(new Promise((resolve) => main.once('exit', resolve)), EXIT_WAIT_MS);
  }

  /** Launches the app on the attempt's user-data directory and waits for its first window to load, all within one budget. */
  async launch(setup: LaunchSetup, operation: OperationContext): Promise<void> {
    // One budget for the whole launch, ending a little before the operation does so the launch reports why it failed
    // rather than the operation timing out; each phase gets what the ones before it left.
    const timeout = Math.max(1, Math.min(new Budget(operation, 'app.open').waits.remaining(), this.options.launchTimeoutMs));
    const deadline = new Deadline(timeout);
    const left = (): number => Math.max(1, deadline.remaining());
    const app = await this.start(setup, operation, timeout);
    this.app = app;
    const watched = this.watch(app, setup.attempt);
    await placeDownloads(app, path.join(setup.userDataDir, 'Downloads'), Math.min(left(), DOWNLOADS_SETUP_MS));
    try {
      const first = await raceAbort(() => app.firstWindow({ timeout: left() }), operation.signal, 'waiting for the first window');
      watched.track(first);
      await raceAbort(() => first.waitForLoadState('domcontentloaded', { timeout: left() }), operation.signal, 'waiting for the first window to load');
    } catch (cause) {
      // Read before the engine's own quit, whose close event would say the app quit.
      const exited = watched.quit();
      // Electron can stall before its ready event on a loaded machine; say so rather than blame the app's window.
      const ready = exited ? undefined : await answerWithin(app.evaluate(({ app: main }) => main.isReady()), ANSWER_MS);
      await this.quit({ timeoutMs: FAILED_LAUNCH_QUIT_MS }, DISCARD_CLOSE_MS);
      if (cause instanceof EngineError) throw cause;
      // Not OPERATION_TIMEOUT, whose message the harness replaces: this one says what the app did.
      const message = exited
        ? 'the app quit before it opened a window'
        : ready === false
          ? `Electron did not become ready within ${timeout}ms (its ready event never fired), so the app opened no window`
          : `the app opened no window within ${timeout}ms`;
      throw new EngineError('INVALID_STATE', message, { retryable: false, cause });
    }
    // A packaged app may disable the inspector's evaluation, or the launch spent its budget; the versions are provenance only.
    const versions = await answerWithin(app.evaluate(() => ({ electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '' })), left());
    if (versions !== undefined) setup.attempt.environment(versions);
  }

  /** Starts the main process and attaches to it, or says why it could not. */
  private async start(setup: LaunchSetup, operation: OperationContext, timeout: number): Promise<ElectronApplication> {
    const { appPath, launchArguments } = setup.app;
    const args = [`--user-data-dir=${setup.userDataDir}`, ...this.options.args, ...(appPath === undefined ? [] : [path.resolve(setup.projectRoot, appPath)]), ...(launchArguments ?? [])];
    // colorScheme null leaves prefers-color-scheme to the app (nativeTheme) and the OS, where Playwright would force light.
    const launching = _electron.launch({ executablePath: setup.executable, args, cwd: setup.projectRoot, env: launchEnv(setup.env, this.options.env), timeout, colorScheme: null });
    try {
      return await raceAbort(launching, operation.signal, 'launching the app');
    } catch (cause) {
      // A launch the caller stopped waiting for still finishes: the app it starts is closed, or it would outlive the test.
      void launching.then((late) => late.close().catch(() => late.process().kill('SIGKILL')), () => undefined);
      if (cause instanceof EngineError) throw cause;
      // The app exiting while Playwright attached is the app's doing, as one that quits before its first window is.
      if (closedWindow(cause)) throw new EngineError('INVALID_STATE', `the app quit while it was launching: ${launchFailure(cause)}`, { retryable: false, cause });
      throw new EngineError('ENGINE_FAILURE', `could not launch ${setup.executable}${appPath === undefined ? '' : ` with ${appPath}`}: ${launchFailure(cause)}`, { retryable: false, cause });
    }
  }

  /**
   * Follows one launched app: its windows registered as they open, its logs
   * sent to the attempt that launched it, and its own quit noticed. Every
   * handler stops once another launch or a quit replaced the app, so an app
   * slow to die never writes into a later attempt.
   */
  private watch(app: ElectronApplication, attempt: EngineAttemptContext): { track(page: Page): void; quit(): boolean } {
    // Read now: Playwright refuses the process of an app that has quit, which is when the close handler needs it.
    const child = app.process();
    let quit = false;
    const current = (): boolean => this.app === app;
    const report: AppReport = {
      log: (entry) => {
        if (current()) attempt.appLog(entry);
      },
      navigated: (url) => {
        if (current()) attempt.navigation(url);
      },
    };
    const { log } = report;
    const track = (page: Page): void => {
      const window = current() ? this.windows.add(page) : undefined;
      if (window !== undefined) this.follow(window, report);
    };
    app.on('window', track);
    app.on('console', (message) => log({ source: 'console', level: levelOf(message.type()), text: `[main] ${message.text()}` }));
    app.on('close', () => {
      quit = true;
      // The app quit on its own (its last window closed, or it called app.quit()): there is nothing left to close.
      if (!current()) return;
      this.app = undefined;
      this.windows.clear();
      const { exitCode, signalCode } = child;
      this.exit = signalCode !== null ? `on ${signalCode}` : exitCode !== null ? `with exit code ${exitCode}` : '';
    });
    for (const page of app.windows()) track(page);
    return { track, quit: () => quit };
  }

  /** Sends one window's log to the attempt, answers its dialogs, and keeps its crashed and navigated states. */
  private follow(window: AppWindow, { log, navigated }: AppReport): void {
    const { page } = window;
    page.on('console', (message) => log({ source: 'console', level: levelOf(message.type()), text: message.text() }));
    page.on('pageerror', (error) => log({ source: 'error', level: 'error', text: error.message }));
    // A page with a dialog listener is not auto-dismissed: the dialog is dismissed here, and the log says the app asked.
    // A beforeunload guard is accepted instead: dismissing it would keep the window open through the engine's own quit.
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') {
        void dialog.accept().catch(() => undefined);
        return;
      }
      log({ source: 'error', level: 'error', text: `unhandled ${dialog.type()} dialog dismissed: ${dialog.message()}` });
      void dialog.dismiss().catch(() => undefined);
    });
    // A crashed renderer answers nothing: the window's session and world are dropped, and reads say so until it reloads.
    page.on('crash', () => {
      this.windows.markCrashed(page);
      this.devtools.forget(page);
      log({ source: 'error', level: 'error', text: 'a window\'s renderer crashed' });
    });
    page.on('load', () => this.windows.markLoaded(page));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.devtools.forgetWorld(page);
      if (this.windows.isShown(window)) navigated(frame.url());
    });
  }

  /** Runs a function in the app's main process; a failure is the function's own unless the app quit under it. */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    const app = this.app;
    if (app === undefined) throw this.notRunning();
    try {
      // Playwright types the argument as it arrives after serialization (`Unboxed<A>`); the fixture's own overloads keep `A` honest.
      return await app.evaluate(fn as (electron: ElectronMainModule, arg: unknown) => R | Promise<R>, arg);
    } catch (cause) {
      // An app that exits under the function fails it before its close event arrives: wait for that a moment. Only then:
      // the function's own error is reported at once.
      const exiting = this.app === app && (closedWindow(cause) || /Execution context was destroyed/.test(String(cause)));
      if (exiting) await answerWithin(new Promise<void>((resolve) => app.once('close', () => resolve())), ANSWER_MS);
      if (this.app !== app) throw new EngineError('INVALID_STATE', 'the app quit while electron.evaluate ran', { retryable: false, cause });
      // Its message is the test's, never read for a pattern.
      const message = (cause instanceof Error ? cause.message.split('\n')[0] : String(cause)) ?? '';
      throw new TestError('EVALUATE_FAILED', `electron.evaluate: ${message.replace(/^electronApplication\.evaluate: /, '')}`, { cause });
    }
  }

  /** The OS window title of a page's `BrowserWindow`, read in the main process; undefined for a view, or when the app does not answer. */
  async windowTitle(page: Page): Promise<string | undefined> {
    const handle = this.app === undefined ? undefined : await answerWithin(this.app.browserWindow(page), TITLE_MS);
    if (handle === undefined) return undefined;
    try {
      return await answerWithin(handle.evaluate((window) => window.getTitle()), TITLE_MS);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
}

/**
 * Sends downloads to the attempt's own directory, never the user's: Electron
 * saves one without asking in a hidden window. A download the app placed
 * itself, in its own `will-download` handler, stays where the app put it.
 */
async function placeDownloads(app: ElectronApplication, directory: string, withinMs: number): Promise<void> {
  await answerWithin(
    app.evaluate(({ app: main, session, webContents }, downloads) => {
      main.setPath('downloads', downloads);
      // A session's path is read when it starts, which may be before this runs: each download is placed explicitly, in
      // the sessions there are (a partition the app's ready handler made, too) and in every one made later.
      const placed = new Set<Electron.Session>();
      const place = (target: Electron.Session): void => {
        if (placed.has(target)) return;
        placed.add(target);
        target.on('will-download', (_event, item) => {
          if (item.getSavePath() === '') item.setSavePath(`${downloads}/${item.getFilename()}`);
        });
      };
      place(session.defaultSession);
      for (const contents of webContents.getAllWebContents()) place(contents.session);
      main.on('session-created', place);
    }, directory),
    withinMs,
  );
}

/**
 * A failed launch's own message and what the app wrote to stderr: Playwright
 * puts the app's output in its call log, below the first line, which is often
 * only a timeout.
 */
function launchFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const [first = '', ...rest] = cause.message.split('\n');
  // Playwright logs a line once per listener; each is kept once, in order.
  const output = [...new Set(rest.flatMap((line) => {
    const match = /\[err\]\s?(.*)$/.exec(line);
    return match?.[1] !== undefined && match[1].trim() !== '' ? [match[1].trim()] : [];
  }))];
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
