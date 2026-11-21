/**
 * The session's `run_code`: JavaScript run against the live app, in the
 * server's own Node process, on the objects a test body gets. `screen`,
 * `app`, `expect`, `credentials`, `secrets`, and the engine's fixtures
 * (`browser`, `device`) are the real ones, so a line waits, matches, and
 * fails as it does in a test, and a line that passes here is one a test can
 * hold. `code-recorder.ts` stands between the code and those objects only to
 * write down the test line each call spells, for the result and
 * `test_lines`.
 *
 * The code has the authority of a test file: nothing confines it. A coding
 * agent that can write a test and run it has that authority already. What
 * comes back still passes the secret ledger, so a configured secret's exact
 * value is not in the result.
 */

import { Script } from 'node:vm';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { z } from 'zod';
import type { StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import type { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import { classifyError, codedMessage, TestError } from '@e2e-dev/core/lib/internal/errors';
import { cancelledError, withAbort, withTimeout } from '@e2e-dev/core/lib/internal/time';
import { createScreen } from '@e2e-dev/core/lib/locator/screen';
import { createScreenContext } from '@e2e-dev/core/lib/run/fixtures';
import type { StandaloneAttempt } from '@e2e-dev/core/lib/run/standalone-attempt';
import { credentialIn, secretIn } from '@e2e-dev/core/lib/secrets';
import type { Credentials, Secrets } from '@e2e-dev/core/lib/types';
import { expect } from '../expect/index.ts';
import { Recorder, type Outcome } from './code-recorder.ts';
import { asRunCodeCall } from './code-strays.ts';

/** How long one screen action or matcher may wait unless the call says otherwise, in milliseconds. */
const RUN_CODE_TIMEOUT_MS = 5_000;
/** The longest a call may let one line wait. */
const MAX_TIMEOUT_MS = 120_000;
/** The longest one call's code may run, waits on the app included. */
const PROGRAM_TIMEOUT_MS = 300_000;
/** The name a syntax error's position is reported against. */
const FILENAME = 'run_code';

/** The parts of the attempt the code's objects are built from. */
type RunCodeAttempt = Pick<StandaloneAttempt, 'agentRuntime' | 'budget' | 'session' | 'runId' | 'attemptId'> & {
  readonly fixtures: Pick<StandaloneAttempt['fixtures'], 'app'>;
};

/** What the session hands `run_code`. */
export interface RunCodeSession {
  /** The fixtures, runtime, and budget for this call on the session's attempt. */
  readonly attempt: (signal: AbortSignal | undefined) => RunCodeAttempt;
  /** The fixtures of the target's engine that the attempt's `fixtures` hold, which the code gets by name. */
  readonly engineFixtures: readonly string[];
}

interface RunCodeOptions extends RunCodeSession {
  /** The session step, observed once the code ran. */
  readonly context: Pick<StepExecutorContext, 'observe'>;
  /** The session's presenter, so the screen comes back as changes since the one the agent holds. */
  readonly screen: Pick<ScreenPresenter, 'update'>;
  /** Told the source of every line that passed and is not a read, in the order they ran, for `test_lines`. */
  readonly record?: ((passed: readonly string[]) => void) | undefined;
  /** Told the code a call failed with, for the session's count of failures by code. */
  readonly onFailed?: ((code: string) => void) | undefined;
}

interface RunCodeArgs {
  readonly code: string;
  readonly timeout?: number | undefined;
}

/** The rendered result, and whether the call failed. */
interface RunCodeResult {
  readonly text: string;
  readonly failed: boolean;
}

/** How the code ended: what it returned or the error that stopped it, and what it logged. */
interface Ended {
  readonly value: unknown;
  readonly error: { readonly code: string | undefined; readonly message: string } | undefined;
  readonly logs: readonly string[];
}

/** What `run_code`'s code may call, as the session's opening and the tool's description both spell it. */
export function runCodeApi(session: RunCodeSession): readonly string[] {
  return [...RUN_CODE_API, ...fixtureNames(session).map((name) => fixtureLine(session, name))];
}

/** One engine fixture and the members it has, read off the fixture itself: core names none of them. */
function fixtureLine(session: RunCodeSession, name: string): string {
  let members: readonly string[] = [];
  try {
    const fixture: unknown = Reflect.get(session.attempt(undefined).fixtures, name);
    if (typeof fixture === 'object' && fixture !== null) members = Object.keys(fixture);
  } catch {
    // A fixture that cannot be built now fails where the code first calls it, with its own error.
  }
  return `${name}: the engine's fixture, as a test body gets it${members.length === 0 ? '' : `: ${members.join(', ')}`}.`;
}

const RUN_CODE_API: readonly string[] = [
  'These are the objects an e2e test body gets; there is no page.',
  "screen: getByRole(role, name?), getByLabel(text), getByText(text), getByPlaceholder(text), getByTestId(id), getByDisplayValue(value), each returning a locator; scrollUntilVisible(locator), swipe({ direction: 'down' }), tapAt({ x, y }), tree().",
  "locator: the same getBy* queries, filter({ has: locator }), or(locator), first(), last(), nth(i); actions tap(), click(), doubleTap(), longPress(), fill(text), pressSequentially(text), clear(), press(key), check(), uncheck(), selectOption(value), hover(), dragTo(locator), scrollIntoView(), swipe({ direction: 'down' }), scrollUntilVisible(locator), waitFor(); reads textContent(), allTextContents(), count(), inputValue(), getAttribute(name), isVisible(), isHidden(), isEnabled(), isDisabled(), isChecked(), boundingBox().",
  'expect(locator): toBeVisible, toBeHidden, toBeEnabled, toBeDisabled, toBeChecked, toHaveText, toContainText, toHaveValue, toHaveAttribute, toHaveCount, toHaveAccessibleName, toHaveRole, with .not. expect(value): toBe, toEqual, toContain, toMatch, toHaveLength, toBeGreaterThan, toBeLessThan, toBeTruthy.',
  'app: open(path?), restart(), clearState(), back().',
  "Secrets: fill(credentials.user('name').password) and fill(secrets.get('name')) fill a configured value; credentials.user('name').username is the username. The names are the ones open_session lists.",
];

function scopeNames(session: RunCodeSession): string {
  return [...BUILT_IN, ...fixtureNames(session)].join(', ') + ', and console';
}

/** The `run_code` catalog tool. */
export function runCodeTool(options: RunCodeOptions): ToolSet[string] {
  return {
    description: [
      `Run JavaScript against the live session: the body of an async function with ${scopeNames(options)} in scope, the objects a test body gets.`,
      "await screen.getByLabel('Email').fill('ada@example.com'); await expect(screen.getByRole('status')).toHaveText('Saved');",
      'It is ordinary JavaScript in Node, so variables, loops, conditionals, try/catch, functions, and await import() of a Node module work. Read values, compute on them, and act on what you find in one call:',
      "const rows = screen.getByRole('listitem'); const prices = (await rows.allTextContents()).map((text) => Number(text.match(/\\$([\\d.]+)/)[1])); return { prices, sorted: prices.every((price, i) => i === 0 || prices[i - 1] <= price) };",
      'return a JSON value to get it back; console.log lines come back too. The result lists each test line the code ran, then what changed on screen.',
      ...runCodeApi(options),
      `Actions and matchers wait like a test: on screen each waits at most timeout ms (default ${String(RUN_CODE_TIMEOUT_MS)}), so a loop rarely needs a sleep.`,
      'A line that fails throws the error a test gets, whose code is the runner code (LOCATOR_NOT_FOUND, ASSERTION_FAILED, ...); uncaught, it stops the code and the app stays where it is. Await each line: a failure nothing awaited fails the call.',
      "Lines that pass, except reads, join test_lines' draft in the order they ran.",
      'The result shows <secret:name> where a configured secret value is.',
    ].join(' '),
    inputSchema: z.object({
      code: z.string().min(1).describe(`JavaScript: the body of an async function; ${scopeNames(options)} are in scope`),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`How long each action or matcher on screen may wait, in milliseconds; default ${String(RUN_CODE_TIMEOUT_MS)}`),
    }).strict(),
    execute: (args: RunCodeArgs, call: ToolExecutionOptions<unknown>) => runCode(options, args, call.abortSignal),
    toModelOutput: ({ output }: { readonly output: RunCodeResult }) => ({ type: output.failed ? ('error-text' as const) : ('text' as const), value: output.text }),
  };
}

/** Runs the code on the session's objects and renders what happened. */
async function runCode(options: RunCodeOptions, args: RunCodeArgs, signal: AbortSignal | undefined): Promise<RunCodeResult> {
  const attempt = options.attempt(signal);
  const redact = attempt.agentRuntime.redact;
  const recorder = new Recorder();
  const logs: string[] = [];
  const stray: unknown[] = [];
  const scope = { ...objects(options, attempt, args.timeout ?? RUN_CODE_TIMEOUT_MS, recorder), console: logging(logs) };
  let value: unknown;
  let thrown: { readonly cause: unknown } | undefined;
  let end = (): void => undefined;
  try {
    const body = compile(args.code, Object.keys(scope));
    const call = asRunCodeCall((cause) => void stray.push(cause), () => body(scope));
    end = call.end;
    const timeout = (): Error => new TestError('ACTION_FAILED', `run_code: the code did not finish within ${String(PROGRAM_TIMEOUT_MS)} ms`);
    // Left behind at the timeout or a cancel: the code may never settle, and the recorder's end below stops what it does next.
    const run = withTimeout(call.result, PROGRAM_TIMEOUT_MS, timeout);
    // The cap ends with the race, so the session's budget is its own again whatever the code does.
    value = await attempt.budget.capped(PROGRAM_TIMEOUT_MS, () => (signal === undefined ? run : withAbort(run, signal, cancelledError)));
  } catch (cause) {
    thrown = { cause };
  }
  const { unawaited, lost } = await recorder.end();
  end();
  if (unawaited > 0) logs.push(`${String(unawaited)} call(s) on the app were not awaited when the code ended; they ran, but await each one so a failure stops the code.`);
  // What the code threw first; then a failure it never waited on, which reached nothing in it.
  const failure = thrown ?? [lost, ...stray].flatMap((cause) => (cause === undefined ? [] : [{ cause }]))[0];
  const ended: Ended = { value: failure === undefined ? redacted(value, redact) : undefined, error: failure === undefined ? undefined : describe(failure.cause, Object.keys(scope)), logs };
  const { outcomes } = recorder;
  if (ended.error !== undefined) options.onFailed?.(ended.error.code ?? 'ERROR');
  options.record?.(outcomes.flatMap((outcome) => ('error' in outcome || outcome.read ? [] : [outcome.source])));
  let screen: string;
  try {
    screen = options.screen.update(await options.context.observe(), { expectChange: false });
  } catch (cause) {
    screen = `Observing the screen afterwards failed: ${codedMessage(cause)}`;
  }
  return { text: redact(render(ended, outcomes, screen, redact)), failed: ended.error !== undefined };
}

/**
 * The objects the code has in scope, each wrapped so its calls are recorded:
 * the attempt's `app` and engine fixtures, a `screen` wired like the
 * attempt's own whose lines wait at most `timeout`, and `expect`,
 * `credentials`, and `secrets` as a test imports them.
 */
function objects(options: RunCodeSession, attempt: RunCodeAttempt, timeout: number, recorder: Recorder): Record<string, unknown> {
  const runtime = attempt.agentRuntime;
  const { config } = runtime;
  const screen = createScreen(
    createScreenContext({
      session: attempt.session,
      budget: attempt.budget,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      config: { ...config, actionTimeout: Math.min(config.actionTimeout, timeout), assertionTimeout: Math.min(config.assertionTimeout, timeout) },
      steps: runtime.steps,
      secrets: runtime.secrets,
      redaction: { redact: runtime.redact, redactCut: runtime.redactCut },
      appOrigin: runtime.app.base?.origin,
    }),
  );
  // The session's own config, not the registry the process holds: with several sessions open that is the newest one's.
  const credentials: Credentials = { user: (name) => credentialIn(config, name) };
  const secrets: Secrets = { get: (name) => secretIn(config, name) };
  const real: Record<string, unknown> = { screen, app: attempt.fixtures.app, expect, credentials, secrets };
  for (const name of fixtureNames(options)) real[name] = Reflect.get(attempt.fixtures, name);
  return Object.fromEntries(
    Object.entries(real).map(([name, value]) => [name, (typeof value === 'object' || typeof value === 'function') && value !== null ? recorder.wrap(value, name) : value]),
  );
}

/** The names the code always has, which an engine's fixture of the same name does not replace. */
const BUILT_IN = ['screen', 'app', 'expect', 'credentials', 'secrets'] as const;

/** The engine fixtures the code gets by name: the ones a name can bind, a built-in's aside. */
function fixtureNames(session: RunCodeSession): readonly string[] {
  return session.engineFixtures.filter((name) => bindable(name) && !BUILT_IN.some((own) => own === name) && name !== 'console');
}

/** Whether a name can be declared in the code's function: the manifest takes any lower-camel identifier, a reserved word such as `default` included. */
function bindable(name: string): boolean {
  try {
    // Compiled, never run: the parser is what knows the reserved words.
    return new Script(`async (${name}) => 0`) instanceof Script;
  } catch {
    return false;
  }
}

const AsyncFunction = (async () => undefined).constructor as new (...parameters: string[]) => (scope: Record<string, unknown>) => Promise<unknown>;
/** The lines ahead of the code in the function it is compiled into: the two the constructor writes, and the one below. */
const HEAD_LINES = 3;

/** The code as an async function of its scope. Strict, so an assignment to a name it never declared throws and leaves nothing on the server's globals. */
function compile(code: string, names: readonly string[]): (scope: Record<string, unknown>) => Promise<unknown> {
  const head = `'use strict'; const { ${names.join(', ')} } = __scope;`;
  try {
    return new AsyncFunction('__scope', `${head}\n${code}`);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new TestError('INVALID_ARGUMENT', `run_code: the code does not parse${syntaxLine(`async (__scope) => { ${head}\n${code}\n}`)}: ${cause.message}`);
  }
}

/** ` at line N` of a syntax error: the function constructor does not say where, and a script compiled only to be read does. */
function syntaxLine(source: string): string {
  try {
    Reflect.construct(Script, [source, { filename: FILENAME, lineOffset: -1 }]);
    return '';
  } catch (cause) {
    const line = cause instanceof Error ? new RegExp(`^${FILENAME}:(\\d+)`).exec(cause.stack ?? '')?.[1] : undefined;
    return line === undefined ? '' : ` at line ${line}`;
  }
}

/** `console` for the code: the server's stdout is the MCP stream, so what it logs comes back in the result. */
function logging(logs: string[]): Pick<Console, 'log' | 'info' | 'debug' | 'warn' | 'error'> {
  const log = (...values: unknown[]): void => void logs.push(values.map((value) => (typeof value === 'string' ? value : show(value))).join(' '));
  return { log, info: log, debug: log, warn: log, error: log };
}

/** An error as the result names it: a runner error by its code, another by its name and where in the code it was thrown. */
function describe(cause: unknown, names: readonly string[]): NonNullable<Ended['error']> {
  if (cause instanceof Error && typeof Reflect.get(cause, 'code') === 'string') {
    const { code, message } = classifyError(cause);
    return { code, message };
  }
  if (!(cause instanceof Error)) return { code: undefined, message: typeof cause === 'string' ? cause : show(cause) };
  const frame = /<anonymous>:(\d+):(\d+)/.exec(cause.stack ?? '');
  const where = frame === null ? '' : ` (line ${String(Number(frame[1]) - HEAD_LINES)}:${frame[2]!})`;
  // A name that is not there is most often another tool's object, such as a page.
  const has = cause instanceof ReferenceError ? `; the code has ${names.join(', ')}, and Node's globals` : '';
  return { code: undefined, message: `${cause.name}: ${cause.message}${where}${has}` };
}

/** A value with every string in it through the ledger, before it is written as JSON, where an escaped value would pass unseen. */
function redacted(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'bigint') return redact(String(value));
  if (typeof value !== 'object' || value === null || depth > 50) return value;
  if (Array.isArray(value)) return value.map((item) => redacted(item, redact, depth + 1));
  const prototype: unknown = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redacted(item, redact, depth + 1)]));
}

