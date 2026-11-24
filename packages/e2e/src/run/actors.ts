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
import path from 'node:path';
import { createAgentCacheContext, settleStagedTraces, type AgentCacheContext, type AttemptSettlement, type CacheWrite } from '@e2e-dev/core/lib/cache/context';
import type { StoredRecordings } from '@e2e-dev/core/lib/cache/rekeyed';
import type { ResolvedConfig, ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { classifyError, E2EError, InfrastructureError, serializeError } from '@e2e-dev/core/lib/internal/errors';
import { MAX_TIMER_MS, withTimeout } from '@e2e-dev/core/lib/internal/time';
import type { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { EngineSessions, type EngineSessionsOptions } from '@e2e-dev/core/lib/run/engine-sessions';
import { createFixtures } from '@e2e-dev/core/lib/run/fixtures';
import type { GuestMirror } from '@e2e-dev/core/lib/run/guest-steps';
import { PreparedEngines } from '@e2e-dev/core/lib/run/provision';
import type { RunError } from '@e2e-dev/core/lib/run/records';
import { sessionLedger } from '@e2e-dev/core/lib/run/secrecy';
import { targetIdentity } from '@e2e-dev/core/lib/run/sessions';
import { launchAttempt, reserveAttempt, type AttemptPolicy, type AttemptWorker, type LaunchedAttempt, type StandaloneAttempt } from '@e2e-dev/core/lib/run/standalone-attempt';
import type { WorkerModels } from '@e2e-dev/core/lib/run/worker-models';
import type { PlannedActor } from '../collect/actors.ts';
import type { FixtureDefinition } from '../collect/registry.ts';
import type { DrivenSession } from './driven-sessions.ts';
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
      await engines.finish({ runId, hostId, env, timeoutMs: config.cleanupTimeout, notice, onFailure: failed }).catch(failed);
      return errors;
    };
    try {
      const prepared = await engines.prepare(target, 1, { runId, hostId, projectRoot: config.projectRoot, env, signal: interruptSignal, headed, notice });
      sessions = new EngineSessions({ ...this.options, target, hostId, workerSlot: 0, env: { ...prepared?.env, ...env } });
      await sessions.initEngineOnce();
    } catch (cause) {
      await close();
      throw cause;
    }
    return { sessions, close };
  }
}

/** `cause` as the attempt reports it: the failure it is, told as the actor's. */
function actorError(name: string, cause: unknown): E2EError {
  const error = classifyError(cause);
  return new E2EError(error.category, error.code, `actor "${name}": ${error.message}`, { cause, retryable: error.retryable, ...(error.details === undefined ? {} : { details: error.details }) });
}

/** Where an actor keeps its artifacts under the attempt's directory. */
const actorSegments = (name: string): readonly string[] => ['actors', name];

/** The inputs an actor's fixtures are built from, as its attempt hands them over. */
type ActorFixtureBase = LaunchedAttempt<EngineSessions>['fixtureBase'];

interface OpenActor {
  readonly actor: PlannedActor;
  /** The engine sessions the actor's attempt runs on. */
  readonly sessions: EngineSessions;
  readonly attempt: StandaloneAttempt<ActorFixtureBase>;
  readonly cache: AgentCacheContext | undefined;
  readonly steps: GuestMirror;
  /** Whether the actor was closed: the engine then knows nothing of its attempt. */
  closed(): boolean;
  fixtures: object | undefined;
}

export interface AttemptActorsOptions {
  readonly config: ResolvedConfig;
  readonly runId: string;
  /** The worker's own engine sessions: where an actor on the test's target opens. */
  readonly own: EngineSessions;
  readonly hosts: ActorHosts;
  readonly guests: AttemptGuestSessions;
  /** Cuts the operations running on the attempt's budget, an actor's among them, the way its timeout does. */
  readonly cut: () => void;
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

/** The actors of one attempt: the ones its fixture plan lists, which is none for most tests. */
export class AttemptActors {
  private readonly opened = new Map<FixtureDefinition, OpenActor>();

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
        throw actorError(actor.name, cause);
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
   * Each actor as a session the attempt drives (`driven-sessions.ts`): what
   * its engine holds from a path no step awaited fails the test under the
   * actor's name, and its screen is told as the actor's.
   */
  sessions(): readonly DrivenSession[] {
    return [...this.opened.values()].map(({ actor: { name, target }, sessions, attempt: { session }, closed }) => ({
      actor: name,
      session,
      settle: async () => {
        // A closed actor's attempt has ended on the engine.
        if (!closed()) await sessions.settleAttempt(session).catch((cause: unknown) => Promise.reject(actorError(name, cause)));
      },
      screen: () =>
        closed()
          ? undefined
          : {
              session, appBase: target.app.base, appOrigin: target.app.base?.origin,
              actor: { name, dir: path.join(...actorSegments(name)) },
              ledger: sessionLedger(session, this.options.config.allSecrets),
              operation: (signal, timeoutMs) => sessions.op(session, timeoutMs, signal),
            },
    }));
  }

