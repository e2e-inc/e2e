/**
 * The `expect(browser)` matchers over fake page reads: how a page read the
 * deadline cuts off ends a poll, and the step label of a `toHaveJSProperty`
 * expected value, built before the matcher validates the value, so a value
 * the matcher refuses still has one.
 */

import { describe, expect, it } from 'vitest';
import { Deadline, EngineError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import { createBrowserExpectation, expectedLabel, type ExpectationDeps } from '../../src/browser-expectation.ts';

/**
 * Deps whose URL and title reads answer `value` after 600 ms the first time,
 * then never answer, failing as `OPERATION_TIMEOUT` when their budget ends.
 */
function slowThenHungDeps(value: string): ExpectationDeps {
  let calls = 0;
  const read = (timeoutMs: number): Promise<string> => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => setTimeout(() => resolve(value), 600));
    return new Promise((_, reject) =>
      setTimeout(() => reject(new EngineError('OPERATION_TIMEOUT', 'read timed out', { retryable: false })), timeoutMs));
  };
  return {
    currentUrl: read,
    currentTitle: read,
    readNode: () => Promise.reject(new Error('no node reads here')),
    baseHref: () => 'http://127.0.0.1/',
    deadlineFor: (timeout) => new Deadline(timeout ?? 1000),
    context: { signal: new AbortController().signal } as EngineFixtureContext,
  };
}

describe('createBrowserExpectation', () => {
  it.each([
    ['toHaveTitle', (deps: ExpectationDeps) => createBrowserExpectation(deps).toHaveTitle('Other', { timeout: 1000 }), 'title "Busy"'],
    ['toHaveURL', (deps: ExpectationDeps) => createBrowserExpectation(deps).toHaveURL('/other', { timeout: 1000 }), 'URL Busy'],
  ])('fails %s as an assertion when the deadline cuts off a read slower ones came before', async (_, call, observed) => {
    await expect(call(slowThenHungDeps('Busy'))).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining(`observed: ${observed}`),
    });
  });
});

describe('expectedLabel', () => {
  it('writes a JSON value as JSON', () => {
    expect(expectedLabel({ mode: 'dark', sizes: [1, 2] })).toBe('{"mode":"dark","sizes":[1,2]}');
    expect(expectedLabel('open')).toBe('"open"');
  });

  it('writes a value JSON.stringify drops or turns into null as its own text', () => {
    expect(expectedLabel(undefined)).toBe('undefined');
    expect(expectedLabel(Number.NaN)).toBe('NaN');
    expect(expectedLabel(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('names a value JSON.stringify refuses', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(expectedLabel(1n)).toBe('a value that is not JSON');
    expect(expectedLabel(cyclic)).toBe('a value that is not JSON');
  });
});
