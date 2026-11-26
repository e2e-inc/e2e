/** Naming a group of calls from inside the running test: `test.step(title, body)`. */

import { currentAttempt } from '../expect/attempt.ts';
import { CollectionError, TestError } from './errors.ts';
import { runningSuiteHook } from './test-timeout.ts';

/**
 * Runs `body` as one named step of the running test and returns what it
 * returns. Where no report takes steps (a `beforeAll` or `afterAll` hook, a
 * hosted session), `body` just runs. Outside a test the call is a
 * collection error.
 */
export async function runTestStep<T>(title: string, body: () => T | Promise<T>): Promise<T> {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', `test.step() title must be a non-empty string, got ${typeof title === 'string' ? 'a blank one' : typeof title}`);
  }
  if (typeof body !== 'function') {
    throw new TestError('INVALID_ARGUMENT', `test.step() takes a function after the title, got ${typeof body}`);
  }
  // A suite hook runs outside any attempt, or on one whose steps no report keeps.
  if (runningSuiteHook() !== undefined) return body();
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError('test.step(title, body) must be called inside a test body, a hook, or a fixture');
  }
  return attempt.step === undefined ? body() : attempt.step(title, body);
}
