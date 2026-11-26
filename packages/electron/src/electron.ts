/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, isSecret, stepTimeout, type EngineFixtureContext } from '@e2e-dev/core/engine';
import type { Electron, ElectronMainModule } from './fixtures.ts';
import type { ElectronSurface } from './surface.ts';

export function createElectronFixture(surface: ElectronSurface, context: EngineFixtureContext): Electron {
  const electron: Electron = {
    async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
      // A secret handle would reach the main process as its name and purpose, never its value: refused, as every JSON sink refuses one.
      if (holdsSecret(arg)) throw new ConfigurationError('POLICY_DENIED', 'electron.evaluate cannot take a secret as its argument: resolve the value in the test and pass a string, or keep it out of the main process');
      return await surface.evaluate(fn, arg as A, context.operation());
    },
    async windows() {
      return await surface.windows();
    },
    async useWindow(which, options) {
      return await surface.useWindow(which, context.operation(stepTimeout(options?.timeout, 'electron.useWindow')));
    },
    locator(selector) {
      if (typeof selector !== 'string' || selector.trim() === '') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.locator() takes a CSS selector string');
      return context.locator({ kind: 'selector', selector });
    },
  };
  return context.fixture('electron', electron, {
    evaluate: { kind: 'resource' },
    windows: { kind: 'resource' },
    useWindow: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => (typeof which === 'number' ? String(which) : JSON.stringify({ ...which, title: which.title?.toString(), url: which.url?.toString() })) },
  });
}

/** Whether a value is a secret handle or holds one in an array or a plain object, at any depth. */
function holdsSecret(value: unknown, seen = new Set<unknown>()): boolean {
  if (isSecret(value)) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) => holdsSecret(item, seen));
}
