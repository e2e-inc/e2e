/**
 * `expect(electron)` and the fixture's waits: conditions of the active
 * window polled against the assertion timeout, as `expect(browser)` polls a
 * tab's on the web. Each failure reports the last read.
 */

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
  type EngineFixtureContext,
  type FixtureOperations,
  type Locator,
} from '@e2e-dev/core/engine';
import { checkJsonArgument, functionSource } from './evaluate.ts';
import type { ElectronExpectation } from './fixtures.ts';
import type { ElectronSurface } from './surface.ts';

/** One read of a poll: whether the condition holds (undefined: nothing to read yet), and what was seen. */
interface Sample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/** What names one poll: the call its timeout belongs to, and the heading of its failure. */
interface PollCall {
  readonly api: string;
  readonly name: string;
  readonly negated: boolean;
}

export class WindowConditions {
  constructor(
    private readonly surface: ElectronSurface,
    private readonly context: EngineFixtureContext,
  ) {}

  /** Polls `read` until it matches, or fails with the last read once the assertion timeout (or `timeout`) is over. */
  private async poll(call: PollCall, label: string, read: (deadline: Deadline) => Promise<Sample>, timeout: number | undefined): Promise<void> {
    const { context } = this;
    const deadline = new Deadline(context.operation(stepTimeout(timeout, call.api) ?? context.timeouts.assertion).timeoutMs);
    let last: Sample | undefined;
    await pollCondition({
      deadline,
      signal: context.signal,
      negated: call.negated,
      evaluate: async () => {
        try {
          last = await read(deadline);
        } catch (cause) {
          if (!this.passing(cause)) throw cause;
          // What the read before it saw stays what the failure reports: this one saw nothing.
          last = { matches: undefined, observed: last?.observed ?? 'nothing: the window was loading, closing, or did not answer in time' };
        }
        return last.matches;
      },
      onTimeout: (cause) =>
        new TestError('ASSERTION_FAILED', `${call.name} failed\nexpected: ${call.negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`, cause === undefined ? undefined : { cause }),
    });
  }

  /**
   * Whether a failed read is one a wait goes on through: the document or the
   * node went away under it (a navigation, a re-render), the deadline cut it
   * off, or the window is closed or not there yet while the app still runs.
   */
  private passing(cause: unknown): boolean {
    if (!(cause instanceof EngineError)) return false;
    return cause.retryable || cause.code === 'OPERATION_TIMEOUT' || (cause.code === 'INVALID_STATE' && this.surface.appRunning);
  }

  private url(call: PollCall, expected: string | RegExp, timeout: number | undefined): Promise<void> {
    if (typeof expected !== 'string' && !(expected instanceof RegExp)) throw new TestError('INVALID_ARGUMENT', `${call.name} takes a URL string or a RegExp`);
    return this.poll(call, `URL ${String(expected)}`, () => {
      const url = this.surface.shownWindow().page.url();
      // A string is a URL, compared as one and resolved against the window's own: an Electron app has no base URL.
      return Promise.resolve({ matches: urlMatches(url, expected, url), observed: `URL ${url}` });
    }, timeout);
  }

  /** `electron.waitForURL()`: the poll `expect(electron).toHaveURL` runs. */
  waitForURL(expected: string | RegExp, options: { readonly timeout?: number } | undefined): Promise<void> {
    rejectUnknownOptions('electron.waitForURL', options, ['timeout']);
    return this.url({ api: 'electron.waitForURL', name: 'electron.waitForURL', negated: false }, expected, options?.timeout);
  }

  /** `electron.waitForFunction()`: runs `fn` in the active window's page until what it returns is truthy, and returns that. */
  async waitForFunction<R, A>(fn: (arg: A) => R | Promise<R>, arg: A, options: { readonly timeout?: number } | undefined): Promise<R> {
    const caller = 'electron.waitForFunction';
    rejectUnknownOptions(caller, options, ['timeout']);
    // Refused before the wait starts, in the wait's own name.
    checkJsonArgument(arg, caller);
    functionSource(fn, caller);
    let value: R | undefined;
    await this.poll({ api: caller, name: caller, negated: false }, 'a truthy result', async (deadline) => {
      value = await this.surface.evaluateInWindow(this.surface.shownWindow(), fn, arg, this.context.operation(deadline.remaining()), caller);
      return { matches: Boolean(value), observed: `result ${JSON.stringify(value) ?? 'undefined'}` };
    }, options?.timeout);
    return value as R;
  }

