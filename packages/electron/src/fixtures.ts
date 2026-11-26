/**
 * The `electron` fixture an `electron()` target contributes, as types only:
 * what the package's public entries declare, apart from the engine's own
 * modules.
 */

import type { Locator } from '@e2e-dev/core/engine';

/** A window of the running app, as the `electron` fixture lists it. */
export interface ElectronWindow {
  /** Its position among the open windows, in the order they opened: what `useWindow` and the agent's tab tools take. */
  readonly index: number;
  /** The document's title. */
  readonly title: string;
  /** The OS window's title (`BrowserWindow.getTitle()`), when it differs from the document's; a view has none of its own. */
  readonly windowTitle?: string;
  readonly url: string;
  /** Whether `screen` and the agent read and act in this window. */
  readonly shown: boolean;
}

/** Which window `useWindow` picks: a position, or the first whose title (the document's or the OS window's) or URL matches. */
export type WindowMatcher = number | { readonly title?: string | RegExp; readonly url?: string | RegExp };

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

/** What a session on an `electron()` target holds beside `screen` and `app`: the `electron` fixture. */
export interface ElectronFixtures {
  readonly electron: Electron;
}
