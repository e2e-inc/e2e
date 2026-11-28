/**
 * Per-attempt cache context.
 *
 * Built by the runner once per attempt and handed to the agent tier: the
 * resolved store, key derivation over the attempt's fixed identity, and the
 * staging ground for trace writes. Replay is eligible only on a first attempt
 * — a retry exists because something already went wrong, so it runs fresh and
 * re-records — unless `cache.strict` is on. A strict run treats the store as
 * the reviewed source of truth: every attempt replays, and nothing is written
 * or evicted, whatever the configured mode.
 */

import type { CacheStrictSource, ResolvedCacheConfig } from '../config/resolve.ts';
import { canonicalJson } from '../internal/ids.ts';
import { displayPath, insideProjectRoot } from '../internal/paths.ts';
import { REPLAY_POLICY_VERSION } from './relocate.ts';
import {
  buildTraceCacheKey,
  createCallIndexer,
  keyContext,
  projectIdentity,
  traceCacheKeyHash,
  traceCallSignature,
  type CacheAgentIdentity,
  type CacheTargetIdentity,
  type TraceCacheKind,
  type TraceCallSignature,
} from './identity.ts';
import type { StoredRecordings } from './rekeyed.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES, type CacheStore } from './store.ts';
import type { ActionTrace, TraceKeyContext, TraceProvenance } from './trace.ts';
import type { JsonValue } from '../types.ts';

/**
 * One cache entry held back until the attempt confirms or implicates it: a
 * recording to write, or an entry the step replayed whole to keep as it
 * stands. A kept entry carries no payload, so the replay's expansion of it
 * (every `unique()` slot filled with this run's value) can never be written;
 * confirmed, the file keeps its bytes and `createdAt`, and a committed cache
 * directory stays clean, but for the provenance the replay proved, which
 * `completeProvenance` writes in. Unconfirmed, both kinds are evicted alike.
 */
export type StagedTrace = {
  readonly keyHash: string;
  /** Index of the step in the attempt's step timeline. */
  readonly stepIndex: number;
  /**
   * The step's provenance redacted again when the attempt settles. A secret
   * the run learns after the step (a provider credential a later fill
   * resolves) can be in the instruction, params, or test id the entry shows,
   * and is masked in what is written; absent, the provenance staged stands.
   */
  readonly settledProvenance?: () => TraceProvenance;
} & (
  | { readonly kind: 'write'; readonly trace: ActionTrace }
  | { readonly kind: 'keep'; readonly recordedFor: TraceProvenance }
  /** What the step decided itself when it concluded: it evicted its entry, or had nothing to record. */
  | { readonly kind: 'decided'; readonly outcome: 'evicted' | 'no-change' }
);

/** One step's claimed key: its hash, and the step it names as an entry records it. */
export interface ClaimedKey {
  readonly keyHash: string;
  /** The key's parts outside the step, recorded with the entry so a later key change can be named. */
  readonly context: TraceKeyContext;
  /** The step's identity before redaction; the recorder redacts it on the way to disk. */
  readonly step: TraceProvenance;
}

export interface AgentCacheContext {
  /** The configured mode, except that `cache.strict` is always `read-only`. */
  readonly mode: 'read-only' | 'read-write';
  readonly store: CacheStore;
  /** Whether this attempt may replay; writes are governed by `mode` alone. */
  readonly replayEligible: boolean;
  /**
   * A recording that no longer replays fails its step (`REPLAY_STALE`)
   * instead of handing it to the executor, with `advice` on how to re-record
   * it: the knobs to turn off and where the entry lives. `recordings`, set
   * when the store can be listed, finds the recording of a step whose key
   * changed under it, which is stale too rather than missing.
   */
  readonly strict: false | { readonly advice: string; readonly recordings?: StoredRecordings };
  /**
   * Claims one step's key. Not a pure derivation: each claim advances
   * the per-attempt occurrence index for its agent and signature, which is
   * what lets a test repeat the same instruction and cache each occurrence
   * separately.
   * Exactly one claim per dispatched step, in execution order — the
   * `StepTraceSession` constructor is the sole caller and owns that
   * invariant structurally.
   */
  claimKey(
    kind: TraceCacheKind,
    instruction: string,
    params: Readonly<Record<string, JsonValue>> | undefined,
    agent: CacheAgentIdentity,
  ): ClaimedKey;
  /**
   * Trace writes staged during the attempt. A trace is not trusted the moment
   * its own step passes — the verification step after it is what proves the
   * flow reached the right state. The runner settles at attempt end via
   * `settleStagedTraces`.
   */
  readonly staged: StagedTrace[];
}

