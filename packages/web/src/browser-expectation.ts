/**
 * The `expect(browser)` matchers: URL and title polling, and the locator
 * matchers (`toHaveClass`, `toHaveCSS`, `toHaveJSProperty`) that sample the
 * one node a locator matches through `context.withNode`.
 */

import { isDeepStrictEqual } from 'node:util';
import type { JsonValue, Locator } from '@e2e-dev/core';
import {
  compareText,
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  pollCondition,
  rejectUnknownOptions,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  withTimeout,
  type EngineFixtureContext,
  type NodeRef,
  type OperationContext,
  type PollReads,
  type SemanticNode,
} from '@e2e-dev/core/engine';
import type { BrowserExpectation } from './browser.ts';
import { pageFunctionSource, type EvaluationResult } from './evaluation.ts';
import { isTestErrorCode } from './support.ts';

/** What the matchers read the page through. */
export interface ExpectationDeps {
  /** The page URL, read within `timeoutMs`. */
  currentUrl(timeoutMs: number): Promise<string>;
  /** The page title, read within `timeoutMs`. */
  currentTitle(timeoutMs: number): Promise<string>;
  /**
   * Runs the engine's own read-only page code on the node `ref` names. A
   * navigation while it runs re-resolves the node and runs it again.
   */
  readNode(
    ref: NodeRef,
    source: string,
    arg: JsonValue,
    operation: OperationContext,
  ): Promise<EvaluationResult>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined, api: string): Deadline;
  readonly context: EngineFixtureContext;
}

/**
 * The expected URL as `toHaveURL` compares it: a string resolved against the
 * base, the way `urlMatches` resolves it, so it reads beside the absolute
 * observed URL. A string that does not parse, and a RegExp, print as written.
 */
function describeExpectedUrl(expected: string | RegExp, baseHref: string): string {
  if (typeof expected !== 'string') return String(expected);
  try {
    return new URL(expected, baseHref).href;
  } catch {
    return expected;
  }
}

/**
 * One read of a browser matcher poll: whether the condition holds
 * (undefined: not evaluable yet), and what was seen.
 */
interface BrowserSample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/** The sample of a locator matcher while its target matches nothing. */
const NO_NODE: BrowserSample = { matches: undefined, observed: 'no node' };

/**
 * `expect(browser)` matchers: URL, title, class, CSS, and DOM property
 * polling against the assertion budget. Every read runs through the poll's
 * `reads.read`, bounded by its deadline and timed, so a page that stops
 * answering ends the assertion at its own timeout, and a read the deadline
 * cuts off fails the assertion with the last read it saw.
 */
