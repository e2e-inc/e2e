/**
 * The app process the desktop engine launched and alone may quit: its
 * launch, the token that tells it from every other copy of the app, the
 * launch record a later run's sweep reads, and the quit that waits for it to
 * exit. Launches and quits run one at a time (`serially`). What the surface
 * knows of the app's screen is not kept here: `onGone` tells it the process
 * it read is gone.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EngineError, type OperationContext } from '@e2e-dev/core/engine';
import { call, DriverFailure, translate, type DesktopDriver, type Envelope, type Launched } from './driver.ts';
import { abandon, alive, APP_FILE, killed, OWNER_FILE, STATE_PREFIX } from './launch-ownership.ts';
import { handOffClause } from './launch-report.ts';
import { LAUNCH_READY_MS } from './launch-wait.ts';

/** How long a quit waits for a launch whose outcome was unknown to report the process it started. */
const PENDING_SETTLE_MS = 3_000;

/** How much of a quit's budget is kept for a killed process to exit. */
const EXIT_WAIT_MS = 500;

/** How long a quit looks for an app a launch that answered without one may still have started. */
const LATE_APP_MS = 2_000;

/** How often it looks. */
const LATE_APP_POLL_MS = 100;

/** Launch arguments every launch gets first: no window or document the app saved at its last quit comes back. */
const FRESH_STATE_ARGUMENTS = ['-ApplePersistenceIgnoreState', 'YES'];

/** The cause of an input that was never sent, because the operation's budget ran out first. */
export const NOT_SENT = new Error('the operation ran out of budget before anything was sent');

/** What a target launches: a `.app` bundle on disk, or an installed app by bundle id or name. */
export type LaunchTarget = { readonly path: string; readonly label: string } | { readonly bundleId: string; readonly label: string };

/**
 * A launch whose outcome is unknown: its token, and the driver's answer,
 * which may still name the process it started, or say it started none
 * (`not_started`: refused before `open` ran).
 */
interface PendingLaunch {
  readonly target: string;
  readonly token: string;
  readonly settled: Promise<Launched | 'not_started' | undefined>;
}

/** What a state directory's launch record keeps: the launch's token, and once the process is known, its id and when it started. */
interface LaunchRecord {
  readonly token: string;
  readonly pid?: number;
  readonly started?: number;
}

/** What a launch gives the app besides its target: the target's launch arguments, the environment it inherits, and whether it comes forward. */
interface LaunchSpec {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly activate: boolean;
}

/** What the process needs of the surface that owns it. */
interface AppProcessHost {
  /** The loaded driver, or none once the engine was disposed. */
  driver(): DesktopDriver | undefined;
  /** The loaded driver; throws when there is none. */
  requireDriver(): DesktopDriver;
  /** The process the surface read is gone, or another took its place: nothing it bound names a control that exists. */
  onGone(): void;
}