/**
 * What became of a step's recording. `saved`: written for the next run.
 * `kept`: the entry it replayed, or one holding the same flow, stays as it
 * is. `unconfirmed`: not saved, because no check passed after the step.
 * `evicted`: the entry was deleted, since it replayed into a failure or a
 * repair. `no-change`: the step passed but changed nothing a replay could
 * check, so there was nothing to record. `not-written`: confirmed, but the
 * store did not write it (the file store, for one, refuses a recording past
 * its size limit).
 */
export type CacheWrite = 'saved' | 'kept' | 'unconfirmed' | 'evicted' | 'no-change' | 'not-written';

/**
 * Whether the store already holds this flow: the same actions, paths, anchors,
 * executor, and provenance. The model's summary, the measured end wait, the
 * key context it was recorded under (which an older entry lacks), and
 * the rule that flagged a gap's typed value (`derived`, which follows how the
 * agent read the value this time) differ between live runs, so a step that
 * runs live each time (it types a value read off the screen) would otherwise
 * rewrite an entry a committed cache directory carries. A replay stops at a
 * gap whatever its rule, which only names the hand-off in the report.
 */
async function holdsSameFlow(store: CacheStore, keyHash: string, trace: ActionTrace): Promise<boolean> {
  const existing = await store.read(keyHash, trace.recordedFor);
  return existing.status === 'hit' && flowOf(existing.entry.payload) === flowOf(trace);
}

/**
 * The part of a trace that decides what a replay does, as canonical JSON.
 * Each action's prose summary is left out too, but for a gap's, which names
 * its tool: the file store keeps none and writes it again from the action
 * when it reads one (`summarizeRecordedAction`), so a stored action and a
 * live one can name the same action in other words. So
 * are the instruction and params the provenance shows a reviewer, which the
 * digests beside them already pin.
 */
function flowOf(trace: ActionTrace): string {
  const { summary: _summary, endWaitMs: _endWaitMs, keyedBy: _keyedBy, recordedBy: _recordedBy, actions, recordedFor, ...flow } = trace;
  const { instruction: _instruction, params: _params, ...step } = recordedFor ?? {};
  return canonicalJson({
    ...flow,
    ...(recordedFor === undefined ? {} : { recordedFor: step }),
    actions: actions.map((action) => {
      // A project-tool gap's summary is where its tool's name lives.
      if (action.name === 'tool') {
        const { derived: _derived, ...gap } = action;
        return gap;
      }
      const { summary: _actionSummary, ...rest } = action;
      return rest;
    }),
  });
}

/**
 * Writes the step's full provenance into a kept entry whose stored provenance
 * lacks the occurrence fields, or whose identity digest is not the step's:
 * missing while the step has one, different, or present while the step has
 * none. Every other entry is left untouched. Its replay proved which step it
 * belongs to, and `cache.strict` matches only entries that say so exactly
 * (`rekeyed.ts`).
 */
async function completeProvenance(store: CacheStore, keyHash: string, recordedFor: TraceProvenance): Promise<void> {
  const existing = await store.read(keyHash, recordedFor);
  if (existing.status !== 'hit') return;
  const stored = existing.entry.payload.recordedFor;
  const complete = stored?.callIndex !== undefined && stored.identityDigest === recordedFor.identityDigest;
  if (!complete) await store.write(keyHash, { ...existing.entry.payload, recordedFor });
}

/** How an attempt ended, as the settlement of its staged entries reads it. */
export interface AttemptSettlement {
  /** Entries staged before this step index were verified, and are confirmed. */
  readonly lastVerifiedStepIndex: number;
  /**
   * Whether the attempt implicates the entries it did not confirm. False when
   * its failure is that no model answered (`isModelUnreachable`), a verdict
   * on the provider and never on the app: unconfirmed entries are then left
   * exactly as they are, neither written nor evicted.
   */
  readonly implicatesUnconfirmed: boolean;
  /**
   * Failures the attempt went on after, which only a program without a test
   * around it does: each settles the entries it found unconfirmed as that
   * failure does, whatever passed later. Entries staged after it are judged
   * by the checks that follow them.
   */
  readonly survived?: readonly SurvivedFailure[];
}

