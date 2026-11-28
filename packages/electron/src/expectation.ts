/**
 * `expect(electron)` and `electron.waitForURL`: conditions of the active
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
  withTimeout,
  type EngineFixtureContext,
  type FixtureOperations,
  type Locator,
} from '@e2e-dev/core/engine';
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
    // A dialog nothing answered fails this step, as it fails any other.
    this.surface.failOnDialog();
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
          last = { matches: undefined, observed: last?.observed ?? 'nothing: the window was loading or closing' };
        }
        return last.matches;
      },
      onTimeout: (cause) =>
        new TestError('ASSERTION_FAILED', `${call.name} failed\nexpected: ${call.negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`, cause === undefined ? undefined : { cause }),
    });
  }

  /**
   * Whether a failed read is one a wait goes on through: the document went
   * away under it (a navigation), or the window is closed or not there yet
   * while the app still runs. A read that hangs is the poll's own to judge.
   */
  private passing(cause: unknown): boolean {
    if (!(cause instanceof EngineError)) return false;
    return cause.retryable || (cause.code === 'INVALID_STATE' && this.surface.appRunning);
  }

  private url(call: PollCall, expected: string | RegExp, options: { readonly ignoreCase?: boolean; readonly timeout?: number } | undefined): Promise<void> {
    const ignoreCase = options?.ignoreCase;
    if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') throw new TestError('INVALID_ARGUMENT', `${call.name} option ignoreCase must be a boolean`);
    const pattern = toTextPattern(expected);
    // An Electron target has no base URL, and the window's own moves with the wait: a relative string has nothing to resolve against.
    if (pattern.kind !== 'regexp' && !URL.canParse(pattern.value)) {
      throw new TestError('INVALID_ARGUMENT', `${call.name} takes an absolute URL or a RegExp, not ${JSON.stringify(pattern.value)}: an Electron app has no base URL to resolve it against`);
    }
    // Parsed once, on its own: `https:page` would resolve against a base of the same scheme, and the window's moves.
    const wanted = pattern.kind === 'regexp' ? expected : new URL(pattern.value).href;
    return this.poll(call, `URL ${String(wanted)}${ignoreCase === true ? ' (ignoring case)' : ''}`, () => {
      const url = this.surface.shownWindow().page.url();
      return Promise.resolve({ matches: urlMatches(url, wanted, String(wanted), ignoreCase), observed: `URL ${url}` });
    }, options?.timeout);
  }

  /** `electron.waitForURL()`: the poll `expect(electron).toHaveURL` runs. */
  waitForURL(expected: string | RegExp, options: { readonly timeout?: number } | undefined): Promise<void> {
    rejectUnknownOptions('electron.waitForURL', options, ['timeout']);
    return this.url({ api: 'electron.waitForURL', name: 'electron.waitForURL', negated: false }, expected, options);
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
      toHaveURL: (expected, options) => {
        rejectUnknownOptions(`expect.${negated ? 'not.' : ''}toHaveURL`, options, ['ignoreCase', 'timeout']);
        return this.url(call('toHaveURL'), expected, options);
      },
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
          let value: string | null | undefined;
          try {
            // A locator read takes the action timeout; the poll's deadline is the tighter bound.
            value = await withTimeout(readClass(target), deadline.remaining(), () => new EngineError('OPERATION_TIMEOUT', 'class read timed out', { retryable: false }));
          } catch (cause) {
            if ((cause as { readonly code?: unknown }).code === 'LOCATOR_NOT_FOUND') return { matches: undefined, observed: 'no node' };
            throw cause;
          }
          if (value === undefined) return { matches: undefined, observed: 'no node' };
          // An absent attribute is no class list at all, which '' does not match, as on the web.
          if (value === null) return { matches: false, observed: 'no class attribute' };
          return { matches: matchesText(value.trim().split(/\s+/).join(' '), pattern), observed: `class ${JSON.stringify(value)}` };
        }, timeoutOf('toHaveClass', options));
      },
    };
  }
}

/**
 * The class attribute of one match, undefined while nothing matches. A read
 * waits for its match until the action timeout, so the poll samples absence
 * first: a node that never arrives stays an assertion failure.
 */
async function readClass(target: Locator): Promise<string | null | undefined> {
  if ((await target.count()) === 0) return undefined;
  return target.getAttribute('class');
}

/** How the harness records each matcher: an assertion that owns its deadline. */
export const EXPECTATION_OPERATIONS: FixtureOperations<ElectronExpectation> = {
  toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
  toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
  toHaveClass: { kind: 'assertion', timeout: false, label: (_target, expected) => String(expected) },
  get not() {
    return EXPECTATION_OPERATIONS;
  },
};
