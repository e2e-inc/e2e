/**
 * A platform package that is there without its addon, as in a checkout that
 * has not run `build:native` (pnpm links every platform package of the
 * workspace) or a damaged install, fails to load; it is not reported as
 * missing, whose advice is to install it again.
 */

import { registerHooks } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeUtilUnavailableError, pngSize } from '../src/index.ts';

// No checkout build, and the platform package resolves to its manifest but not to the addon its `main` names.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/[\\/]util\.[^\\/]+\.node$/.test(specifier) || /^@e2e-dev\/util-[^/]+$/.test(specifier)) {
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return nextResolve(specifier, context);
  },
});
afterAll(() => hooks.deregister());

describe('a platform package without its addon', () => {
  it('fails to load, and is not reported as not installed', () => {
    let thrown: unknown;
    try {
      pngSize(new Uint8Array(8));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativeUtilUnavailableError);
    expect((thrown as NativeUtilUnavailableError).notInstalled).toBe(false);
  });
});
