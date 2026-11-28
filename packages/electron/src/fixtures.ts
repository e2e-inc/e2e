/**
 * The `electron` fixture an `electron()` target contributes, as types only:
 * what the package's public entries declare, apart from the engine's own
 * modules.
 */

import type { Locator } from '@e2e-dev/core/engine';
import type { DialogHandler } from './dialogs.ts';

/**
 * One window of the running app: a `BrowserWindow`, a `WebContentsView`, or a
 * `<webview>` guest. The same window is the same object for as long as the
 * app runs.
 */
export interface ElectronWindow {
  /** The document's current title, or the OS window's when the document has none. */
  title(): Promise<string>;
  /** The page's current URL. */
  url(): Promise<string>;
  /** Whether this is the active window, the one `screen`, `expect`, and the agent act on. */
  isActive(): boolean;
  /** Whether the window has closed. */
  isClosed(): boolean;
  /** Makes this the active window. Rejects with `ACTION_FAILED` when it has closed. */
  activate(): Promise<void>;
  /**
   * Runs `fn` in the window's page, with the app's own globals, and returns
   * what it returns, which must be JSON. `fn` is sent as source text: it
   * cannot close over the test's variables, so pass them as `arg`.
   */
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  /** Runs `fn` in the window's page with `arg`, which must be JSON. */
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** Reloads the window's document and resolves once it has loaded again. */
  reload(): Promise<void>;
  /** Closes the window, past any `beforeunload` guard. When it was the active window, the window that opened it is active again, else the one active before it. */
  close(): Promise<void>;
}

/** Which window `electron.window` finds: the first whose title (the document's or the OS window's) and URL match, a string exactly or a RegExp. */
export interface WindowMatcher {
  readonly title?: string | RegExp;
  readonly url?: string | RegExp;
}

/**
 * The main process's `electron` module, as a function passed to `evaluate`
 * receives it: typed by the project's own `electron` package, a peer of
 * this one.
 */
export type ElectronMainModule = typeof import('electron');

/** What `electron.launch` adds to the target's own launch arguments and the engine's `env`. */
export interface ElectronLaunchOptions {
  /** Arguments after the target's `app.launchArguments`: the app's own switches and Chromium's. */
  readonly args?: readonly string[] | undefined;
  /** Variables over the engine's `env`. Never `ELECTRON_RUN_AS_NODE` or `NODE_OPTIONS`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** The directory the app's process starts in, over the engine's `cwd`: absolute, or relative to the project root. */
  readonly cwd?: string | undefined;
  /** How long the launch may take, in milliseconds. Default: the test's `timeout`. */
  readonly timeout?: number | undefined;
}

/** Keyboard input to the active window, for whatever holds focus there. */
export interface ElectronKeyboard {
  /** Presses one key, with its modifiers: `'Escape'`, `'ControlOrMeta+A'`, `'Shift+Tab'`. */
  press(key: string): Promise<void>;
  /** Holds one key until `up`; a held modifier applies to the keys and mouse events after it. */
  down(key: string): Promise<void>;
  /** Releases a held key. */
  up(key: string): Promise<void>;
  /** Types plain text key by key, `delay` milliseconds apart. Never a secret: fill one with `locator.fill`. */
  type(text: string, options?: { readonly delay?: number }): Promise<void>;
  /** Inserts text as an input method's commit would: input events and no key events. */
  insertText(text: string): Promise<void>;
}

/** Pointer input to the active window, in viewport CSS pixels. */
export interface ElectronMouse {
  /** Moves the pointer to a point of the viewport. */
  move(x: number, y: number): Promise<void>;
  /** Presses a button where the pointer is; the left one by default. */
  down(options?: { readonly button?: 'left' | 'right' | 'middle' }): Promise<void>;
  /** Releases a button where the pointer is; the left one by default. */
  up(options?: { readonly button?: 'left' | 'right' | 'middle' }): Promise<void>;
  /** Scrolls by a wheel turn where the pointer is. */
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

/** Deterministic Electron app management exposed to tests as `electron`. */
export interface Electron {
  /**
   * The directory the app keeps its data in for this test, empty until the
   * app writes to it. It exists before the app is launched, so a test can
   * put data in it first, or pass it on with `launch({ env })`.
   */
  readonly userDataDir: string;
  /**
   * Launches the app fresh, as `app.open()` does, with arguments and
   * variables of this test's own added to the target's. They stay for the
   * rest of the test: `app.open()`, `app.restart()`, and `app.clearState()`
   * launch with them too. Another `launch()` replaces them; it does not add
   * to them.
   */
  launch(options?: ElectronLaunchOptions): Promise<void>;
  /** The active window, the one `screen`, `expect`, and the agent act on. Throws `INVALID_STATE` when the app has no open window. */
  activeWindow(): ElectronWindow;
  /** Keyboard input to the active window. */
  readonly keyboard: ElectronKeyboard;
  /** Pointer input to the active window. */
  readonly mouse: ElectronMouse;
  /**
   * Runs `fn` in the app's main process and returns what it returns, which
   * must be serializable. `fn` is sent as source text: it cannot close over
   * the test's variables, so pass them as `arg`. Code with the main
   * process's full authority, as trusted as the test itself.
   */
  evaluate<R>(fn: (electron: ElectronMainModule) => R | Promise<R>): Promise<R>;
  /** Runs `fn` in the main process with `arg`, which a function that takes one must be given. */
  evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R>;
  /** The app's open windows, in the order they opened. */
  windows(): readonly ElectronWindow[];
  /**
   * Runs a trigger and waits for the window it opens, then resolves with that
   * window once it is the active one. Rejects with `ACTION_FAILED` when no
   * window opens within `timeout` milliseconds, or else the action timeout.
   */
  waitForWindow(trigger: () => Promise<void>, options?: { readonly timeout?: number }): Promise<ElectronWindow>;
  /**
   * The first open window whose title or URL matches, waiting for it to open
   * up to `timeout` milliseconds or else the action timeout: for a window
   * the app opens on its own. It does not become active; call `activate()`.
   */
  window(which: WindowMatcher, options?: { readonly timeout?: number }): Promise<ElectronWindow>;
  /**
   * Runs `trigger` and waits for the download it starts to finish, up to
   * `timeout` milliseconds or else the action timeout. The file is copied
   * into the attempt's artifacts: `path` is relative to them.
   */
  waitForDownload(trigger: () => Promise<void>, options?: { readonly timeout?: number }): Promise<{ readonly path: string; readonly absolutePath: string; readonly suggestedFilename: string }>;
  /**
   * Answers the `alert` and `confirm` dialogs the app opens from now on:
   * `'accept'`, `'dismiss'`, or a function that must call `accept` or
   * `dismiss`. The newest handler wins. Resolves with what removes it. A
   * dialog no handler takes is dismissed and fails the test's next step.
   */
  onDialog(handler: DialogHandler): Promise<() => Promise<void>>;
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
