/**
 * Where an error nothing caught goes when `run_code`'s code made it. The code
 * is ordinary JavaScript in the server's process, so a promise it leaves to
 * reject, or a timer callback that throws, lands on the process and not on
 * the call. Each call runs in its own async context, which those errors
 * carry, so the process's handlers can hand one back to the call it came
 * from and to no other. Kept apart from `run-code.ts` so a process entry can
 * ask without loading the tool.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { classifyError } from '@e2e-dev/core/lib/internal/errors';

/** One call: where its strays go while it runs. */
interface Call {
  tell: ((cause: unknown) => void) | undefined;
}

const calls = new AsyncLocalStorage<Call>();

/** Runs `body` as one call; `tell` is told each error nothing caught until the returned `end` runs. */
export function asRunCodeCall<T>(tell: (cause: unknown) => void, body: () => T): { readonly result: T; readonly end: () => void } {
  const call: Call = { tell };
  return { result: calls.run(call, body), end: () => void (call.tell = undefined) };
}

/**
 * Takes an error nothing in the process caught when a `run_code` call's code
 * made it: the call fails with it while it runs, and `warn` tells the
 * operator of one that came after. False for an error from anywhere else.
 */
export function claimRunCodeStray(cause: unknown, warn: (message: string) => void): boolean {
  const call = calls.getStore();
  if (call === undefined) return false;
  if (call.tell === undefined) warn(`code a run_code call left running failed after the call ended: ${classifyError(cause).message}`);
  else call.tell(cause);
  return true;
}
