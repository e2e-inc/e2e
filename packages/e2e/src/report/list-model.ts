/**
 * State the list reporter accumulates from the event stream, shared with the
 * live tree that paints the running part of it. Records, not rendered text:
 * each consumer renders at its own indent and width when it prints.
 */

import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { RecordedModel } from '@e2e-dev/core/lib/cache/trace';
import type { SerializedError } from '@e2e-dev/core/lib/internal/errors';
import type { RunEventOf } from '../run/events.ts';
import type { StepActivity, StepEvent, StepKind, StepProgress } from '@e2e-dev/core/lib/run/steps';
import type { AiUsage } from './format.ts';

/** Step events worth a glance in the live window; polls and policy decisions stay quiet. */
export type ShownEvent = StepEvent & { readonly kind: 'model' | 'engine' };

/** Whether an event is one the live window shows. */
export function isShownEvent(event: StepEvent): event is ShownEvent {
  return event.kind === 'model' || event.kind === 'engine';
}

/** A step of a pair as every row of it names it. */
export interface StepCall {
  readonly api: string;
  readonly label: string;
  /** The session the step runs on when it is not the test's own. */
  readonly actor: string | undefined;
  /** Only an agent step has model turns to wait on; a `step` is a `test.step`, which its title alone names. */
  readonly kind: StepKind;
  /**
   * The attempt index, then the step indexes of the `test.step` calls around
   * the step, then its own. Steps list in path order, so each follows the
   * `test.step` it ran in however their ends interleave. Undefined in a
   * stream without step identity.
   */
  readonly path: readonly number[] | undefined;
  /** The titles of the `test.step` calls the step runs inside, outermost first. */
  readonly groups: readonly string[];
}

/** A step a running pair has started and not yet ended. */
export interface CurrentStep extends StepCall {
  /**
   * Model turns and tool calls in stream order. A tool-using executor
   * reports a turn once its tools ran, so the turn follows them here; its
   * `startedAt` still carries the moment the request went out.
   */
  readonly events: ShownEvent[];
  /**
   * True while the trace cache has the step, replaying its recorded actions:
   * no model is in the loop, so the wait between events is on the app.
   */
  replaying: boolean;
  /**
   * What the step waits on since its last event: a screen being read, an
   * action landing. Cleared by the event that reports the phase's end, so
   * with nothing announced the model is the one working.
   */
  activity: StepActivity | undefined;
}

/** The step the live window shows for a pair: the call it started last of those still open. An open `test.step` has its own row among the listed steps. */
export function currentStep(test: RunningTest): CurrentStep | undefined {
  let last: CurrentStep | undefined;
  for (const step of test.open.values()) {
    if (step.kind !== 'step') last = step;
  }
  return last;
}

/** How a step ended, as its `end` progress reported it. */
export type StepOutcome = Pick<Extract<StepProgress, { phase: 'end' }>, 'status' | 'durationMs' | 'modelCalls'>;

/** A step listed under its test. Only a `test.step` is listed before it ends, so the steps inside it follow it: it has no outcome until then. */
export interface ListedStep extends StepCall {
  readonly outcome: StepOutcome | undefined;
}

export type FinishedStep = ListedStep & { readonly outcome: StepOutcome };

export function isFinished(step: ListedStep): step is FinishedStep {
  return step.outcome !== undefined;
}

/** Whether a step of this kind is listed under its test in the scrollback: an agent step or a `test.step`. Other steps are fast and many. */
export function listsUnderTest(kind: StepKind): boolean {
  return kind === 'agent' || kind === 'step';
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length && at < b.length; at += 1) {
    if (a[at] !== b[at]) return a[at]! - b[at]!;
  }
  return a.length - b.length;
}

