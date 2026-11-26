/**
 * An operation's budget: the gate every input passes, the bound around a
 * whole call, and the shorter deadline a wait inside it gives up at.
 */

import { Deadline, EngineError, raceAbort, withTimeout, type OperationContext } from '@e2e-dev/core/engine';
import { translate } from './errors.ts';

/** An operation's input gate: throws once the operation ended, and holds the operation's deadline. */
export interface InputGate {
  (): void;
  readonly deadline: Deadline;
}

/**
 * The check every input an operation sends passes first: once the
 * operation's budget is spent or it was cancelled, its caller stopped
 * waiting, and nothing more may reach the app.
 */
export function inputGate(operation: OperationContext, label: string): InputGate {
  const deadline = new Deadline(operation.timeoutMs);
  const gate = (): void => {
    if (operation.signal.aborted) throw new EngineError('CANCELLED', `${label} was cancelled`, { retryable: false });
    if (deadline.expired()) throw new EngineError('OPERATION_TIMEOUT', `${label} timed out after ${operation.timeoutMs}ms`, { retryable: false });
  };
  return Object.assign(gate, { deadline });
}

/**
 * The deadline a wait inside an operation gives up at: a little before the
 * operation's own, so the wait reports what it waited for rather than a bare
 * timeout.
 */
export function waitDeadline(operation: OperationContext): Deadline {
  return new Deadline(Math.max(0, operation.timeoutMs - Math.min(250, operation.timeoutMs / 10)));
}

/**
 * Runs `work` within the operation's budget and signal, failures translated.
 * `committed` says whether input may have reached the app, read when the
 * failure is: an action that sends input part-way passes a getter.
 */
export async function bounded<T>(operation: OperationContext, label: string, committed: boolean | (() => boolean), work: () => Promise<T>): Promise<T> {
  try {
    return await raceAbort(
      () => withTimeout(work(), Math.max(1, operation.timeoutMs), () => new EngineError('OPERATION_TIMEOUT', `${label} timed out after ${operation.timeoutMs}ms`, { retryable: false })),
      operation.signal,
      label,
    );
  } catch (cause) {
    throw translate(cause, label, typeof committed === 'boolean' ? committed : committed());
  }
}
