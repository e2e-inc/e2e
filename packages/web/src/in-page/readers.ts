/**
 * The readers as a document keeps them: `createReaders` and every part it is
 * built over, spliced by source into one script with the builtins the
 * document had before its own scripts ran. A preload installs them per
 * document, and a read sends only a small call by name.
 */

import { createHash } from 'node:crypto';
import { createResolver, createTextMatching } from '@e2e-dev/core/engine';
import { createAccessibleNames } from './accessible-name.ts';
import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import { createReaders, type ReaderName, type ReaderParts } from './create-readers.ts';
import { frameContentInset } from './document.ts';
import { createDom } from './dom.ts';
import { createLocatorMatch } from './locator-match.ts';
import { createModalScope, MODAL_ORDER_KEY } from './modal-dialogs.ts';
import { createSemanticReader } from './read-semantics.ts';
import { createRoles } from './roles.ts';
import { selectChain } from './select-chain.ts';

/** Where `BUILTINS_INIT_SCRIPT` keeps the builtins a page had before its own scripts ran. */
const BUILTINS_KEY = 'e2e.builtins';

/** The builtins the readers construct and call, as the document had them before any page script ran. */
const BUILTIN_NAMES = ['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON', 'Reflect', 'Symbol', 'Promise', 'Math', 'Number', 'String', 'RegExp', 'Error'] as const;

/** Keeps each document's pristine builtins, before the page's scripts can delete or replace one. */
export const BUILTINS_INIT_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(BUILTINS_KEY)});
  if (Object.prototype.hasOwnProperty.call(globalThis, key)) return;
  Object.defineProperty(globalThis, key, { value: Object.freeze({ ${BUILTIN_NAMES.join(', ')} }), enumerable: false, configurable: false, writable: false });
})();`;

/**
 * What the readers are built over. Typed as `createReaders` takes them, so a
 * part handed over under another's name does not compile.
 */
const PARTS: ReaderParts = {
  semantics: createSemanticReader,
  roles: createRoles,
  names: createAccessibleNames,
  modalScope: createModalScope,
  modalOrderKey: MODAL_ORDER_KEY,
  locatorMatch: createLocatorMatch,
  resolver: createResolver,
  textMatching: createTextMatching,
  select: selectChain,
  domHelpers: createDom,
  closedShadowRootsKey: CLOSED_SHADOW_ROOTS_KEY,
  contentInset: frameContentInset,
};

/** `PARTS` as the source of an object literal: each factory as its own source, each key as a string. */
const PARTS_SOURCE = `{ ${Object.entries(PARTS).map(([name, part]) => `${name}: ${typeof part === 'string' ? JSON.stringify(part) : `(${part.toString()})`}`).join(',\n') } }`;

/** The readers, built where the builtins the document had before its own scripts ran shadow the page's. */
const READERS = `(() => {
  const { ${BUILTIN_NAMES.join(', ')} } = globalThis[globalThis.Symbol.for(${JSON.stringify(BUILTINS_KEY)})] ?? globalThis;
  return (${createReaders.toString()})(${PARTS_SOURCE});
})()`;

/** Where a document keeps its readers: named by their source, so another driver version attached to the same browser keeps its own. */
const READERS_KEY = `e2e.readers.${createHash('sha256').update(READERS).digest('hex').slice(0, 16)}`;

/** Defines the document's readers once, out of reach of the page's own assignments. */
const DEFINE_READERS = `const key = globalThis.Symbol.for(${JSON.stringify(READERS_KEY)});
  if (!Object.prototype.hasOwnProperty.call(globalThis, key)) {
    Object.defineProperty(globalThis, key, { value: ${READERS}, enumerable: false, configurable: false, writable: false });
  }`;

/**
 * Installs the readers in every document before its scripts run, so a read
 * sends only `readerCall`: the readers are about 90 KB of source, and a
 * call that sends them is compiled again every time, which costs a read
 * about 2 ms against a fraction of one.
 */
export const READERS_INIT_SCRIPT = `(() => {
  ${DEFINE_READERS}
})();`;

/** What `readerCall` answers in a document the preload never ran in (one open before it, or an extension page). */
export const READERS_MISSING = 'e2e:readers-missing';

/** Calls the reader `name` that the document keeps, or answers `READERS_MISSING` when it keeps none. */
export function readerCall(name: ReaderName): string {
  return `(...args) => {
  const readers = globalThis[globalThis.Symbol.for(${JSON.stringify(READERS_KEY)})];
  return readers === undefined ? ${JSON.stringify(READERS_MISSING)} : readers.${name}(...args);
}`;
}

/** Calls the reader `name` in a document that keeps none, defining the readers there first; one that cannot keep them (a frozen global) is still read. */
export function readerInstallCall(name: ReaderName): string {
  return `(...args) => {
  try {
    ${DEFINE_READERS}
  } catch {}
  return (globalThis[globalThis.Symbol.for(${JSON.stringify(READERS_KEY)})] ?? ${READERS}).${name}(...args);
}`;
}