  /**
   * Settles what each actor's agent steps recorded, by how the attempt
   * ended, as the test's own recordings settle. `settlement` is the test's
   * own, in the indexes of the test's record, where every session's steps
   * stand in the order they began: a check that passed on any session
   * confirms what an actor did before it. Returns what became of each
   * recording, by its step's index in the test's record. Call it once the
   * actors are closed; undefined for an interrupted attempt.
   */
  async settleRecordings(settlement: AttemptSettlement | undefined): Promise<ReadonlyMap<number, CacheWrite>> {
    const writes = new Map<number, CacheWrite>();
    for (const { cache, steps } of this.opened.values()) {
      if (cache === undefined) continue;
      // An actor's cache staged its entries by the indexes of the actor's own record: each is settled by where its step
      // stands in the test's. A step the test's record never took was confirmed by nothing.
      cache.staged.push(...cache.staged.splice(0).map((entry) => ({ ...entry, stepIndex: steps.placed(entry.stepIndex) ?? Infinity })));
      for (const [index, write] of await settleStagedTraces(cache, settlement)) writes.set(index, write);
    }
    return writes;
  }

  private async openOne(actor: PlannedActor): Promise<OpenActor> {
    const { config, runId, guests, test } = this.options;
    const { name } = actor;
    const seat = guests.actor(name, config.projectRoot);
    const sessions = actor.own ? this.options.own : await this.options.hosts.sessions(actor.target);
    const worker: AttemptWorker = {
      // Only what the test's record lists goes to the artifact store: the actor's video and the screen at a failure, registered there.
      config: { ...config, artifactStore: undefined },
      target: actor.target, runId, executor: sessions,
      resultsDir: this.options.dir, debug: sessions.debug, signal: sessions.interruptSignal,
    };
    const policy: AttemptPolicy<EngineSessions, ActorFixtureBase> = {
      identity: () => ({ testId: test.id, segments: actorSegments(name) }),
      launched: ({ fixtureBase }) => fixtureBase,
    };
    let attempt: StandaloneAttempt<ActorFixtureBase> | undefined;
    /** How far the actor's own record counted its steps confirmed when it was last told here. */
    let verified = -1;
    const reservation = reserveAttempt(worker, policy, {
      // The attempt ends the actor by closing it; only the run's interrupt cancels it from outside.
      signal: sessions.interruptSignal,
      // No deadline of its own: an actor's operations run on the test's budget.
      timeoutMs: MAX_TIMER_MS,
      agent: this.options.agent,
      mirror: (progress, record) => {
        seat.steps.progress(progress, record);
        // A check that passed on the actor confirms what the test's other sessions did before it, as one of its own
        // does: up to the step the actor's record counts confirmed, which for a check inside an agent step's
        // onAction is that agent step, never past it.
        const confirmed = attempt?.steps.lastVerifiedStepIndex ?? -1;
        if (progress.phase === 'end' && confirmed > verified) {
          verified = confirmed;
          seat.steps.verified(confirmed);
        }
      },
      cancelsOnClose: {
        closed: () => new E2EError('infrastructure', 'CANCELLED', `actor "${name}" is closed`),
        cut: (call) => new E2EError('infrastructure', 'CANCELLED', `actor "${name}" closed while ${call} was running`),
      },
      video: this.options.video ? { keep: 'always', policy: 'best-effort' } : 'off',
      ...(actor.session === undefined ? {} : { state: actor.session }),
    });
    const launched = await launchAttempt(worker, policy, reservation, () => Promise.resolve());
    attempt = launched;
    let closed = false;
    const close = async (): Promise<void> => {
      closed = true;
      const errors = await launched.close();
      for (const recording of launched.videos()) await seat.video(recording);
      if (errors.length === 0) return;
      const thrown = errors.map((error) => new E2EError(error.category, error.code, `actor "${name}": ${error.message}`));
      throw new AggregateError(thrown, thrown.map((error) => error.message).join('; '));
    };
    /** Cuts the actor's steps the way the test's timeout does, and says whether they ended within the cleanup budget. */
    const cut = (): Promise<boolean> => {
      this.options.cut();
      return withTimeout(launched.steps.idle(), config.cleanupTimeout, () => new InfrastructureError('CLEANUP_TIMEOUT', `a step of actor "${name}" did not end`)).then(() => true, () => false);
    };
    seat.open({ root: config.projectRoot, busy: () => launched.steps.busy, abandonRunning: () => launched.steps.abandonRunning(), close }, cut);
    const cache = this.options.caches
      ? createAgentCacheContext({
          cache: config.cache, projectRoot: config.projectRoot, projectId: config.projectId, testId: test.id,
          target: targetIdentity(actor.target), attemptIndex: this.options.attemptIndex, recordings: this.options.recordings, actor: name,
        })
      : undefined;
    return { actor, sessions, attempt: launched, cache, steps: seat.steps, closed: () => closed, fixtures: undefined };
  }
}