export function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  /** A matcher as its messages name it: `expect.toHaveCSS`, `expect.not.toHaveCSS`. */
  const qualified = (api: string): string => `expect.${negated ? 'not.' : ''}${api}`;
  const poll = async (
    api: string,
    label: string,
    read: (reads: PollReads) => Promise<BrowserSample>,
    timeout: number | undefined,
  ): Promise<void> => {
    const deadline = deps.deadlineFor(timeout, api);
    // pollCondition calls onTimeout only after a read completed, so a sample is always there.
    let last: BrowserSample | undefined;
    await pollCondition({
      deadline,
      signal: deps.context.signal,
      negated,
      evaluate: async (reads) => {
        last = await read(reads);
        return last.matches;
      },
      onTimeout: (cause) => {
        const expected = `${negated ? 'not ' : ''}${label}`;
        return new TestError(
          'ASSERTION_FAILED',
          `${qualified(api)} failed\nexpected: ${expected}\nobserved: ${last?.observed ?? 'nothing'}`,
          cause === undefined ? undefined : { cause },
        );
      },
    });
  };
  const validate = (api: string, options: object | undefined, keys: readonly string[] = ['timeout']): void =>
    rejectUnknownOptions(qualified(api), options, keys);
  /** The name a matcher's string argument is, refused unless it is a nonempty string. */
  const requireName = (api: string, what: string, value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `${qualified(api)} ${what} must be a nonempty string`,
      );
    }
    return value;
  };
  /**
   * The poll read of a matcher on the one node `target` matches: one
   * `context.withNode` that does not wait for a match, run through the poll's
   * `reads.read`. It refuses a target that is not this attempt's locator before
   * any read, and a secure field or an ambiguous match at once. Zero matches
   * is `no node`, one more poll, so a node that never arrives stays an
   * assertion failure; a read the deadline cuts off is the poll's to judge.
   */
  const sampleNode = (
    api: string,
    subject: string,
    target: Locator,
    read: (ref: NodeRef, operation: OperationContext, node: SemanticNode) => Promise<BrowserSample>,
  ): ((reads: PollReads) => Promise<BrowserSample>) =>
    async (reads) => {
      try {
        return await reads.read((timeoutMs) =>
          withTimeout(
            deps.context.withNode(qualified(api), target, read, { timeout: timeoutMs, wait: false }),
            timeoutMs,
            () =>
              new EngineError('OPERATION_TIMEOUT', `${subject} read timed out`, { retryable: false }),
          ),
        );
      } catch (error) {
        if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return NO_NODE;
        throw error;
      }
    };
  /**
   * A matcher sample of the page code `source` run on the one node `target`
   * matches, observed as `subject` and its JSON. A value that is not JSON,
   * or none, never matches.
   */
  const sampleJson = (
    api: string,
    subject: string,
    target: Locator,
    source: string,
    arg: JsonValue,
    matches: (value: JsonValue) => boolean,
  ): ((reads: PollReads) => Promise<BrowserSample>) =>
    sampleNode(api, subject, target, async (ref, operation) => {
      const read = await deps.readNode(ref, source, arg, operation);
      if (!read.ok) return { matches: false, observed: `${subject} is not JSON` };
      const { value } = read;
      if (value === undefined) return { matches: false, observed: `${subject} is undefined` };
      return { matches: matches(value), observed: `${subject} ${JSON.stringify(value)}` };
    });
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      validate('toHaveURL', options, ['ignoreCase', 'timeout']);
      const ignoreCase = options?.ignoreCase;
      if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
        throw new TestError('INVALID_ARGUMENT', `${qualified('toHaveURL')} option ignoreCase must be a boolean`);
      }
      const target = deps.baseHref();
      return poll(
        'toHaveURL',
        `URL ${describeExpectedUrl(expected, target)}${ignoreCase === true ? ' (ignoring case)' : ''}`,
        async (reads) => {
          const url = await reads.read((timeoutMs) => deps.currentUrl(timeoutMs));
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
        async (reads) => {
          const title = await reads.read((timeoutMs) => deps.currentTitle(timeoutMs));
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        },
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      validate('toHaveClass', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        sampleNode('toHaveClass', 'class', target, async (_ref, _operation, node) => {
          const value = node.attributes?.['class'];
          if (value === undefined) return { matches: false, observed: 'no class attribute' };
          return {
            matches: matchesText(value, pattern),
            observed: `class ${JSON.stringify(value)}`,
          };
        }),
        options?.timeout,
      );
    },
    toHaveCSS(target, property, expected, options) {
      validate('toHaveCSS', options);
      const name = requireName('toHaveCSS', 'property', property);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveCSS',
        `css ${name} ${describePattern(pattern)}`,
        sampleJson('toHaveCSS', `css ${name}`, target, COMPUTED_STYLE_SOURCE, name,
          (value) => compareText(String(value), pattern, { mode: 'equals', normalize: false })),
        options?.timeout,
      );
    },
    toHaveJSProperty(target, path, expected, options) {
      validate('toHaveJSProperty', options);
      const name = requireName('toHaveJSProperty', 'path', path);
      const what = `${qualified('toHaveJSProperty')} expected value`;
      if (expected === undefined) {
        throw new TestError('INVALID_ARGUMENT', `${what} must be JSON, found undefined`);
      }
      validateJsonValue(expected, what);
      // The page's value crosses a JSON boundary, so the expected value does
      // too: `-0` reads as `0`.
      const wanted: unknown = JSON.parse(JSON.stringify(expected));
      return poll(
        'toHaveJSProperty',
        `property ${name} ${JSON.stringify(expected)}`,
        sampleJson(
          'toHaveJSProperty',
          `property ${name}`,
          target,
          PROPERTY_PATH_SOURCE,
          name.split('.'),
          (value) => isDeepStrictEqual(value, wanted),
        ),
        options?.timeout,
      );
    },
  };
}

/**
 * Page code for `toHaveCSS`: one computed property of the element, as
 * `getPropertyValue` reads it, so a custom `--property` works too.
 */
const COMPUTED_STYLE_SOURCE = pageFunctionSource((element: Element, name: string) =>
  element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(name) ?? '',
);

/**
 * Page code for `toHaveJSProperty`: the value at a path on the element,
 * given as its keys, split in Node so a page that replaces
 * `String.prototype.split` cannot change the walk. Every key but the last is
 * read off a non-null object, or the value is `undefined`; the last key is
 * then read off whatever the walk reached, so `value.length` reads a
 * string's length. Playwright throws instead on a `null` before the last
 * key, or an `undefined` just before it.
 */
const PROPERTY_PATH_SOURCE = pageFunctionSource((element: Element, names: string[]) => {
  let target: unknown = element;
  for (let index = 0; index < names.length - 1; index += 1) {
    if (typeof target !== 'object' || target === null) return undefined;
    target = (target as Record<string, unknown>)[names[index]!];
  }
  if (target === null || target === undefined) return undefined;
  return (target as Record<string, unknown>)[names[names.length - 1]!];
});

/**
 * The step label for a `toHaveJSProperty` expected value. It is built before
 * the matcher validates the value, so a value `JSON.stringify` refuses (a
 * BigInt, a cycle) or writes as `null` (`NaN`) still gets its own label and
 * then fails as `INVALID_ARGUMENT`.
 */
export function expectedLabel(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return 'a value that is not JSON';
  }
}