export class AppProcess {
  /** The app's name, for messages and the observed location. */
  appName: string | undefined;
  /** The process the engine launched, which it alone quits; another instance of the same app is never touched. */
  pid: number | undefined;
  /** The worker's private state directory, which holds its owner file and launch record. */
  home: string | undefined;
  /** When that process started, which a later process given the same id does not share. */
  private started: number | undefined;
  /** The token the launch put in that process's environment. */
  private token: string | undefined;
  /**
   * A launch whose outcome is unknown (it timed out, or failed after it may
   * have started the app), so the next quit can still find and end the
   * process it started.
   */
  private pending: PendingLaunch | undefined;
  /** The launch or quit running now, which the next one waits for. */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: AppProcessHost) {}

  /**
   * Starts over for a new host: nothing of the last one's app carries over,
   * and a state directory, named for this worker so a later sweep can tell
   * it was left behind, holds the next launch's record. A launch the last
   * host could not settle stays in its own launch record, which a sweep takes.
   */
  async open(driver: DesktopDriver): Promise<void> {
    this.appName = undefined;
    this.pid = undefined;
    this.started = undefined;
    this.token = undefined;
    this.pending = undefined;
    this.home = await mkdtemp(path.join(tmpdir(), STATE_PREFIX));
    const started = driver.processStarted(process.pid);
    await writeFile(path.join(this.home, OWNER_FILE), started === null ? String(process.pid) : `${process.pid}\n${started}`);
  }

  /**
   * Removes the state directory, unless `quit` failed and the app or a
   * launch whose process was never found may still run: then it stays named
   * in the launch record, which the next run's sweep quits.
   */
  async close(quit: boolean): Promise<void> {
    const leftRunning = !quit && (this.pid !== undefined || this.pending !== undefined);
    if (this.home !== undefined) await (leftRunning ? abandon(this.home) : rm(this.home, { recursive: true, force: true })).catch(() => undefined);
    this.home = undefined;
  }

  /**
   * Launches `target` fresh, once any copy the engine launched before is
   * quit: the process it starts is the engine's from then on, found by the
   * token in its environment. Callers run it through `serially`.
   */
  async launch(target: LaunchTarget, spec: LaunchSpec, operation: OperationContext): Promise<Launched> {
    const driver = this.host.requireDriver();
    // A failed launch that left no process is nothing to clean up before a new one.
    await this.quitNow(operation.signal, operation.timeoutMs, false);
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `launch ${target.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // Marks the process this launch starts, so it is told apart from every other copy by evidence, never by timing.
    const token = randomUUID();
    // Written before anything is sent, so the app stays findable by its token if this worker is killed mid-launch.
    await this.writeRecord({ token });
    // The write takes time too: a launch sent with no budget left would start the app after the open gave up.
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `launch ${target.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // Started by `call`, which starts nothing once the signal aborted: a cancelled open never launches the app.
    let started: Promise<Envelope<Launched>> | undefined;
    // A cut-off launch whose `open` has not run yet starts no app.
    const inputId = this.host.requireDriver().inputId();
    const start = (): Promise<Envelope<Launched>> =>
      (started = driver.launch({
        ...('path' in target ? { path: target.path } : { bundleId: target.bundleId }),
        arguments: [...FRESH_STATE_ARGUMENTS, ...spec.arguments],
        environment: spec.environment,
        token,
        // In the background unless `physicalInput` or the run's `--headed`: otherwise the app takes the keyboard from whoever is at the Mac.
        activate: spec.activate,
        timeoutMs: operation.timeoutMs,
        claimMs: LAUNCH_READY_MS,
        inputId,
      }));
    let launched: Launched;
    try {
      launched = await call(start, { label: `launch ${target.label}`, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs, onCutOff: () => driver.cancelInput(inputId) });
    } catch (cause) {
      // A launch the driver refused started nothing; any other may have started the app, which the next quit looks for.
      if (started !== undefined && !(cause instanceof DriverFailure && cause.notDelivered)) {
        this.pending = { target: target.label, token, settled: started.then((answer: Envelope<Launched>) => (answer.ok ? answer.data : answer.error.disposition?.delivery === 'not_delivered' ? 'not_started' : undefined), () => undefined) };
      }
      throw this.launchFailure(cause, target);
    }
    this.appName = launched.app === '' ? target.label : launched.app;
    this.pid = launched.pid;
    this.token = token;
    this.started = launched.started ?? driver.processStarted(launched.pid) ?? undefined;
    // The process and when it started, so a later run can quit it, and never a later process given the same id.
    await this.writeRecord({ token, pid: launched.pid, ...(this.started === undefined ? {} : { started: this.started }) });
    return launched;
  }

  /** The engine error for a failed launch, naming what to fix where the driver says what went wrong. */
  private launchFailure(cause: unknown, target: LaunchTarget): Error {
    if (cause instanceof DriverFailure && cause.notDelivered) {
      if (cause.code === 'APP_NOT_FOUND') return new EngineError('ENGINE_FAILURE', `${cause.message}; check the target's app.bundleId or app.appPath`, { retryable: false, cause });
      if (cause.details.kind === 'not_started') return new EngineError('ENGINE_FAILURE', `launch ${target.label}: ${cause.message}`, { retryable: false, cause });
    }
    if (cause instanceof DriverFailure && cause.details.kind === 'unclaimed') {
      return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${cause.message}, so none can be shown to be its own; the end of the attempt looks for it again${handOffClause('; ', cause.runningBefore)}`, { retryable: false, cause });
    }
    return translate(cause, `launch ${target.label}`, true);
  }

  /** Puts the launch record in the state directory, renamed into place so a worker killed mid-write never leaves half a record. */
  private async writeRecord(record: LaunchRecord): Promise<void> {
    if (this.home === undefined) return;
    const file = path.join(this.home, APP_FILE);
    await writeFile(`${file}.partial`, JSON.stringify(record));
    await rename(`${file}.partial`, file);
  }

  /**
   * Runs launches and quits of this surface one at a time: two at once would
   * each launch a copy into the one process id and launch record the engine
   * keeps, and the end of the attempt would quit only one of them.
   */
  serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(run, run);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /** `quitNow` once no other launch or quit of this surface is running. */
  quit(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return this.serially(() => this.quitNow(signal, timeoutMs));
  }

  /**
   * Quits the app the engine launched, forcefully: a test needs it gone, not
   * asked to save. It is ended by its process id, so another instance of the
   * same app (the developer's own copy) is left alone, and waited for, so the
   * next launch cannot find it still running. A process that exited on its
   * own, or whose id the OS gave to another process since, is not running
   * any more, and nothing is killed. Until the process is known to be gone,
   * the engine keeps it as its own, so a quit that failed is tried again. A
   * failed launch that turns out to have left no process is reported, so the
   * user can look for a copy by hand, unless `reportMissing` is false, as
   * before a new launch.
   */
  async quitNow(signal: AbortSignal, timeoutMs: number, reportMissing = true): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pending = this.pending;
    if (this.pid === undefined && pending !== undefined) {
      // The driver may still report the process the launch started: wait for it, short of the quit's budget by `EXIT_WAIT_MS`, so a process found at the end can still be seen to exit.
      const wait = Math.min(Math.max(timeoutMs - EXIT_WAIT_MS, 0), PENDING_SETTLE_MS);
      const settled = await settleWithin(pending.settled, wait, signal);
      if (signal.aborted) throw new EngineError('CANCELLED', `looking for the process a launch of ${pending.target} started was cancelled`, { retryable: false });
      // The driver gave the launch up before `open` ran: it started no app, and there is nothing to look for.
      if (settled === 'not_started') {
        this.pending = undefined;
        if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
        return;
      }
      // A process carrying the launch's token is its own, whether or not the driver reported it.
      const carriers = await this.host.requireDriver().processesCarrying(pending.token);
      if (carriers === null) {
        throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: looking for its token among the processes failed; quitting tries again`, { retryable: false });
      }
      const owned = new Set(carriers);
      // The process the launch answered with, while it is still that process: its id may be another's by now.
      if (settled !== 'timeout' && settled !== undefined && (carriers.includes(settled.pid) || (settled.started !== undefined && this.host.requireDriver().processStarted(settled.pid) === settled.started))) {
        owned.add(settled.pid);
      }
      // A launch that answered without a process may have started the app a moment later: look again, within the budget.
      if (owned.size === 0 && settled !== 'timeout') {
        const whole = Date.now() + LATE_APP_MS;
        for (const pid of await this.lateCarriers(pending.token, Math.min(deadline - EXIT_WAIT_MS, whole), whole, signal, pending.target)) owned.add(pid);
      }
      if (!(await killed([...owned], deadline, signal))) {
        throw new EngineError('ENGINE_FAILURE', `the process a launch of ${pending.target} started did not exit; quitting tries again`, { retryable: false });
      }
      // A launch still running may yet start the app: it stays pending.
      if (owned.size === 0 && settled === 'timeout') {
        throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: it had not finished; quitting tries again`, { retryable: false });
      }
      this.pending = undefined;
      for (const pid of owned) this.host.requireDriver().forgetProcess(pid);
      if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
      if (owned.size > 0 || !reportMissing) return;
      throw new EngineError('ENGINE_FAILURE', `a launch of ${pending.target} failed, and no process it started was found; if the app is running, quit it by hand`, { retryable: false });
    }
    const { pid } = this;
    this.host.onGone();
    if (pid === undefined) return;
    if ((await this.running(pid)) && !(await killed([pid], deadline, signal))) throw new EngineError('ENGINE_FAILURE', `the app (process ${pid}) did not exit`, { retryable: false });
    this.host.driver()?.forgetProcess(pid);
    this.drop();
    if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
  }

  /**
   * The processes carrying a launch's token, looked for until one appears or `until` passes; none when none did through
   * the whole wait, which ends at `whole`. A cancel throws `CANCELLED`, and a scan that failed or a wait cut short of
   * `whole` `ENGINE_FAILURE`, so the launch stays pending.
   */
  private async lateCarriers(token: string, until: number, whole: number, signal: AbortSignal, target: string): Promise<readonly number[]> {
    // None found is a finding only after a whole wait of scans that answered: a cancel, a scan that failed, or a wait
    // the budget cut short proves nothing, and the launch's record must stay for the next quit or sweep.
    let failed = false;
    while (Date.now() < until && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, LATE_APP_POLL_MS));
      const carriers = await this.host.requireDriver().processesCarrying(token);
      if (carriers === null) failed = true;
      else if (carriers.length > 0) return carriers;
    }
    if (signal.aborted) throw new EngineError('CANCELLED', `looking for the process a launch of ${target} started was cancelled`, { retryable: false });
    if (failed) throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${target} started the app: looking for its token among the processes failed; quitting tries again`, { retryable: false });
    if (until < whole) throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${target} started the app: the quit ran out of time to look for it; quitting tries again`, { retryable: false });
    return [];
  }

  /**
   * Whether the process the engine launched still runs: the id alone does
   * not show that, since another process can take it over once the app
   * quits, so it must have started when the launch's did, or else carry the
   * launch's token. A process that cannot be told either way throws, and
   * stays the engine's, so a quit tries again and the launch record stays.
   */
  async running(pid: number): Promise<boolean> {
    if (!alive(pid)) return false;
    const driver = this.host.requireDriver();
    if (this.started !== undefined) {
      const now = driver.processStarted(pid);
      if (now !== null) return now === this.started;
      // Gone between the two looks; still there, its start unreadable, it is the app only if it carries the token.
      if (!alive(pid)) return false;
    }
    const carriers = this.token === undefined ? null : await driver.processesCarrying(this.token);
    if (carriers === null) throw new EngineError('ENGINE_FAILURE', `could not tell whether process ${pid} is still the app the engine launched; quitting tries again`, { retryable: false });
    return carriers.includes(pid);
  }

  /** Forgets the launched process, once it is gone. */
  drop(): void {
    this.pid = undefined;
    this.started = undefined;
    this.token = undefined;
  }
}

/** The driver's answer within `ms`, or `timeout`; a cancelled wait answers at once. */
async function settleWithin<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(ms, 0));
    onAbort = () => resolve('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