/** The most lines the result spells out; a longer run shows its first and last ones. */
const MAX_LINES_SHOWN = 30;
/** How many lines a longer run shows from each end. */
const SHOWN_EACH_END = 10;

/**
 * The result: how the code ended, what it logged, each test line, then the
 * screen. Code that returns or logs has said what it wants to see, so the
 * reads that passed are counted and not listed; otherwise each read shows its value.
 */
function render(result: Ended, outcomes: readonly Outcome[], screen: string, redact: (text: string) => string): string {
  const lines: string[] = [];
  if (result.error !== undefined) {
    const { code, message } = result.error;
    lines.push(`Failed: ${code === undefined || message.startsWith(code) ? message : `${code}: ${message}`}`, 'The app is where the lines that passed left it.');
  } else {
    lines.push(result.value === undefined ? 'Ran; the code returned nothing.' : `Returned: ${show(result.value)}`);
  }
  if (result.logs.length > 0) lines.push('console:', ...result.logs.map((log) => indent(log)));
  const spoke = result.value !== undefined || result.logs.length > 0;
  const listed = spoke ? outcomes.filter((outcome) => 'error' in outcome || !outcome.read) : outcomes;
  const reads = outcomes.length - listed.length;
  if (outcomes.length > 0) {
    const failed = outcomes.filter((outcome) => 'error' in outcome).length;
    const counts = [...(failed === 0 ? [] : [`${String(failed)} failed`]), ...(reads === 0 ? [] : [`${String(reads)} ${reads === 1 ? 'read' : 'reads'} not listed`])];
    lines.push(`Test lines: ${String(outcomes.length)}${counts.map((count) => `, ${count}`).join('')}.`);
    const numbered = listed.map((outcome, index) => ({ outcome, index }));
    const shown = numbered.length <= MAX_LINES_SHOWN ? numbered : [...numbered.slice(0, SHOWN_EACH_END), ...numbered.slice(-SHOWN_EACH_END)];
    let previous = -1;
    for (const { outcome, index } of shown) {
      if (index !== previous + 1) lines.push(`   ... ${String(index - previous - 1)} more ...`);
      previous = index;
      const number = `${String(index + 1)}.`;
      if ('error' in outcome) {
        lines.push(`${number} failed: ${outcome.source}`, indent(`${outcome.error.code}: ${outcome.error.message}`));
      } else {
        const value = redacted(outcome.value, redact);
        lines.push(`${number} ${outcome.source}${value === undefined ? '' : ` -> ${show(value)}`}`);
      }
    }
  }
  return `${lines.join('\n')}\n\n${screen}`;
}

/** A value as JSON, so a string reads apart from the text around it and an empty one still shows. */
function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function indent(text: string): string {
  return text.split('\n').map((line) => `   ${line}`).join('\n');
}