/** One failed step an attempt went on after, and the staged entries it found unconfirmed. */
export interface SurvivedFailure {
  /** The first step index no verification had confirmed when the step failed. */
  readonly from: number;
  /** The failed step's index, the last the failure covers. */
  readonly through: number;
  /** Whether the failure implicates those entries; see `AttemptSettlement.implicatesUnconfirmed`. */
  readonly implicates: boolean;
}

/**
 * Settles the attempt's staged trace writes, and says what became of each
 * step's recording, by step index, for the report to show beside the step's
 * cache mode: what a step decided itself when it concluded, and what the
 * settlement made of the rest. A staged trace is confirmed only
 * when a verification step — a deterministic assertion or an agent judgment
 * (`run/steps.ts`, `StepRunOptions.verifies`) — passed after it: an act's own
 * verdict is the recording executor's opinion of its work, and a later act
 * passing says only that the executor coped with whatever state it found. A
 * passing attempt confirms nothing by itself, so a flow no assertion ever
 * checked is never replayed blind, and a failing attempt confirms exactly
 * what had been verified before the failure landed. An unconfirmed trace is
 * not merely withheld: its entry is evicted, so a cached flow implicated in
 * a failure — or one that was never checked — re-records on the next pass
 * instead of replaying a poisoned state forever, unless the settlement says
 * the failure implicates nothing unconfirmed. An interrupted attempt passes
 * no settlement: interruption implicates nothing, so it writes nothing and
 * evicts nothing. An entry a step replayed whole is staged too,
 * so the same rule evicts it when nothing confirmed it; when something did,
 * it is left exactly as it was found, but for what `completeProvenance`
 * writes in.
 */
export async function settleStagedTraces(context: AgentCacheContext, settlement: AttemptSettlement | undefined): Promise<ReadonlyMap<number, CacheWrite>> {
  const outcomes = new Map<number, CacheWrite>();
  const staged = context.staged.splice(0);
  /** The confirmed new recordings, written together once every entry is settled. */
  const writes: { readonly stepIndex: number; readonly keyHash: string; readonly payload: ActionTrace }[] = [];
  for (const entry of staged) {
    if (entry.kind === 'decided') {
      outcomes.set(entry.stepIndex, entry.outcome);
      continue;
    }
    if (settlement === undefined || context.mode !== 'read-write') continue;
    const failure = settlement.survived?.find((survived) => entry.stepIndex >= survived.from && entry.stepIndex <= survived.through);
    const confirmed = failure === undefined && entry.stepIndex < settlement.lastVerifiedStepIndex;
    try {
      if (!confirmed) {
        // A kept entry existed for certain, so deleting it is an eviction; a
        // new recording's delete only clears what an earlier run may have left.
        const deletes = (failure?.implicates ?? settlement.implicatesUnconfirmed) && context.store.delete !== undefined;
        const step = entry.kind === 'keep' ? entry.recordedFor : entry.trace.recordedFor;
        const deleted = deletes && await context.store.delete!(entry.keyHash, step).then(() => true, () => false);
        outcomes.set(entry.stepIndex, entry.kind === 'keep' && deleted ? 'evicted' : 'unconfirmed');
        continue;
      }
      const settled = entry.settledProvenance?.();
      if (entry.kind === 'keep') {
        outcomes.set(entry.stepIndex, 'kept');
        await completeProvenance(context.store, entry.keyHash, settled ?? entry.recordedFor);
        continue;
      }
      const trace = settled === undefined ? entry.trace : { ...entry.trace, recordedFor: settled };
      if (await holdsSameFlow(context.store, entry.keyHash, trace)) {
        outcomes.set(entry.stepIndex, 'kept');
        continue;
      }
      // Its outcome takes its place among the steps' now, and its answer once the writes are done.
      outcomes.set(entry.stepIndex, 'not-written');
      writes.push({ stepIndex: entry.stepIndex, keyHash: entry.keyHash, payload: trace });
    } catch {
      // The cache is disposable; a failed flush is a slower next run only.
      if (entry.kind === 'write' && confirmed) outcomes.set(entry.stepIndex, 'not-written');
    }
  }
  for (const [index, written] of (await writeRecordings(context.store, writes)).entries()) {
    outcomes.set(writes[index]!.stepIndex, written === undefined ? 'not-written' : 'saved');
  }
  return outcomes;
}

