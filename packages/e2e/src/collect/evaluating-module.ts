/** Which module is evaluating when a registration call runs. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `at name (location:line:column)` or `at location:line:column`, either one after `async`. */
const FRAME = /^at (?:async )?(?:[^(]*? \()?(.+?):\d+(?::\d+)?\)?$/;
/** A frame of Node.js's ES module loader: the frame before it is a module's top level, evaluating. */
const MODULE_LOADER = 'node:internal/modules/esm/';

/**
 * The file of the module evaluating now, read off the stack: the frame the
 * ES module loader runs, or, once the module has awaited, the outermost
 * frame, as the awaiting callers of the running call end at the module.
 * A module that calls or awaits a function of another module is the one
 * evaluating, not the module of that function.
 *
 * The file is the one Node.js loaded, not the source a source map names
 * (a compiled helper's `.ts`): the loader knows its modules by the files it
 * loaded. So the stack is read with source maps off.
 */
export function evaluatingModule(): string | undefined {
  const mapped = process.sourceMapsEnabled;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  let stack: string;
  try {
    if (mapped) process.setSourceMapsEnabled(false);
    stack = new Error().stack ?? '';
  } finally {
    if (mapped) process.setSourceMapsEnabled(true);
    Error.stackTraceLimit = limit;
  }
  let evaluating: string | undefined;
  for (const line of stack.split('\n').slice(1)) {
    const location = FRAME.exec(line.trim())?.[1];
    if (location === undefined) continue;
    if (location.startsWith(MODULE_LOADER)) break;
    const file = location.startsWith('file:') ? fileURLToPath(location) : location;
    if (path.isAbsolute(file)) evaluating = file;
  }
  return evaluating;
}
