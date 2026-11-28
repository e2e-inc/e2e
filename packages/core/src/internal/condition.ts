/**
 * Reading the condition a test modifier takes: `test.skip(condition, reason)`,
 * `test.skipIf(condition)`, and their siblings.
 */

import { TestError } from './errors.ts';
import { isPromiseLike } from './promise-like.ts';

/**
 * The truthiness of a test modifier's condition. A Promise is always truthy,
 * so an unawaited async check would decide nothing: it throws the error
 * `refuse` builds from the message.
 */
export function readCondition(api: string, condition: unknown, refuse: (message: string) => Error): boolean {
  if (isPromiseLike(condition)) {
    throw refuse(`${api} got a Promise as its condition; await it before the call`);
  }
  return Boolean(condition);
}

/**
 * The truthiness of the condition `test.skip`, `test.fixme`, `test.fail`, or
 * `test.slow` got in a running test or hook, read after the call's own
 * location check. A Promise or a function is always truthy, so either fails
 * with `INVALID_ARGUMENT`. Playwright throws on a function there too.
 */
export function readRunningCondition(api: string, condition: unknown): boolean {
  const refuse = (message: string): TestError => new TestError('INVALID_ARGUMENT', message);
  if (typeof condition === 'function') {
    throw refuse(`${api} got a function as its condition; call it and pass the result`);
  }
  return readCondition(api, condition, refuse);
}
