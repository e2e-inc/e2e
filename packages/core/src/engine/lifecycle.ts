/**
 * The lifecycle an engine joins. In the runner process: what `prepare` is
 * handed and may return, once per run and target before any worker exists,
 * and what `finish` is handed after the last worker is gone. In a worker:
 * what `init`, the attempt hooks, and `dispose` are handed.
 */

import type { Secret } from '../types.ts';
import type { EngineHostIdentity } from './contract.ts';
import type { EngineAppInfo, EngineSnapshot } from './index.ts';

/**
 * What `prepare` learned that the run must honour. `workers` replaces the
 * engine's declared cap for this target and run: the surfaces the engine
 * actually provisioned, `1` to `info.slots`. Declared `workers` stays the
 * static answer for engines that know it up front.
 */
export interface EnginePrepareResult {
  /** Lowers the target's worker cap for this run, `1` to `info.slots`. */
  readonly workers?: number;
  /**
   * Variables every worker of this target is spawned with, on top of the
   * run's environment: how a runner-side `prepare` hands what it provisioned
   * (a device pool it discovered) to each worker's `init`. The run's own
   * variables win on a clash.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Facts handed to `prepare`, once per run and target in the runner process,
 * before any worker exists.
 */
export interface EnginePrepareInfo extends EngineHostIdentity {
  /** The run id. */
  readonly runId: string;
  /** The target being prepared. */
  readonly targetName: string;
  /** Directory relative paths in the config resolve against; see `EngineInitInfo.projectRoot`. */
  readonly projectRoot: string;
  /** The app the target declares, as `init` receives it: what a device installs or warms up here. */
  readonly app: EngineAppInfo;
  /**
   * The worker slots the run will start for this target, `0` to `slots - 1`:
   * the run's worker cap, the engine's declared `workers`, and the work units
   * selected for the target, whichever is smallest; `0` when nothing runs on
   * it while another target has work. A run with nothing to run prepares no
   * target. Provision for exactly these slots (boot that many devices of a
   * pool); `init` then finds them ready.
   */
  readonly slots: number;
  /**
   * The run's environment: what every worker is started with. A host may hand
   * the run an environment other than the runner process's own, so anything
   * provisioned here that a worker later looks up by environment (a browser
   * cache location) must be resolved and spawned against this, not
   * `process.env`.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Aborts on interrupt only. Provisioning has no budget: a first-run
   * download is as long as the network makes it, and cutting it short would
   * fail every test behind it.
   */
  readonly signal: AbortSignal;
  /** Whether the run asked for a visible surface (`--headed`), as `EngineInitInfo` declares it. */
  readonly headed: boolean;
  /**
   * The device `e2e run --device` names for this target, by name or id: the
   * one to bind instead of the configured one. Only an engine that declares
   * `selectsDevice` receives it.
   */
  readonly device?: string;
  /**
   * Reports one line of progress. The runner streams it as a `notice` run
   * event, so it reaches the reporter and every host sink instead of being
   * written to a worker's stderr underneath the live status block.
   */
  readonly log: (line: string) => void;
}

/** Handed to `finish`, once per run and target after the last worker is gone, with the cleanup budget of one hook. */
export interface EngineFinishInfo extends EngineCleanupContext, EngineHostIdentity {
  /** The run id. */
  readonly runId: string;
  /** The target being finished. */
  readonly targetName: string;
  /** The run's environment, the same `prepare` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reports one line of progress, streamed as a `notice` run event like `prepare`'s. */
  readonly log: (line: string) => void;
}

/** Run identity and harness-resolved facts handed to `init`, once per worker before the first step. */
export interface EngineInitInfo extends EngineHostIdentity {
  /** The run id. */
  readonly runId: string;
  /** The target this worker serves. */
  readonly targetName: string;
  /**
   * Directory relative paths in the config resolve against: the config file's
   * directory, or the run's `cwd` for a programmatic config. An engine option
   * naming a file (a build to install) resolves here, never against
   * `process.cwd()`, which an in-process run does not change.
   */
  readonly projectRoot: string;
  /** The app the target declares: the origin and site policy of its URL, and what a device launches. */
  readonly app: EngineAppInfo;
  /**
   * This worker's environment: the run's, plus what this target's `prepare`
   * returned in its result's `env`. Read what `prepare` provisioned from
   * here, never from `process.env`: an in-process worker shares its process
   * with the runner and every other target.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether the run asked for a visible surface (`--headed`). */
  readonly headed: boolean;
  /**
   * This worker's 0-based slot among the target's workers: the lowest slot
   * free when the worker was spawned, so a replacement worker takes over the
   * slot of the one that exited. An engine with several devices hands each
   * slot its own; `config.workers` bounds the slots a target can reach.
   */
  readonly workerSlot: number;
  /** Aborts on interrupt and when init exceeds the launch timeout; init must stop promptly. */
  readonly signal: AbortSignal;
  /**
   * Reports one line of progress. The runner streams it as a `notice` run
   * event, prefixed with the target and worker slot, so it reaches the
   * reporter and every host sink instead of being written to a worker's
   * stderr underneath the live status block. This is where a fact that only
   * exists once the worker is up belongs: the URL a hosted browser or device
   * can be watched at, which simulator a slot got, a version it detected.
   * Meant for `init` itself; a line logged later is still delivered while
   * the worker lives and dropped once it has exited. The line is shown as is
   * in reporters and host sinks, so keep tokens and other secrets out of it
   * (a viewer URL without its credential).
   */
  readonly log: (line: string) => void;
}

/**
 * Per-attempt isolation context. An engine that must give each test a fresh
 * surface (a fresh isolated context per test, a reset device) sets it up in
 * `startAttempt` and tears it down in `endAttempt`.
 */
export interface EngineAttemptContext {
  /** The attempt id. */
  readonly attemptId: string;
  /** Absolute directory every artifact of this attempt is written under. */
  readonly artifactsDir: string;
  /**
   * The plaintext of a secret the engine declared in `secrets`, for an
   * option the engine hands the app itself (basic-auth credentials). A
   * provider runs again on every call. The value, and every value
   * `options.derived` computes from it, join the attempt's redaction before
   * this resolves, so reports, logs, and every observation redact them, and
   * the attempt's text downloads are rewritten. The protection is
   * text only: a page that shows the value outside a secure field is not
   * masked in screenshots.
   * A secret the engine did not declare is `SECRET_UNAVAILABLE`.
   */
  readonly resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>;
  /**
   * Aborts with the attempt, and the moment `startAttempt` fails or exceeds
   * the launch timeout: a hook still running then must stop, because the
   * harness ends the attempt's isolation right behind it and may retry.
   */
  readonly signal: AbortSignal;
  /**
   * Reports something the app did on its own while the attempt ran: a
   * console line, an uncaught exception, a request that failed. The harness
   * redacts the text, keeps it with the step that was running (from an event
   * callback outside any step, the step that started last; before the first
   * step, with none), and shows it on the trace page. Call it from the moment `startAttempt` begins until
   * `endAttempt`; entries past a per-attempt cap are dropped.
   */
  readonly appLog: (entry: AppLogEntry) => void;
  /**
   * Reports where the app went on its own, as one line (`navigated to
   * /login`, `the app opened a new tab at /help`, `frame "pay" loaded
   * /embed`): a navigation the engine did not start, a tab, a frame. The
   * harness redacts it and shows it under the step that was running.
   */
  readonly navigation: (line: string) => void;
  /**
   * Hands the harness a screen for the trace: the capture a `locate`
   * matched against, or one read right after an action. The harness redacts
   * it and keeps, for each step, how the screen changed since the step
   * before, which the trace page shows. It never becomes an observation:
   * refs it holds are not valid for `perform`. An engine that reads one after
   * an action does so on the action's path, so it bounds the read (the web
   * engine allows one second and gives up silently) and skips it where a
   * read is expensive; an action never fails because of it. Absent when the
   * attempt keeps no trace; the engine then reads nothing for it.
   */
  readonly screen?: (snapshot: EngineSnapshot) => void;
  /**
   * What the attempt runs on, such as `{ browser: 'chromium 141.0.7390.37' }`
   * or `{ device: 'iPhone 16', os: 'iOS 26.0' }`, for the trace page. A
   * later call adds to and overwrites earlier facts; the harness redacts and
   * clips them and keeps a handful.
   */
  readonly environment: (facts: Readonly<Record<string, string>>) => void;
}

/** Where an app log entry came from. */
export type AppLogSource = 'console' | 'error' | 'network' | 'system';

/** One line of what the app did during an attempt, as `EngineAttemptContext.appLog` takes it. */
export interface AppLogEntry {
  /**
   * Where it came from: the app's `console`, an `error` nothing caught, the
   * `network`, or the `system` the app runs on (a crash, an OS log).
   */
  readonly source: AppLogSource;
  readonly level: 'error' | 'warning' | 'info';
  /** One line, such as `GET /api/todos 500` or `TypeError: x is undefined`; the harness clips it. */
  readonly text: string;
}

/** How `EngineAttemptContext.resolveSecret` treats what the engine makes of the value. */
export interface ResolveSecretOptions {
  /**
   * The forms of the value the app sees instead of the value itself, for the
   * same redaction under the secret's name: the base64 `user:password` an
   * `Authorization: Basic` header carries, which a page echoing its request
   * headers would otherwise show.
   */
  readonly derived?: (plaintext: string) => readonly string[] | Promise<readonly string[]>;
}

/**
 * Budget of one cleanup hook (`settleAttempt`, `endAttempt`, `dispose`). `signal` aborts when
 * the budget is exhausted, so a hook that cannot finish in time stops instead
 * of running on into the next attempt's setup.
 */
export interface EngineCleanupContext {
  /** Aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
  /** Remaining cleanup budget when the call starts. */
  readonly timeoutMs: number;
  /**
   * The attempt `settleAttempt` or `endAttempt` is for. An engine that
   * declares `actors` has more than one open at a time and reads it; absent
   * for `dispose`, and from a harness that predates actors.
   */
  readonly attemptId?: string;
}

/** Cleanup of one worker, with optional permission to leave run-owned resources for a replacement. */
export interface EngineDisposeContext extends EngineCleanupContext {
  /**
   * A live signal permits reusable resources owned by `prepare` and `finish`
   * to survive this worker. Missing or aborted permission requires final
   * cleanup. Observe revocation until disposal settles. This signal does
   * not cancel cleanup, which remains bounded by `signal` and `timeoutMs`.
   */
  readonly reuseSignal?: AbortSignal;
}
