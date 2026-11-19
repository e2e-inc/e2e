/** Runs page functions over WebDriver BiDi `script.callFunction` and converts values across the wire. */

import type { Script } from 'webdriver-bidi-protocol';
import { EngineError } from '@e2e-dev/core/engine';
import { BidiError, ScriptError } from '../errors.ts';
import type { BidiConnection } from './connection.ts';

/**
 * A DOM element held by its BiDi shared id, valid for as long as the element
 * lives in its document. A class, so JSON data that happens to carry a
 * `sharedId` is never taken for one.
 */
export class ElementRef {
  constructor(readonly sharedId: string) {}
}

/** A browsing context a page function returned as a window. */
export class WindowRef {
  constructor(readonly context: string) {}
}

/**
 * A page value with no JSON form (a date, a map, a bigint, a function), kept
 * as its type, so a caller that wants JSON refuses it rather than read it as
 * `undefined`.
 */
export class UnreadableValue {
  constructor(readonly type: string) {}
}

/** What a page function may take: JSON values and element references. */
export type PageArgument = string | number | boolean | null | ElementRef | readonly PageArgument[] | { readonly [key: string]: PageArgument };

/** What a page function hands back: JSON values, each DOM node as its reference, each window as its browsing context, anything else as an `UnreadableValue`. */
export type PageValue = string | number | boolean | null | undefined | ElementRef | WindowRef | UnreadableValue | PageValue[] | { [key: string]: PageValue };

/** A page function: a self-contained function serialized with `toString()`, or source composed from one. */
export type PageFunction = string | ((...args: never[]) => unknown);

/** Plain JSON, which crosses the wire as it is. */
export type PageJson = string | number | boolean | null | PageJson[] | { [key: string]: PageJson };

/** A page value as it crosses the wire: each node as its reference, each window as its browsing context. */
export type Wire<T> = T extends PageJson ? T : T extends Node ? ElementRef : T extends Window ? WindowRef : T extends readonly unknown[] ? { [K in keyof T]: Wire<T[K]> } : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

/** A typed page function: self-contained, so its source runs in the page alone. */
export type TypedPageFunction = (...args: never[]) => unknown;

/** How `callFunction` runs a page function. */
export interface CallOptions {
  readonly awaitPromise?: boolean;
  /** Object depth serialized back, `null` for all of it; the default reads two levels, which an array of elements needs. */
  readonly maxObjectDepth?: number | null;
  /** A sandbox realm of the document to run in instead of its main world, out of reach of the page's scripts. */
  readonly sandbox?: string;
  /** Whether the document counts the call as a user's gesture, as it does a key or a click: what a page asks for before it opens a window, writes the clipboard or asks to confirm leaving. */
  readonly userActivation?: boolean;
}

/**
 * Calls `fn` in the context's main world (or the sandbox `options` names)
 * with `args` and resolves with its return value. A page exception rejects
 * as a `ScriptError` the caller classifies. A function passed a node runs
 * only in that node's document: for a node of another one, which the check
 * the function runs behind found (`inOwnDocument`) or the browser could not
 * hand to the call (`UNPASSED_NODE`), the call fails as the browser's own
 * refusal of a node, `no such node`.
 */
export async function callFunction(
  connection: BidiConnection,
  context: string,
  fn: PageFunction,
  args: readonly PageArgument[] = [],
  options: CallOptions = {},
): Promise<PageValue> {
  const source = typeof fn === 'string' ? fn : fn.toString();
  const nodes = nodePaths(args);
  const foreign = (): BidiError => new BidiError('script.callFunction', 'no such node', 'the node is of a document its browsing context no longer shows');
  const result = await connection.send('script.callFunction', {
    functionDeclaration: nodes.length === 0 ? source : inOwnDocument(source, nodes),
    target: options.sandbox === undefined ? { context } : { context, sandbox: options.sandbox },
    arguments: args.map(toLocalValue),
    awaitPromise: options.awaitPromise ?? false,
    resultOwnership: 'none',
    ...(options.userActivation === true ? { userActivation: true } : {}),
    serializationOptions: { maxDomDepth: 0, maxObjectDepth: options.maxObjectDepth === undefined ? 2 : options.maxObjectDepth, includeShadowTree: 'none' },
  }).catch((cause: unknown) => {
    throw nodes.length > 0 && cause instanceof BidiError && UNPASSED_NODE.test(cause.detail) ? foreign() : cause;
  });
  if (result.type === 'exception') throw new ScriptError(result.exceptionDetails.text);
  const value = fromRemoteValue(result.result);
  if (nodes.length > 0 && value === FOREIGN_NODE) throw foreign();
  return value;
}

