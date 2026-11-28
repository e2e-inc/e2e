/**
 * What one exec carries between the runner and the relay on the Mac, and the
 * checks each side runs on what it parses. Copied to the Mac with the relay;
 * imports nothing.
 */

/** One exec's request: sessions to start and stop, bytes for each, and how long to wait for output. */
export interface ExchangeRequest {
  /** The sessions the caller owns: only their output and exits come back, since every runner process exchanges on its own. */
  readonly sessions: readonly string[];
  /** Sessions to start, each with the variables its server gets. */
  readonly open?: readonly { readonly id: string; readonly env: Readonly<Record<string, string>> }[];
  /** Base64 bytes for each session's server, in order. */
  readonly input?: Readonly<Record<string, string>>;
  /** Sessions whose server's stdin ends; the relay kills a server that has not exited soon after. */
  readonly close?: readonly string[];
  /** Milliseconds to wait for output when none is ready. */
  readonly wait: number;
  /** Bytes of output to return at most; the rest waits for the next exchange. */
  readonly budget: number;
}

/** A server that ended, with the end of its stderr. */
export interface SessionExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

export interface ExchangeAnswer {
  /** Base64 bytes each session's server wrote. */
  readonly output: Readonly<Record<string, string>>;
  /** Sessions whose server ended, reported once all its output was returned. */
  readonly exited: Readonly<Record<string, SessionExit>>;
  /** Whether output is left over the budget, for an exchange right away. */
  readonly more: boolean;
}

type Fields = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isStringMap = (value: unknown): value is Record<string, string> => isObject(value) && Object.values(value).every((item) => typeof item === 'string');

function isRequest(value: unknown): value is ExchangeRequest {
  return (
    isObject(value) &&
    isStrings(value.sessions) &&
    typeof value.wait === 'number' &&
    typeof value.budget === 'number' &&
    (value.open === undefined || (Array.isArray(value.open) && value.open.every((item: unknown) => isObject(item) && typeof item.id === 'string' && isStringMap(item.env)))) &&
    (value.input === undefined || isStringMap(value.input)) &&
    (value.close === undefined || isStrings(value.close))
  );
}

function isAnswer(value: unknown): value is ExchangeAnswer {
  return (
    isObject(value) &&
    isStringMap(value.output) &&
    typeof value.more === 'boolean' &&
    isObject(value.exited) &&
    Object.values(value.exited).every((exit) => isObject(exit) && (typeof exit.code === 'number' || exit.code === null) && (typeof exit.signal === 'string' || exit.signal === null) && typeof exit.stderr === 'string')
  );
}

/** The request a runner sent, or an error when it is not one. */
export function parseRequest(text: string): ExchangeRequest {
  const value: unknown = JSON.parse(text);
  if (isRequest(value)) return value;
  throw new Error('the relay got a request it cannot read');
}

/** The answer the relay printed, or an error when it is not one. */
export function parseAnswer(text: string): ExchangeAnswer {
  const value: unknown = JSON.parse(text);
  if (isAnswer(value)) return value;
  throw new Error('the relay on the Mac answered something it should not');
}