/** Lists `step` in path order, in place of the running `test.step` it ends. A step without a path goes last. */
export function listStep(steps: ListedStep[], step: ListedStep): void {
  const { path } = step;
  const at = path === undefined ? -1 : steps.findIndex((listed) => listed.path !== undefined && comparePaths(listed.path, path) >= 0);
  if (at === -1 || path === undefined) steps.push(step);
  else steps.splice(at, comparePaths(steps[at]!.path ?? [], path) === 0 ? 1 : 0, step);
}

/** A pair that has started and whose result is still to come. */
export interface RunningTest {
  readonly group: FileGroup;
  /** The pair's serial group, when it belongs to one. */
  readonly serialId: string | undefined;
  /** The pair's agent and repeat: each runs a serial group of its own. */
  readonly agent: string | undefined;
  readonly repeat: number | undefined;
  readonly title: string;
  readonly startedMs: number;
  /**
   * False once a later serial member replaced this one: it has finished
   * executing, but its result only arrives with the whole group.
   */
  executing: boolean;
  /**
   * Steps started and not yet ended, by step id, oldest first. A step can
   * open inside another (an `onAction` hook's screenshot inside an act) or
   * beside it (`Promise.all`), so each phase updates the step it names.
   */
  readonly open: Map<string, CurrentStep>;
  /**
   * The attempt whose steps `open` holds. A retry starts no new pair, and a
   * step of a timed-out attempt may never end.
   */
  attemptId: string | undefined;
  /**
   * That attempt's index. The body of a timed-out attempt keeps running, so
   * it can start a step after the retry began; a step of an older attempt is
   * not shown.
   */
  attemptIndex: number | undefined;
  /**
   * Agent steps and `test.step` calls across every attempt, in the order
   * they started. Shown under the test in the live window while it runs,
   * nested under its line in the file block once it is done.
   */
  readonly steps: ListedStep[];
  /**
   * In an `e2e run --step` run, every step, agent or not, in the order they
   * started: the live window lists them above the prompt instead of `steps`.
   * Undefined in any other run.
   */
  readonly ran: ListedStep[] | undefined;
}

/** A running test that waits for a person, with its `paused` event. */
export interface PausedTest {
  readonly test: RunningTest;
  readonly event: RunEventOf<'paused'>;
}

/** The model and agent named in the run header. */
export interface ConfiguredModel {
  readonly label: string;
  readonly agent: string;
}

/** One recording mismatch, rendered with its test's finished steps. */
export interface ReplayNotice {
  readonly api: string;
  readonly label: string;
  readonly source: RecordedModel;
}

/** One finished pair, held until its file's block prints. */
export interface TestLine {
  readonly title: string;
  /** Source order within the file; blocks list tests as declared, not as finished. */
  readonly declarationIndex: number;
  readonly status: ResultStatus;
  readonly durationMs: number;
  readonly usage: AiUsage;
  readonly firstErrorLine: string | undefined;
  readonly skipReason: string | undefined;
  /** Set when a test marked `test.fail` passed by failing: the reason and the first line of the failure it covered. */
  readonly expectedFailure?: { readonly reason: string; readonly errorLine: string } | undefined;
  /** Cleanup-phase secondary errors of attempts whose cleanup failed. */
  readonly cleanupErrors: readonly SerializedError[];
  readonly steps: readonly FinishedStep[];
  readonly replays: readonly ReplayNotice[];
}

/**
 * Every pair of one test file on one target: vitest's "test module". Its
 * block prints once all planned results are in, so files never interleave.
 * Counts, durations, and usage derive from `lines`, so there is one source.
 */
export interface FileGroup {
  readonly file: string;
  readonly target: string;
  /** Reportable pairs the plan announced; undefined until the plan arrives. */
  planned: number | undefined;
  readonly lines: TestLine[];
  printed: boolean;
}

/** The setup step in flight, ticking in the live window: `starting service "postgres"`, `preparing web engine for target "web"`. */
export interface SetupInFlight {
  readonly verb: string;
  readonly subject: string;
  readonly startedMs: number;
}
