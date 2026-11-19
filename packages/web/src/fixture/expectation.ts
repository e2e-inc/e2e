/**
 * `expect(browser)`: the URL, title, and class matchers, polled against the
 * assertion budget.
 */

import type { Locator } from '@e2e-dev/core';
import {
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  pollCondition,
  rejectUnknownOptions,
  stepTimeout,
  TestError,
  toTextPattern,
  urlMatches,
  withTimeout,
  type EngineFixtureContext,
} from '@e2e-dev/core/engine';
import { isTestErrorCode } from '../errors.ts';
import { baseHref } from './arguments.ts';
import type { BrowserExpectation } from './types.ts';

/** What the matchers read the page through, and the attempt whose assertion budget they poll within. */
export interface ExpectationDeps {
  currentUrl(deadline: Deadline): Promise<string>;
  currentTitle(deadline: Deadline): Promise<string>;
  readonly context: EngineFixtureContext;
}

/**
 * The expected URL as `toHaveURL` compares it: a string resolved against the
 * base, the way `urlMatches` resolves it, so it reads beside the absolute
 * observed URL. A string that does not parse (a relative one with no base),
 * and a RegExp, print as written.
 */
function describeExpectedUrl(expected: string | RegExp, base: string | undefined): string {
  if (typeof expected !== 'string') return String(expected);
  try {
    return new URL(expected, base).href;
  } catch {
    return expected;
  }
}

/** One read of a browser matcher poll: whether the condition holds (undefined: not evaluable yet), and what was seen. */
interface BrowserSample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/**
 * `expect(browser)` matchers: URL, title, and class polling against the
 * assertion budget. Every read is bounded by the poll's deadline, so a page
 * that stops answering ends the assertion at its own timeout, and the
 * failure reports the last read instead of reading a hung page again.
 */
export function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  const poll = async (
    api: string,
    label: string,
    read: (deadline: Deadline) => Promise<BrowserSample>,
    timeout: number | undefined,
  ): Promise<void> => {
    const deadline = new Deadline(deps.context.operation(stepTimeout(timeout, api) ?? deps.context.timeouts.assertion).timeoutMs);
    // pollCondition calls onTimeout only after a read completed, so a sample is always there.
    let last: BrowserSample | undefined;
    await pollCondition({
      deadline,
      signal: deps.context.signal,
      negated,
      evaluate: async () => {
        last = await read(deadline);
        return last.matches;
      },
      onTimeout: (cause) =>
        new TestError(
          'ASSERTION_FAILED',
          `expect.${negated ? 'not.' : ''}${api} failed\nexpected: ${negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`,
          cause === undefined ? undefined : { cause },
        ),
    });
  };
  const validate = (api: string, options: object | undefined, keys: readonly string[] = ['timeout']): void =>
    rejectUnknownOptions(`expect.${negated ? 'not.' : ''}${api}`, options, keys);
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      validate('toHaveURL', options, ['ignoreCase', 'timeout']);
      const ignoreCase = options?.ignoreCase;
      if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
        throw new TestError('INVALID_ARGUMENT', `expect.${negated ? 'not.' : ''}toHaveURL option ignoreCase must be a boolean`);
      }
      const target = baseHref(deps.context);
      return poll(
        'toHaveURL',
        `URL ${describeExpectedUrl(expected, target)}${ignoreCase === true ? ' (ignoring case)' : ''}`,
        async (deadline) => {
          const url = await deps.currentUrl(deadline);
          return { matches: urlMatches(url, expected, target, ignoreCase), observed: `URL ${url}` };
        },
        options?.timeout,
      );
    },
    toHaveTitle(expected, options) {
      validate('toHaveTitle', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveTitle',
        `title ${describePattern(pattern)}`,
        async (deadline) => {
          const title = await deps.currentTitle(deadline);
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        },
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      validate('toHaveClass', options);
      const pattern = toTextPattern(expected, { exact: true });
      let seen: BrowserSample | undefined;
      const sample = (value: string | null | undefined): BrowserSample => {
        if (value === undefined) return { matches: undefined, observed: 'no node' };
        if (value === null) return { matches: false, observed: 'no class attribute' };
        return { matches: matchesText(value.trim().split(/\s+/).join(' '), pattern), observed: `class ${JSON.stringify(value)}` };
      };
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        async (deadline) => {
          const cutOff = new EngineError('OPERATION_TIMEOUT', 'class read timed out', { retryable: false });
          let value: string | null | undefined;
          try {
            // A locator read takes the action timeout; the poll's deadline is the tighter bound.
            value = await withTimeout(readClass(target), deadline.remaining(), () => cutOff);
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return (seen = { matches: undefined, observed: 'no node' });
            // The deadline cut this read off: the poll ends on what the read before it saw.
            if (error === cutOff && seen !== undefined) return seen;
            throw error;
          }
          return (seen = sample(value));
        },
        options?.timeout,
      );
    },
  };
}

/**
 * The class attribute of one match, `undefined` while nothing matches. A
 * read waits for its match until the action timeout, so the poll samples
 * absence first: a node that never arrives stays an assertion failure.
 */
async function readClass(target: Locator): Promise<string | null | undefined> {
  if ((await target.count()) === 0) return undefined;
  return target.getAttribute('class');
}
