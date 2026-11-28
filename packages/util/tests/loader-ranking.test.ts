/**
 * In a checkout, pnpm links the platform package without its addon, so a
 * checkout build that fails to load is followed by a platform package that
 * has nothing to load. The checkout build's failure is the one to report.
 */

import { registerHooks } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeUtilUnavailableError, pngSize } from '../src/index.ts';

// The checkout build is there but will not load; the platform package resolves to its manifest but not to its addon.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/[\\/]util\.[^\\/]+\.node$/.test(specifier)) throw new Error(`dlopen(${specifier}): incompatible architecture`);
    if (/^@e2e-dev\/util-[^/]+$/.test(specifier)) throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

describe('a checkout build that fails to load beside an unbuilt platform package', () => {
  it('is the cause', () => {
    let thrown: unknown;
    try {
      pngSize(new Uint8Array(8));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativeUtilUnavailableError);
    expect((thrown as NativeUtilUnavailableError).notInstalled).toBe(false);
    // Installing a package that is there would not help.
    expect((thrown as Error).message).not.toContain('install @e2e-dev/util-');
    expect(((thrown as NativeUtilUnavailableError).cause as Error).message).toContain('incompatible architecture');
  });
});
