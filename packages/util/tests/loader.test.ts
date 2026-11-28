/**
 * Which failure the loader reports when no build loads: a build that was
 * there and failed to load is the cause, whichever candidate it was, and the
 * platform package counts as not installed only when no candidate was there.
 */

import { registerHooks } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeUtilUnavailableError, pngSize } from '../src/index.ts';

// The checkout build is there but will not load (a build for another architecture, say); the platform package is not installed.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/[\\/]util\.[^\\/]+\.node$/.test(specifier)) throw new Error(`dlopen(${specifier}): incompatible architecture`);
    if (specifier.startsWith('@e2e-dev/util-')) throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

describe('a checkout build that fails to load', () => {
  it('is the cause, not the platform package that is not installed', () => {
    let thrown: unknown;
    try {
      pngSize(new Uint8Array(8));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativeUtilUnavailableError);
    const error = thrown as NativeUtilUnavailableError;
    expect(error.notInstalled).toBe(false);
    expect((error.cause as Error).message).toContain('incompatible architecture');
    expect(error.message).toContain('Cannot find module');
  });
});