/** What a call answers in place of its function's result when a node it was passed is of another document than the one it ran in. */
const FOREIGN_NODE = 'e2e:node-of-another-document';

/**
 * Firefox's words for a call it could not hand a node to. A shared id still
 * names the node of a document a navigation replaced with one of another
 * origin of the same site, which one process holds both of, and Firefox
 * fails the call while it copies that node into the arguments of a document
 * that may not hold it, before the function runs. A call's arguments are
 * JSON and nodes, so no other argument is a cross-origin object.
 */
const UNPASSED_NODE = /Not allowed to define cross-origin object as property/;

/** The keys that lead from `value`, a call's arguments or a value among them at `path`, to each node it holds. */
function nodePaths(value: PageArgument, path: readonly string[] = []): string[][] {
  if (value instanceof ElementRef) return [[...path]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => nodePaths(entry, [...path, key]));
}

/**
 * `source` as a function that runs only when every node it is passed
 * (`nodes`, each the keys that lead to one) is of the document it runs in,
 * and answers `FOREIGN_NODE` otherwise. A shared id names a node for as long
 * as the node lives, which can be longer than its document shows: Firefox
 * refuses one only once its browsing context changed, so after a navigation
 * within the origin, or of a frame, it still passes the node of the document
 * that went away, connected and unseen, where Chromium refuses it. The
 * function would read that document, or focus nothing in it.
 */
function inOwnDocument(source: string, nodes: readonly (readonly string[])[]): string {
  return `(...args) => {
  const nodes = ${JSON.stringify(nodes)};
  for (let at = 0; at < nodes.length; at += 1) {
    let node = args;
    for (let key = 0; key < nodes[at].length; key += 1) node = node[nodes[at][key]];
    if ((node.ownerDocument ?? node) !== document) return ${JSON.stringify(FOREIGN_NODE)};
  }
  return (${source})(...args);
}`;
}

/** One argument as a BiDi local value. */
function toLocalValue(value: PageArgument): Script.LocalValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { type: 'number', value } : { type: 'number', value: String(value) as 'NaN' };
  if (value instanceof ElementRef) return { sharedId: value.sharedId };
  if (Array.isArray(value)) return { type: 'array', value: value.map(toLocalValue) };
  return { type: 'object', value: Object.entries(value).map(([key, entry]) => [key, toLocalValue(entry as PageArgument)]) };
}

/**
 * One serialized result as a plain value: a node becomes its reference, a
 * window its context, any other type an `UnreadableValue`. Object keys are
 * defined as own properties, so a `__proto__` key in page data is a key. An
 * object the result holds twice arrives once with an `internalId` and then as
 * that id alone; each later mention is the same object, so an alias keeps its
 * contents and a cycle stays a cycle for a JSON check to refuse.
 */
function fromRemoteValue(value: Script.RemoteValue, seen = new Map<string, PageValue>()): PageValue {
  const internalId = 'internalId' in value ? value.internalId : undefined;
  if (internalId !== undefined && !('value' in value && value.value !== undefined) && seen.has(internalId)) return seen.get(internalId);
  switch (value.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return value.value;
    case 'number':
      return typeof value.value === 'number' ? value.value : Number(value.value);
    case 'array': {
      const out: PageValue[] = [];
      if (internalId !== undefined) seen.set(internalId, out);
      for (const entry of value.value ?? []) out.push(fromRemoteValue(entry, seen));
      return out;
    }
    case 'object': {
      const out: Record<string, PageValue> = {};
      if (internalId !== undefined) seen.set(internalId, out);
      for (const [key, entry] of value.value ?? []) {
        if (typeof key === 'string') Object.defineProperty(out, key, { value: fromRemoteValue(entry, seen), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 'window':
      return new WindowRef(value.value.context);
    case 'node':
      if (value.sharedId === undefined) throw new EngineError('NODE_STALE', 'a returned node has no shared id', { retryable: true });
      return new ElementRef(value.sharedId);
    default:
      return new UnreadableValue(value.type);
  }
}