/**
 * Writes the settled recordings: the file store all of a test's at once,
 * as one rewrite of its pair, and any other store one at a time. Each
 * write's answer, undefined for one not written.
 */
async function writeRecordings(store: CacheStore, writes: readonly { readonly keyHash: string; readonly payload: ActionTrace }[]): Promise<readonly ({ bytes: number } | undefined)[]> {
  if (store instanceof FileCacheStore) return store.writeAll(writes).catch(() => writes.map(() => undefined));
  const answers: ({ bytes: number } | undefined)[] = [];
  for (const { keyHash, payload } of writes) {
    // A store's write may throw before it returns a promise; that write is not written, and the rest still go.
    try {
      answers.push(await store.write(keyHash, payload));
    } catch {
      answers.push(undefined);
    }
  }
  return answers;
}

/**
 * Builds one attempt's cache context, or undefined when the cache is off.
 * A configured custom store replaces the file store wholesale — that is the
 * seam a cloud-shared store (Redis, an API) plugs into. Its hits are
 * re-validated at the one read site (`StepTraceSession.begin`), like
 * every other store's.
 */
export function createAgentCacheContext(options: {
  readonly cache: ResolvedCacheConfig;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly attemptIndex: number;
  /** Where `cache.strict` looks for a step's recording under another key (`storedRecordingsFor`): the test's pair, read on each miss. */
  readonly recordings?: StoredRecordings | undefined;
}): AgentCacheContext | undefined {
  if (options.cache.mode === 'off') return undefined;
  const strict = options.cache.strict !== false;
  const mode = strict ? 'read-only' : options.cache.mode;
  const store =
    options.cache.store ??
    new FileCacheStore({
      directory: options.cache.dir,
      maxBytes: MAX_CACHE_WIRE_BYTES,
      writable: mode === 'read-write',
    });
  const project = projectIdentity(options.projectId);
  // One occurrence count per agent: the agent is part of the key, so another
  // agent's call of the same instruction must not renumber this one's.
  const indexers = new Map<string, ReturnType<typeof createCallIndexer>>();
  const nextCallIndex = (agent: CacheAgentIdentity, signature: TraceCallSignature): number => {
    // Folded like the key folds it (`buildTraceCacheKey`): no context is the empty one.
    const agentKey = canonicalJson([agent.name, agent.context ?? '']);
    const indexer = indexers.get(agentKey) ?? createCallIndexer();
    indexers.set(agentKey, indexer);
    return indexer(signature);
  };
  return {
    mode,
    store,
    replayEligible: strict || options.attemptIndex === 0,
    strict:
      options.cache.strict === false
        ? false
        : {
            advice: staleAdvice(options.cache, options.cache.strict, options.projectRoot),
            ...(options.recordings === undefined ? {} : { recordings: options.recordings }),
          },
    claimKey: (kind, instruction, params, agent) => {
      const signature = traceCallSignature(kind, instruction, params);
      const callIndex = nextCallIndex(agent, signature);
      const key = buildTraceCacheKey({
        project,
        testId: options.testId,
        target: options.target,
        signature,
        callIndex,
        agent,
        policyVersion: REPLAY_POLICY_VERSION,
      });
      return {
        keyHash: traceCacheKeyHash(key),
        context: keyContext(key),
        step: {
          testId: options.testId,
          targetId: options.target.targetId,
          instructionDigest: signature.instructionDigest,
          paramsDigest: signature.paramsDigest,
          callIndex,
          agent: agent.name,
          instruction,
          ...(params === undefined ? {} : { params }),
        },
      };
    },
    staged: [],
  };
}

/**
 * How to re-record a recording `cache.strict` failed on: a read-write run
 * with every knob that turned strict on turned off, and where the new entry
 * lands, as the project names it.
 */
function staleAdvice(cache: ResolvedCacheConfig, source: CacheStrictSource, projectRoot: string): string {
  const off = [
    ...(source.flag ? ['without --strict-cache'] : []),
    ...(source.config ? ['with cache.strict set to false'] : []),
  ].join(' and ');
  const run = `re-record it with a read-write run ${off}`;
  if (cache.store !== undefined) return `${run}; the run writes the new entry to the configured cache.store`;
  const where = displayPath(projectRoot, cache.dir);
  return insideProjectRoot(projectRoot, cache.dir)
    ? `${run} and commit the changed entry under ${where}`
    : `${run}; the run writes the new entry under ${where}`;
}
