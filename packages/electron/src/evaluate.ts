/**
 * Test code run inside the app, in its main process or in a window's page:
 * the function sent as source text, its argument as a protocol value, and
 * what it returns brought back as plain data.
 */

import type { Protocol } from 'devtools-protocol';
import { TestError } from '@e2e-dev/core/engine';
import type { Session } from './cdp/connection.ts';

/** What a function run in the app threw: its own failure, not the engine's. */
export class EvaluateError extends Error {}

/** Refuses an argument that is not JSON, in the caller's name: it crosses the protocol as a value. */
export function checkJsonArgument(arg: unknown, caller: string): void {
  try {
    JSON.stringify(arg);
  } catch (cause) {
    throw new TestError('INVALID_ARGUMENT', `${caller}: its argument is not JSON (${cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : String(cause)}); pass plain data`, { cause });
  }
}

/**
 * Calls the function `source` on the remote object `objectId` with `leading`
 * and then `arg`, awaits it, and returns its result as plain data
 * (`plainData`). Rejects with `EvaluateError` when the function throws.
 */
export async function callForPlainData(
  session: Session,
  call: { readonly objectId: string; readonly source: string; readonly leading?: readonly Protocol.Runtime.CallArgument[]; readonly arg: unknown; readonly userGesture?: boolean },
): Promise<unknown> {
  const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
    objectId: call.objectId,
    functionDeclaration: `async function (...args) { return (${plainData.toString()})(await (${call.source})(...args)); }`,
    arguments: [...(call.leading ?? []), call.arg === undefined ? {} : { value: call.arg }],
    returnByValue: true,
    awaitPromise: true,
    ...(call.userGesture === true ? { userGesture: true } : {}),
  });
  if (exceptionDetails !== undefined) throw new EvaluateError(describeException(exceptionDetails));
  // NaN, an infinity, and -0 have no JSON: the protocol names them instead.
  return result.unserializableValue === undefined ? result.value : Number(result.unserializableValue);
}

/**
 * A function's source as an expression. A method written in shorthand
 * (`{ run() {} }.run`) prints without the `function` keyword, which is put
 * back. The source is only compiled here, never run.
 */
export function functionSource(fn: (...args: never[]) => unknown, caller: string): string {
  if (typeof fn !== 'function') throw new TestError('INVALID_ARGUMENT', `${caller} takes a function`);
  const source = fn.toString();
  if (compiles(source)) return source;
  const method = source.replace(/^(async\s+)?(\*\s*)?/, (_match, async: string | undefined, star: string | undefined) => `${async ?? ''}function ${star ?? ''}`);
  if (compiles(method)) return method;
  throw new TestError('INVALID_ARGUMENT', `${caller}: its function cannot be sent as source text; pass an arrow function or a function expression`);
}

function compiles(source: string): boolean {
  try {
    // oxlint-disable-next-line no-new-func -- compiled to check its syntax, never called
    void new Function(`(${source})`);
    return true;
  } catch {
    return false;
  }
}

/** What a thrown value says of itself, on one line. */
export function describeException(details: Protocol.Runtime.ExceptionDetails): string {
  const { exception } = details;
  if (exception?.description !== undefined) return exception.description.split('\n')[0] ?? details.text;
  return exception?.value === undefined ? details.text : `${details.text} ${String(exception.value)}`;
}

/**
 * A value as the plain data that crosses the protocol: objects and arrays of
 * primitives. A function or a symbol is left out, as is a reference back to
 * an object that holds it, so a `BrowserWindow` or a timer comes back as the
 * plain part of what it is rather than failing the call. Runs in the main
 * process, sent as source text: self-contained.
 */
export function plainData(value: unknown): unknown {
  const holders = new Set<object>();
  const plain = (item: unknown, depth: number): unknown => {
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (item instanceof Date) return item.toJSON();
    if (holders.has(item) || depth > 32) return undefined;
    holders.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => plain(entry, depth + 1) ?? null);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item)) {
        let entry: unknown;
        try {
          entry = plain((item as Record<string, unknown>)[key], depth + 1);
        } catch {
          // A getter that throws has no value to send.
        }
        // Defined, not assigned: a key named __proto__ is data too.
        if (entry !== undefined) Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally {
      holders.delete(item);
    }
  };
  return plain(value, 0);
}
