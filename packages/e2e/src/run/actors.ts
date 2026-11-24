/**
 * The actors of a test at run time: the sessions it opens beside its own by
 * naming an `actor()` fixture. Each is one more attempt on an engine: on the
 * worker's own, for an actor on the test's target (a browser context beside
 * the test's), or on another target's, which the worker initializes once and
 * keeps (a phone beside a browser). An attempt opens the actors its fixture
 * plan lists before the test's clock starts, and they are part of it like a
 * session the test opened with `launch()` (`guests.ts`): their steps are in
 * its record under the fixture's name, their video is kept beside its own,
 * and they close with it.
 */

import { randomBytes } from 'node:crypto';
import { createAgentCacheContext, settleStagedTraces, type AgentCacheContext, type AttemptSettlement } from '@e2e-dev/core/lib/cache/context';
import type { StoredRecordings } from '@e2e-dev/core/lib/cache/rekeyed';
import type { ResolvedConfig, ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { classifyError, E2EError, serializeError } from '@e2e-dev/core/lib/internal/errors';
import { MAX_TIMER_MS } from '@e2e-dev/core/lib/internal/time';
import type { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { EngineSessions, type EngineSessionsOptions } from '@e2e-dev/core/lib/run/engine-sessions';
import { createFixtures } from '@e2e-dev/core/lib/run/fixtures';
import type { GuestSteps } from '@e2e-dev/core/lib/run/guest-steps';
import { PreparedEngines } from '@e2e-dev/core/lib/run/provision';
import type { RunError } from '@e2e-dev/core/lib/run/records';
import { holdSessionSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { targetIdentity } from '@e2e-dev/core/lib/run/sessions';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import { launchAttempt, reserveAttempt, type AttemptPolicy, type AttemptWorker, type LaunchedAttempt, type StandaloneAttempt } from '@e2e-dev/core/lib/run/standalone-attempt';
import type { WorkerModels } from '@e2e-dev/core/lib/run/worker-models';
import type { PlannedActor } from '../collect/actors.ts';
import type { FixtureDefinition } from '../collect/registry.ts';
import type { AttemptGuestSessions } from './guests.ts';

/** One other target's engine as a worker holds it: prepared and initialized for this worker alone. */
interface ActorHost {
  readonly sessions: EngineSessions;
  /** Disposes the engine and releases what its `prepare` took; returns what that found. */
  close(): Promise<readonly RunError[]>;
}

/**
 * The engines of the other targets a worker's tests name actors on. A
 * worker runs the tests of one target on that target's engine; the engine of
 * another target is initialized here the first time an actor needs it, the
 * way a `launch()` host is (a browser of its own, a device no worker
 * holds), and kept until the worker ends. An engine that cannot run two
 * attempts at once serves one actor at a time.
 */
export class ActorHosts {
  private readonly hosts = new Map<string, Promise<ActorHost>>();

  constructor(private readonly options: EngineSessionsOptions) {}

  /** The engine sessions of `target` on this worker, opened on first use. A failed opening is tried again by the next test. */
  sessions(target: ResolvedTarget): Promise<EngineSessions> {
    let host = this.hosts.get(target.name);
    if (host === undefined) {
      const opening = this.open(target);
      host = opening;
      this.hosts.set(target.name, opening);
      opening.catch(() => {
        if (this.hosts.get(target.name) === opening) this.hosts.delete(target.name);
      });
    }
    return host.then((opened) => opened.sessions);
  }

  /** Closes every host, once the worker's tests are done; returns the failures closing found. */
  async dispose(): Promise<readonly RunError[]> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    const closed = await Promise.all(hosts.map((host) => host.then((opened) => opened.close(), () => [])));
    return closed.flat();
  }

  private async open(target: ResolvedTarget): Promise<ActorHost> {
    const { config, runId, env, interruptSignal, headed } = this.options;
    // A token of its own, as a `launch()` host has: the engine keeps what it holds for this worker apart from the target's own workers.
    const hostId = randomBytes(12).toString('hex');
    const notice = (targetName: string, line: string): void => this.options.events?.onNotice?.(`${targetName}: ${line}`);
    const engines = new PreparedEngines();
    let sessions: EngineSessions | undefined;
    const close = async (): Promise<readonly RunError[]> => {
      const errors: RunError[] = [];
      const failed = (cause: unknown): void => {
        errors.push({ error: serializeError(classifyError(cause), { phase: 'cleanup' }) });
      };
      await sessions?.dispose();
      errors.push(...(sessions?.collectedRunErrors() ?? []));
      await engines.finish({ runId, hostId, env: env as NodeJS.ProcessEnv, timeoutMs: config.cleanupTimeout, notice, onFailure: failed }).catch(failed);
      return errors;
    };
    try {
      const prepared = await engines.prepare(target, 1, { runId, hostId, projectRoot: config.projectRoot, env: env as NodeJS.ProcessEnv, signal: interruptSignal, headed, notice });
      sessions = new EngineSessions({ ...this.options, target, hostId, workerSlot: 0, env: { ...prepared?.env, ...env } });
      await sessions.initEngineOnce();
    } catch (cause) {
      await close();
      throw cause;
    }
    return { sessions, close };
  }
}

/** How often an actor is asked whether the steps the attempt cut have ended. */
const SETTLE_POLL_MS = 5;

/** The inputs an actor's fixtures are built from, as its attempt hands them over. */
type ActorFixtureBase = LaunchedAttempt<EngineSessions>['fixtureBase'];

interface OpenActor {
  readonly actor: PlannedActor;
  /** The engine sessions the actor's attempt runs on. */
  readonly sessions: EngineSessions;
  readonly attempt: StandaloneAttempt<ActorFixtureBase>;
  readonly cache: AgentCacheContext | undefined;
  readonly steps: GuestSteps;
  fixtures: object | undefined;
}

export interface AttemptActorsOptions {
  readonly config: ResolvedConfig;
  readonly runId: string;
  /** The worker's own engine sessions: where an actor on the test's target opens. */
  readonly own: EngineSessions;
  readonly hosts: ActorHosts;
  readonly guests: AttemptGuestSessions;
  /** The attempt's artifact directory: an actor's artifacts go in `actors/<name>` there. */
  readonly dir: string;
  readonly test: { readonly id: string; readonly titlePath: readonly string[] };
  readonly attemptIndex: number;
  /** The configured agent the test runs as, and the context it gives it: an actor's agent is the same one. */
  readonly agent: string;
  readonly agentContext: string | undefined;
  /** Whether the attempt records a video, so each actor records one too. */
  readonly video: boolean;
  /** Whether the attempt's agent steps replay and record; false for a test with no source to key them on. */
  readonly caches: boolean;
  readonly recordings: StoredRecordings | undefined;
  readonly models: WorkerModels;
}

/**
 * Opens the actors an attempt's fixture plan lists, or nothing when it lists
 * none. A serial group's members share one session, which an actor opened
 * for one of them would not, so a member that names one is refused.
 */
export async function openActors(actors: readonly PlannedActor[], options: AttemptActorsOptions & { readonly serial: boolean }): Promise<AttemptActors | undefined> {
  if (actors.length === 0) return undefined;
  if (options.serial) {
    throw new E2EError('configuration', 'UNSUPPORTED_CAPABILITY', `a test in a serial group names actor "${actors[0]!.name}": the group's tests share one session, and an actor is opened for one test`);
  }
  const opened = new AttemptActors(options);
  await opened.open(actors);
  return opened;
}

export class AttemptActors {
  private readonly opened = new Map<FixtureDefinition, OpenActor>();
  /** Stops sharing the values `holdSecrets` kept; nothing before it. */
  private releaseSecrets: (() => void)[] = [];

  constructor(private readonly options: AttemptActorsOptions) {}

  /**
   * Opens `actors`, one after another: each restores its saved session and
   * starts its video. Rejects with the first failure, named after its actor;
   * the attempt closes the ones already open with everything else it opened.
   */
  async open(actors: readonly PlannedActor[]): Promise<void> {
    for (const actor of actors) {
      try {
        this.opened.set(actor.definition, await this.openOne(actor));
      } catch (cause) {
        const error = classifyError(cause);
        throw new E2EError(error.category, error.code, `actor "${actor.name}": ${error.message}`, { cause, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) });
      }
    }
  }

  /**
   * What a test receives for the actor `definition` declares: its fixtures,
   * built once, on the test's `budget`, so the test's timeout cuts an
   * actor's step as it cuts the test's own, and each teardown gets its own.
   */
  fixtures(definition: FixtureDefinition, budget: AttemptBudget): object {
    const open = this.opened.get(definition);
    if (open === undefined) throw new E2EError('infrastructure', 'WORKER_PROTOCOL', `actor "${definition.name}" was not opened for this attempt`);
    const { test, attemptIndex, agent, agentContext, models } = this.options;
    const base = open.attempt.extra;
    open.fixtures ??= createFixtures({
      ...base,
      attempt: { ...base.attempt, titlePath: test.titlePath, index: attemptIndex },
      budget,
      agent,
      agentContext,
      models,
      ...(open.cache === undefined ? {} : { cache: open.cache }),
    }).fixtures;
    return open.fixtures;
  }

  /**
   * Keeps the secret values the test's `own` session and every actor know
   * shared while the attempt closes them one after another, so what each
   * writes at its end (a text download) is still rewritten for what the
   * others learned. `settleRecordings` lets them go.
   */
  holdSecrets(own: TargetSession | null): void {
    const sessions = [...(own === null ? [] : [own]), ...[...this.opened.values()].map((open) => open.attempt.session)];
    this.releaseSecrets = sessions.map((session) => holdSessionSecrets(session, this.options.config.allSecrets));
  }

  /**
   * Collects the failures each actor's engine holds from a path no step
   * awaited (a route or dialog handler that threw), as the attempt collects
   * its own session's: each fails the test. Returns them, named after their
   * actor.
   */
  async lateFailures(): Promise<readonly E2EError[]> {
    const failures: E2EError[] = [];
    for (const { actor, sessions, attempt } of this.opened.values()) {
      try {
        await sessions.settleAttempt(attempt.session, attempt.attemptId);
      } catch (cause) {
        const error = classifyError(cause);
        failures.push(new E2EError(error.category, error.code, `actor "${actor.name}": ${error.message}`, { cause, retryable: error.retryable }));
      }
    }
    return failures;
  }

  /**
   * Settles what each actor's agent steps recorded, by how the attempt
   * ended, as the test's own recordings settle. `settlement` is the test's
   * own, in the indexes of the test's record, where every session's steps
   * stand in the order they began: a check that passed on any session
   * confirms what an actor did before it. Call it once the actors are
   * closed and every artifact settled; undefined for an interrupted attempt.
   */
  async settleRecordings(settlement: AttemptSettlement | undefined): Promise<void> {
    for (const release of this.releaseSecrets.splice(0)) release();
    for (const { cache, steps } of this.opened.values()) {
      if (cache === undefined) continue;
      // The actor's first step the test's checks did not reach, in the indexes of its own record, which its cache staged
      // by. The lowest such index: steps that ran at once are staged in the order they ended.
      const unverified = settlement === undefined ? [] : cache.staged.map((entry) => entry.stepIndex).filter((index) => (steps.placed(index) ?? Infinity) >= settlement.lastVerifiedStepIndex);
      steps.wrote(await settleStagedTraces(cache, settlement === undefined ? undefined : { ...settlement, lastVerifiedStepIndex: Math.min(...unverified, Infinity) }));
    }
  }

  private async openOne(actor: PlannedActor): Promise<OpenActor> {
    const { config, runId, guests, test } = this.options;
    const { name } = actor;
    const seat = guests.actor(name);
    const sessions = actor.own ? this.options.own : await this.options.hosts.sessions(actor.target);
    const worker: AttemptWorker = {
      config, target: actor.target, runId, executor: sessions,
      resultsDir: this.options.dir, debug: sessions.debug, signal: sessions.interruptSignal,
    };
    const policy: AttemptPolicy<EngineSessions, ActorFixtureBase> = {
      identity: () => ({ testId: test.id, segments: ['actors', name] }),
      launched: ({ fixtureBase }) => fixtureBase,
    };
    let steps: GuestSteps | undefined;
    /** How far the actor's own record counts its steps confirmed; it moves when a check passes there. */
    let verifies = (): number => -1;
    let verified = -1;
    const reservation = reserveAttempt(worker, policy, {
      signal: seat.signal,
      // No deadline of its own: an actor's operations run on the test's budget.
      timeoutMs: MAX_TIMER_MS,
      agent: this.options.agent,
      mirror: (progress, record) => {
        steps?.progress(progress, record);
        // A check that passed on the actor confirms what the test's other sessions did before it, as one of its own
        // does: up to the step the actor's record counts confirmed, which for a check inside an agent step's
        // onAction is that agent step, never past it.
        if (progress.phase === 'end' && verifies() > verified) {
          verified = verifies();
          steps?.verified(verified);
        }
      },
      cancelsOnClose: {
        closed: () => new E2EError('infrastructure', 'CANCELLED', `actor "${name}" is closed`),
        cut: (call) => new E2EError('infrastructure', 'CANCELLED', `actor "${name}" closed while ${call} was running`),
      },
      video: this.options.video ? { keep: 'always', policy: 'best-effort' } : 'off',
      ...(actor.session === undefined ? {} : { state: actor.session }),
    });
    const attempt = await launchAttempt(worker, policy, reservation, () => Promise.resolve());
    verifies = () => attempt.steps.lastVerifiedStepIndex;
    const close = async (): Promise<void> => {
      const errors = await attempt.close();
      for (const recording of attempt.videos()) await steps?.video(recording);
      if (errors.length === 0) return;
      const thrown = errors.map((error) => new E2EError(error.category, error.code, `actor "${name}": ${error.message}`));
      throw new AggregateError(thrown, thrown.map((error) => error.message).join('; '));
    };
    const settled = async (): Promise<void> => {
      await attempt.steps.settleAbandoned();
      // A step cut through the test's budget ends on its own, a few turns of the event loop later.
      while (attempt.steps.busy) await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    };
    steps = seat.take({ root: config.projectRoot, busy: () => attempt.steps.busy, abandonRunning: () => attempt.steps.abandonRunning(), close, settled });
    if (steps === undefined) {
      await close().catch(() => undefined);
      throw new E2EError('infrastructure', 'CANCELLED', 'the test ended before the actor was open');
    }
    const cache = this.options.caches
      ? createAgentCacheContext({
          cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId, testId: test.id,
          target: targetIdentity(actor.target), attemptIndex: this.options.attemptIndex, recordings: this.options.recordings, actor: name,
        })
      : undefined;
    return { actor, sessions, attempt, cache, steps, fixtures: undefined };
  }
}
