/** How a value reads in a value matcher's failure message. */

import { inspect, types } from 'node:util';
import { isAsymmetric } from '@vitest/expect';
import type { AsymmetricMatcher } from '@e2e-dev/core/lib/types';

/**
 * An asymmetric matcher as it reads in a failure: `Any<Number>` and
 * `Anything` describe themselves; the rest print their name and sample,
 * `ObjectContaining {"id":1}`.
 */
function describeMatcher(matcher: AsymmetricMatcher): string {
  const own = (matcher as { toAsymmetricMatcher?: () => string }).toAsymmetricMatcher?.();
  if (own !== undefined) return own;
  const sample = (matcher as { sample?: unknown }).sample;
  return `${matcher.toString()} ${format(sample)}`;
}

/**
 * `[TypeError: boom]`, the way an uncaught error opens; a subclass that kept
 * the name `Error` reads by its class. Own properties follow, since equality
 * compares them: `[HttpError: failed] {"status":404}`. A getter is not
 * called: it may throw, and the failure to report is the matcher's.
 */
function describeError(error: Error, open: Set<Error>): string {
  // Each level is formatted apart from the one above, so no JSON pass sees an error that holds itself.
  if (open.has(error)) return '[Circular]';
  const className: unknown = (error.constructor as { name?: unknown } | undefined)?.name;
  const name = error.name === 'Error' && typeof className === 'string' && className !== '' ? className : error.name;
  const head = `[${error.message === '' ? name : `${name}: ${error.message}`}]`;
  const own: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === 'name' || key === 'message') continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    own[key] = descriptor !== undefined && 'value' in descriptor ? descriptor.value : '[Getter]';
  }
  if (Object.keys(own).length === 0) return head;
  open.add(error);
  try {
    return `${head} ${formatWithin(own, open)}`;
  } finally {
    open.delete(error);
  }
}

export function format(value: unknown): string {
  return formatWithin(value, new Set());
}

/** `format`, inside the errors in `open`: one of them met again reads `[Circular]`. */
function formatWithin(value: unknown, open: Set<Error>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (isAsymmetric(value)) return describeMatcher(value);
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return describeError(value, open);
  try {
    const json = JSON.stringify(value, (_key, nested: unknown) => {
      if (isAsymmetric(nested)) return describeMatcher(nested);
      // An Error has no enumerable properties, so it would print as {}.
      return nested instanceof Error ? describeError(nested, open) : nested;
    });
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return String(value);
}

/** An object that inspects as `text`. */
function inspectsAs(text: () => string): object {
  return { [inspect.custom]: text };
}

/**
 * A copy of `value` in which an asymmetric matcher inspects as its
 * description and an error as `format` prints it, without its stack. Arrays,
 * plain objects, class instances, maps, and sets are copied, with their
 * holes, `undefined` properties, symbol keys, and getters; any other object
 * stays as it is.
 */
function forInspect(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (isAsymmetric(value)) return inspectsAs(() => describeMatcher(value));
  if (value instanceof Error) return inspectsAs(() => format(value));
  const known = seen.get(value);
  if (known !== undefined) return known;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Map.prototype) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, nested] of value as Map<unknown, unknown>) copy.set(forInspect(key, seen), forInspect(nested, seen));
    return copy;
  }
  if (prototype === Set.prototype) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const nested of value as Set<unknown>) copy.add(forInspect(nested, seen));
    return copy;
  }
  // A copy made from the prototype has no internal slots and no private fields, so only an object without them is copied.
  const copyable =
    Array.isArray(value) ||
    (Object.prototype.toString.call(value) === '[object Object]' && !types.isProxy(value) && !(inspect.custom in value));
  if (!copyable) return value;
  const copy: object = Object.setPrototypeOf(Array.isArray(value) ? [] : {}, prototype as object | null) as object;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    // Defining the length leaves holes, so an index that is not an own key stays a hole.
    Object.defineProperty(copy, key, 'value' in descriptor ? { ...descriptor, value: forInspect(descriptor.value, seen) } : descriptor);
  }
  return copy;
}

/**
 * A value with what `toStrictEqual` compares and JSON drops: class names,
 * `undefined` properties, and array holes. `Order { id: 1, note: undefined }`.
 * No string is cut: the runner redacts the message after this, and half a
 * secret is no longer a match.
 */
export function formatStrict(value: unknown): string {
  return inspect(forInspect(value, new Map()), {
    depth: 8,
    compact: true,
    breakLength: Infinity,
    maxArrayLength: 50,
    maxStringLength: Infinity,
  });
}
