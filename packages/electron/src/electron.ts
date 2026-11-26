/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, isSecret, stepTimeout, type EngineFixtureContext, type Locator } from '@e2e-dev/core/engine';
import type { ElectronSurface, ElectronWindow, WindowMatcher } from './surface.ts';

/**
 * The main process's `electron` module, as a function passed to `evaluate`
 * receives it: typed by the project's own `electron` package, the optional
 * peer every Electron project installs.
 */
export type ElectronMainModule = typeof import('electron');

/** Deterministic Electron app management exposed to tests as `electron`. */
export interface Electron {
  /**
   * Runs `fn` in the app's main process and returns what it returns, which
   * must be serializable. `fn` is sent as source text: it cannot close over
   * the test's variables, so pass them as `arg`. Code with the main
   * process's full authority, as trusted as the test itself.
   */
  evaluate<R>(fn: (electron: ElectronMainModule) => R | Promise<R>): Promise<R>;
  /** Runs `fn` in the main process with `arg`, which a function that takes one must be given. */
  evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** The app's open windows, in the order they opened, the one `screen` reads marked `shown`. */
  windows(): Promise<readonly ElectronWindow[]>;
  /**
   * Reads and acts in another window from now on: the window at a position,
   * or the first whose title or URL matches (a string exactly, or a RegExp).
   * Waits for such a window to open, up to `timeout` milliseconds or else
   * the action timeout.
   */
  useWindow(which: WindowMatcher, options?: { readonly timeout?: number }): Promise<ElectronWindow>;
  /**
   * A locator for a CSS selector in the window `screen` reads, for an element
   * no role, label, text, or test id names. It matches in the window's
   * document and in each open shadow root, one root at a time, and never
   * enters a frame.
   */
  locator(selector: string): Locator;
}

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
