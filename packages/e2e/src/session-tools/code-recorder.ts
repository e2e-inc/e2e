/**
 * What `run_code` puts between its code and the objects a test body gets:
 * each object is wrapped so that a call on it runs on the real one and is
 * written down as the test line that repeats it. A call that returns at once,
 * such as a locator query, is a step in a chain; a call that returns a
 * promise is a line, and what it settled with is its outcome.
 */

import { classifyError, type E2EError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';

/** What became of one line: the value it resolved with, or the error it failed with. */
export type Outcome = { readonly source: string; readonly read: boolean; readonly value: unknown } | { readonly source: string; readonly error: E2EError };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 50;

/**
 * The promise of one line. `await`, `then`, `catch`, and `finally` all reach
 * `then`, so a line whose `then` nobody called is one the code never waited
 * on: its failure reached nothing in the code.
 */
class Line<T> extends Promise<T> {
  seen = false;

  // What `then` derives is an ordinary promise, not another line.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- a Promise's own `then`, overridden to see who waits
  override then<A = T, B = never>(onValue?: ((value: T) => A | PromiseLike<A>) | null, onError?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    this.seen = true;
    return super.then(onValue, onError);
  }
}

/**
 * What a call answers once the code's turn is over: every member and call
 * gives it back, and awaiting it never ends. Code still running, such as a
 * loop that catches each failure and tries again, stops at its next await
 * with nothing to catch, where an error it swallowed would spin the process.
 */
const PARKED: unknown = new Proxy(() => undefined, {
  get: (_, key) => (key === 'then' ? () => undefined : typeof key === 'symbol' ? undefined : PARKED),
  apply: () => PARKED,
});

interface Sent {
  readonly line: Line<unknown>;
  settled: Promise<unknown>;
  failed: { readonly cause: unknown } | undefined;
  /** Still running when the code ended. */
  late: boolean;
}

export class Recorder {
  readonly outcomes: Outcome[] = [];
  private readonly reals = new WeakMap<object, object>();
  /** The test-line text of an object a get or a call gave the code. */
  private readonly sources = new WeakMap<object, string>();
  private readonly sent: Sent[] = [];
  private readonly pending = new Set<Sent>();
  private handles = 0;
  private over = false;

  /** `real` as the code holds it: every call on it runs on `real` and is recorded under `text`. */
  wrap<T extends object>(real: T, text: string): T {
    // Not `real` itself: a frozen fixture's members could not be answered with their wrappers.
    const proxy = new Proxy(typeof real === 'function' ? () => undefined : {}, {
      get: (_, key) => (typeof key === 'symbol' ? Reflect.get(real, key, real) : this.member(real, key, /^\d+$/.test(key) ? `${text}[${key}]` : `${text}.${key}`)),
      apply: (_, __, args: unknown[]) => this.call(real, undefined, text, args),
      has: (_, key) => Reflect.has(real, key),
      ownKeys: () => Reflect.ownKeys(real),
      getOwnPropertyDescriptor: (_, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
        return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(real),
    });
    this.reals.set(proxy, real);
    this.sources.set(proxy, text);
    return proxy as T;
  }

  /**
   * Ends the recording: a call the code makes from here on never runs, and
   * the lines still running are waited for, so the app is where they left it.
   * Answers the first failure nothing in the code was there to catch.
   */
  async end(): Promise<{ readonly unawaited: number; readonly lost: unknown }> {
    this.over = true;
    const unawaited = this.pending.size;
    for (const sent of this.pending) sent.late = true;
    while (this.pending.size > 0) await Promise.all([...this.pending].map((sent) => sent.settled));
    const lost = this.sent.find((sent) => sent.failed !== undefined && (sent.late || !sent.line.seen));
    return { unawaited, lost: lost?.failed?.cause };
  }

  private member(real: object, key: string, text: string): unknown {
    const value: unknown = Reflect.get(real, key, real);
    if (typeof value === 'function') return (...args: unknown[]) => this.call(value, real, text, args);
    return this.given(value, text);
  }

  /**
   * An object the code got at once keeps its text, so a later line that takes
   * it spells it the same way. One with members of its own is wrapped, so its
   * calls are recorded too. Plain data, such as a credential and the secret
   * handle inside it, stays itself; an array stays an array, of items given
   * the same way; and a promise is the code's own to await.
   */
  private given(value: unknown, text: string, depth = 0): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || isThenable(value)) return value;
    if (Array.isArray(value) && !isData(value, 0) && depth < MAX_DEPTH) {
      const items = value.map((item, index) => this.given(item, `${text}[${String(index)}]`, depth + 1));
      this.sources.set(items, text);
      return items;
    }
    if (!isData(value, 0)) return this.wrap(value, text);
    this.sources.set(value, text);
    if (depth < MAX_DEPTH && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) this.given(item, `${text}.${key}`, depth + 1);
    return value;
  }

  private call(method: object, receiver: object | undefined, text: string, args: unknown[]): unknown {
    if (this.over) return PARKED;
    const called = `${text}(${args.map((arg) => this.spell(arg, 0)).join(', ')})`;
    let returned: unknown;
    try {
      returned = Reflect.apply(method as (...values: unknown[]) => unknown, receiver, args.map((arg) => this.real(arg, 0)));
    } catch (cause) {
      this.outcomes.push({ source: `${called};`, error: classifyError(cause) });
      throw cause;
    }
    return isThenable(returned) ? this.line(called, returned, text, args) : this.given(returned, called);
  }

  private line(called: string, returned: PromiseLike<unknown>, text: string, args: readonly unknown[]): Promise<unknown> {
    const source = `await ${called};`;
    const line = new Line<unknown>((resolve, reject) => {
      returned.then((value) => {
        resolve(this.resolved(value, source, called, text, args));
      }, reject);
    });
    const sent: Sent = { line, failed: undefined, late: false, settled: Promise.resolve() };
    // Not through the line's own `then`, which would count as the code waiting on it.
    sent.settled = Promise.prototype.then.call(
      line,
      () => undefined,
      (cause: unknown) => {
        sent.failed = { cause };
        this.outcomes.push({ source, error: classifyError(cause) });
      },
    ).finally(() => this.pending.delete(sent));
    this.sent.push(sent);
    this.pending.add(sent);
    return sent.line;
  }

  /**
   * Plain data is the line's value. Anything with members of its own, such
   * as a new tab or a list of locators, gets a name, since a test cannot
   * chain on a promise: the line that made it declares the name and later
   * lines call it by that.
   */
  private resolved(value: unknown, source: string, called: string, text: string, args: readonly unknown[]): unknown {
    if (isData(value, 0)) {
      // A call that gives a value back only read, unless it ran a function of the code's, which may have changed the app.
      this.outcomes.push({ source, read: value !== undefined && !args.some((arg) => holdsFunction(arg, 0)), value });
      return value;
    }
    const member = text.slice(text.lastIndexOf('.') + 1);
    const name = `${IDENTIFIER.test(member) ? member : 'object'}${String(++this.handles)}`;
    this.outcomes.push({ source: `const ${name} = await ${called};`, read: false, value: undefined });
    return this.given(value, name);
  }

  /** An argument as the real object takes it: what the code holds wrapped goes in as itself. */
  private real(value: unknown, depth: number): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || depth > MAX_DEPTH) return value;
    const real = this.reals.get(value);
    if (real !== undefined) return real;
    // Rebuilt only around something wrapped, so an object the code made, or a secret's handle, goes in as itself.
    if (Array.isArray(value)) {
      const items = value.map((item) => this.real(item, depth + 1));
      return items.every((item, index) => item === value[index]) ? value : items;
    }
    if (!isPlainObject(value)) return value;
    const entries = Object.entries(value).map(([key, item]) => [key, this.real(item, depth + 1)] as const);
    return entries.every(([key, item]) => item === Reflect.get(value, key)) ? value : Object.fromEntries(entries);
  }

  /** An argument as a test would write it. */
  private spell(value: unknown, depth: number): string {
    if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
    if (typeof value === 'bigint') return `${String(value)}n`;
    if (typeof value !== 'object' && typeof value !== 'function') return String(value);
    if (value === null) return 'null';
    const known = this.sources.get(value);
    if (known !== undefined) return known;
    if (typeof value === 'function') return Function.prototype.toString.call(value);
    if (value instanceof RegExp) return String(value);
    if (depth > MAX_DEPTH) return 'undefined';
    if (Array.isArray(value)) return `[${value.map((item) => this.spell(item, depth + 1)).join(', ')}]`;
    if (value instanceof Date) return `new Date(${String(value.getTime())})`;
    if (!isPlainObject(value)) return `/* ${value.constructor?.name ?? 'object'} */ undefined`;
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{ ${entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${this.spell(item, depth + 1)}`).join(', ')} }`;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof Reflect.get(value, 'then') === 'function';
}

/** Whether a value is plain data all the way down, with no members of its own to call. */
function isData(value: unknown, depth: number): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => isData(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => isData(item, depth + 1));
}

function holdsFunction(value: unknown, depth: number): boolean {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => holdsFunction(item, depth + 1));
  return isPlainObject(value) && Object.values(value).some((item) => holdsFunction(item, depth + 1));
}