  /** The `expect(electron)` matchers, or their negations. */
  expectation(negated = false): ElectronExpectation {
    const call = (api: string): PollCall => ({ api, name: `expect.${negated ? 'not.' : ''}${api}`, negated });
    const timeoutOf = (api: string, options: { readonly timeout?: number } | undefined): number | undefined => {
      rejectUnknownOptions(`expect.${negated ? 'not.' : ''}${api}`, options, ['timeout']);
      return options?.timeout;
    };
    const negate = (): ElectronExpectation => this.expectation(!negated);
    return {
      get not() {
        return negate();
      },
      toHaveURL: (expected, options) => this.url(call('toHaveURL'), expected, timeoutOf('toHaveURL', options)),
      toHaveTitle: (expected, options) => {
        const pattern = toTextPattern(expected, { exact: true });
        return this.poll(call('toHaveTitle'), `title ${describePattern(pattern)}`, async (deadline) => {
          const title = await this.surface.currentTitle(this.surface.shownWindow(), this.context.operation(deadline.remaining()));
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        }, timeoutOf('toHaveTitle', options));
      },
      toHaveClass: (target, expected, options) => {
        const pattern = toTextPattern(expected, { exact: true });
        return this.poll(call('toHaveClass'), `class ${describePattern(pattern)}`, async (deadline) => {
          const value = await this.read(target, 'class', deadline);
          if (value === undefined) return { matches: undefined, observed: 'no node' };
          // An absent attribute is no class list at all, which '' does not match, as on the web.
          if (value === null) return { matches: false, observed: 'no class attribute' };
          return { matches: matchesText(value.trim().split(/\s+/).join(' '), pattern), observed: `class ${JSON.stringify(value)}` };
        }, timeoutOf('toHaveClass', options));
      },
      toHaveCSS: (target, property, expected, options) => {
        if (typeof property !== 'string' || property === '') throw new TestError('INVALID_ARGUMENT', `expect.${negated ? 'not.' : ''}toHaveCSS takes a CSS property name, such as "opacity"`);
        const pattern = toTextPattern(expected, { exact: true });
        return this.poll(call('toHaveCSS'), `${property} ${describePattern(pattern)}`, async (deadline) => {
          const value = await this.read(target, { css: property }, deadline);
          if (value === undefined || value === null) return { matches: undefined, observed: 'no node' };
          return { matches: matchesText(value, pattern), observed: `${property} ${JSON.stringify(value)}` };
        }, timeoutOf('toHaveCSS', options));
      },
    };
  }

  /**
   * The class attribute or a computed style of the one node `target`
   * matches, read from the element itself; undefined while it matches none,
   * which is one more poll. Several matches fail at once.
   */
  private async read(target: Locator, what: 'class' | { readonly css: string }, deadline: Deadline): Promise<string | null | undefined> {
    const expression = this.context.expression(target);
    const nodes = await this.surface.locate(expression, this.context.operation(deadline.remaining()));
    if (nodes.length === 0) return undefined;
    const [node] = nodes;
    if (nodes.length > 1 || node === undefined) throw new TestError('LOCATOR_AMBIGUOUS', `the locator matched ${nodes.length} nodes: expect(electron) reads one`);
    // What is left of the deadline now: the locate before it spent some.
    return await this.surface.readElement(node.ref, what, this.context.operation(deadline.remaining()));
  }
}

const label = (_target: unknown, ...rest: readonly unknown[]): string => rest.filter((part) => typeof part === 'string' || part instanceof RegExp).map(String).join(' ');

/** How the harness records each matcher: an assertion that owns its deadline. */
export const EXPECTATION_OPERATIONS: FixtureOperations<ElectronExpectation> = {
  toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
  toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
  toHaveClass: { kind: 'assertion', timeout: false, label },
  toHaveCSS: { kind: 'assertion', timeout: false, label },
  get not() {
    return EXPECTATION_OPERATIONS;
  },
};
