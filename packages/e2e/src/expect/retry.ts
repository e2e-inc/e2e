/** Retries for `expect.poll` and `expect(fn).toPass()`. */

import { checkIntervals } from '@e2e-dev/core/lib/config/validate';
import { ConfigurationError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { abortError, cancelledError, Deadline, MAX_TIMER_MS, sleep, withAbort, withTimeout } from '@e2e-dev/core/lib/internal/time';
import type { PollOptions } from '@e2e-dev/core/lib/types';
import { currentAttempt, type PublishedAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { currentPollScope, pollRead, pollReadSignal } from '@e2e-dev/core/lib/expect/poll-scope';

/** Frames kept for the line a poll was called on; the user's line is a few frames up. */
const CALL_STACK_FRAMES = 20;

/** Time for the phase timeout to take precedence if the retry reaches the deadline first. */
const PHASE_TIMEOUT_GRACE_MS = 50;

type RetryContext = Pick<PublishedAttempt, 'budget' | 'recordSecondaryError'>;

type Sample = { readonly value: unknown } | { readonly error: unknown };
type FailedSample = { readonly last: string; readonly cause?: unknown };
type RetryResult = { readonly value: unknown } | FailedSample;

type RetryOptions = {
  readonly api: string;
  readonly label: string;
  readonly timeout: number;
  readonly intervals: readonly number[];
  readonly message: string | undefined;
  readonly noSample: string;
};

/** A read that outlived the deadline, as opposed to one that failed. */
class ReadHung extends Error {}

/** One read, cut at the deadline and at the attempt signal; a hung read's outcome is dropped. */
function sample(
  read: () => unknown,
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<Sample> {
  const cutoff = new AbortController();
  const readSignal = signal === undefined ? cutoff.signal : AbortSignal.any([signal, cutoff.signal]);
  const work = pollRead(async (): Promise<Sample> => {
    try {
      return { value: await read() };
    } catch (error) {
      cutoff.abort();
      return { error };
    }
  }, readSignal);
  const cancellable = signal === undefined ? work : withAbort(work, signal, cancelledError);
  return withTimeout(cancellable, deadline.remaining(), () => {
    cutoff.abort();
    return new ReadHung();
  });
}

/** The stack at a poll's call, for the error that names it when its phase did not await it. */
function callStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Tracks a retry in the current phase and applies the phase deadline to reads and waits. */
export function retry(
  read: () => unknown,
  evaluate: (result: Sample) => RetryResult,
  options: RetryOptions,
  context: RetryContext | undefined,
): Promise<unknown> {
  const scope = currentPollScope() ?? currentAttempt()?.polls;

  const run = async (scopeSignal?: AbortSignal): Promise<unknown> => {
    const { api, label, timeout, intervals, message, noSample } = options;
    const budget = context?.budget;
    const phaseSignal = budget?.signal;
    // The phase that started the poll cancels it when it returns without
    // awaiting it, so the poll can never fail whatever runs after.
    const signals = [phaseSignal, scopeSignal, pollReadSignal()].filter((signal) => signal !== undefined);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    if (signal?.aborted) throw abortError(signal, cancelledError);

    const startedAt = Date.now();
    const own = timeout === 0 ? undefined : new Deadline(timeout, startedAt);
    // Inside an attempt the poll ends with the phase it runs in (the test
    // deadline in the body, the hook's cleanup budget in afterEach) and stops
    // the moment the attempt is cancelled, so a timed-out test never keeps
    // reading through teardown. A timeout of 0 sets no deadline of its own.
    const phase = budget?.deadline;
    /**
     * The poll's own deadline capped by its phase's. A poll without one of its
     * own (`timeout: 0`) waits for the phase's, so it needs a phase to bound it.
     */
    const deadline = own !== undefined && phase !== undefined ? Deadline.min(own, phase) : own ?? phase;
    if (deadline === undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `${api} timeout 0 waits for the test deadline, so it runs only inside a test or hook; pass a positive timeout`);
    }
    let last: FailedSample | undefined;
    let index = 0;
    let interval: number | undefined;

    const assertionFailure = (endedAt: number): TestError => {
      const ending = deadline === own
        ? `timed out after ${timeout} ms`
        : `stopped at the attempt deadline after ${endedAt - startedAt} ms`;
      return new TestError(
        'ASSERTION_FAILED',
        [`${label} ${ending}`, ...(message === undefined ? [] : [message]), `last: ${last?.last ?? noSample}`].join('\n'),
        { cause: last?.cause },
      );
    };

    let endedAt: number | undefined;
    try {
      while (!deadline.expired()) {
        if (signal?.aborted) throw abortError(signal, cancelledError);
        let result: Sample;
        try {
          result = await sample(read, deadline, signal);
        } catch (error) {
          if (signal?.aborted) throw abortError(signal, cancelledError);
          if (error instanceof ReadHung) break;
          throw error;
        }
        if (signal?.aborted) throw abortError(signal, cancelledError);
        const outcome = evaluate(result);
        if ('value' in outcome) return outcome.value;
        last = outcome;
        interval = intervals[index++] ?? interval;
        await sleep(Math.min(interval ?? 0, deadline.remaining()), signal);
      }
      if (signal?.aborted) throw abortError(signal, cancelledError);
      endedAt = Date.now();
      if (deadline !== own) await sleep(PHASE_TIMEOUT_GRACE_MS, signal);
    } catch (error) {
      if (deadline !== own && deadline.expired() && phaseSignal?.aborted === true && last !== undefined) {
        context?.recordSecondaryError?.(assertionFailure(endedAt ?? Date.now()));
      }
      throw error;
    }
    throw assertionFailure(endedAt);
  };

  return scope === undefined ? run() : scope.track(options.label, callStack(), run);
}

/** A malformed option would poll forever; it is refused before the first read. */
export function checkOptions(api: string, options: PollOptions): void {
  const { timeout, intervals } = options;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout >= 0)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${api} timeout must be a finite number of milliseconds, 0 or more; got ${String(timeout)}`,
    );
  }
  if (timeout !== undefined && timeout > MAX_TIMER_MS) {
    throw new ConfigurationError('INVALID_CONFIG', `${api} timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${timeout}`);
  }
  checkIntervals(`${api} intervals`, intervals);
}
