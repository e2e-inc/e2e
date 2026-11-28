/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, Deadline, EngineError, pollCondition, stepTimeout, TestError, type EngineFixtureContext, type FixtureOperation, type OperationContext } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, OpenWindow } from './surface.ts';

/** How long before a step's end a wait for a window gives up, at most. */
const WAIT_MARGIN_MS = 250;

/**
 * One window of the running app. The same window is the same object for as
 * long as it stays open. Its reads ask the OS, so each is a promise.
 */
export interface DesktopWindow {
  /** The window's current title. Rejects with `ACTION_FAILED` when it has closed. */
  title(): Promise<string>;
  /** Whether this is the active window, the one `screen`, `expect`, and the agent act on. */
  isActive(): Promise<boolean>;
  /** Whether the window has closed. */
  isClosed(): Promise<boolean>;
  /**
   * Makes this the active window, whichever window has focus, until it closes
   * or the app quits. Rejects with `ACTION_FAILED` when it has closed.
   */
  activate(): Promise<void>;
  /**
   * Closes the window as its close button does. When it was the active
   * window, `screen` reads the focused window again. Rejects with
   * `ACTION_FAILED` when the window has no close button or stays open, as
   * one that asks to save its changes does: its button was pressed.
   */
  close(): Promise<void>;
}

/** Which window `desktop.window` finds: the first whose title matches, a string exactly or a RegExp. */
export interface WindowMatcher {
  readonly title: string | RegExp;
}

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Runs a trigger and waits for the window it opens, then resolves with that
   * window once it is the active one. Rejects with `ACTION_FAILED` when no
   * window opens within `timeout` milliseconds, or else the action timeout.
   * The time the trigger, and the read of the windows before it, take counts
   * toward it, and a trigger that took all of it still gets one look at the
   * windows.
   */
  waitForWindow(trigger: () => Promise<void>, options?: { readonly timeout?: number }): Promise<DesktopWindow>;
  /**
   * The first open window whose title matches, waiting for it to open up to
   * `timeout` milliseconds or else the action timeout. It does not become
   * active; call `activate()`.
   */
  window(which: WindowMatcher, options?: { readonly timeout?: number }): Promise<DesktopWindow>;
  /** The keyboard, for whatever has focus in the active window. */
  readonly keyboard: {
    /**
     * Presses one key, or a combo such as `ControlOrMeta+2`: for an app with
     * no control that takes keyboard focus. Without `physicalInput` the active
     * window must be the app's key window.
     */
    press(key: string): Promise<void>;
    /** Types text into the focused field, key by key. */
    type(text: string): Promise<void>;
  };
  /** Quits the app. `app.open()` launches it again; every test ends with it quit. */
  closeApp(): Promise<void>;
}

export function createDesktopFixture(surface: DesktopSurface, context: EngineFixtureContext): Desktop {
  /** One handle per window id, which the window server gives to no other window while this one is open. */
  const handles = new Map<string, DesktopWindow>();
  const windowAction: FixtureOperation = { kind: 'resource' };
  const read = async (id: string): Promise<OpenWindow | undefined> => (await listed(context.operation())).find((window) => window.id === id);
  const handle = ({ id }: OpenWindow): DesktopWindow => {
    const known = handles.get(id);
    if (known !== undefined) return known;
    const made = context.fixture<DesktopWindow>('window', {
      async title() {
        const window = await read(id);
        if (window === undefined) throw new TestError('ACTION_FAILED', 'the window has closed; desktop.windows() lists the open ones');
        return window.title;
      },
      isActive: async () => (await read(id))?.active === true,
      isClosed: async () => (await read(id)) === undefined,
      activate: () => surface.activateWindow(id, context.operation()),
      close: () => surface.closeWindow(id, context.operation()),
    }, { title: windowAction, isActive: windowAction, isClosed: windowAction, activate: windowAction, close: windowAction });
    handles.set(id, made);
    return made;
  };
  /**
   * Reads the open windows until `pick` finds what it looks for, or `waitMs`
   * ends. Each read gets the time left in the wait, and a match it brings back
   * after the wait ended is not taken. With `looksOnce` (a trigger that took
   * all of the wait, or all but too little for a read) it looks once, with the
   * operation's own budget. Without `margin` it reads to the end of `waitMs`.
   * `timedOut` gets the last list read, and the failure of the last read when
   * it read none.
   */
  const waitFor = async <T>(pick: (windows: readonly OpenWindow[]) => T | undefined, operation: OperationContext, waitMs: number, timedOut: (windows: readonly OpenWindow[], unread?: Error) => string, { looksOnce = false, margin = true }: { looksOnce?: boolean; margin?: boolean } = {}): Promise<T> => {
    let windows: readonly OpenWindow[] = [];
    let unread: Error | undefined;
    let found: T | undefined;
    // A wait for a window ends a little before the step's own end, so it reports what it waited for rather than a bare
    // timeout; a read of the list alone keeps the whole budget.
    const deadline = new Deadline(looksOnce ? 0 : Math.max(1, waitMs - (margin ? Math.min(WAIT_MARGIN_MS, waitMs / 10) : 0)));
    await pollCondition({
      deadline,
      signal: operation.signal,
      negated: false,
      evaluate: async () => {
        try {
          windows = await surface.windows(looksOnce ? operation : { ...operation, timeoutMs: Math.max(1, deadline.remaining()) });
          unread = undefined;
        } catch (cause) {
          // An app busy opening its window, or a locked screen, does not answer its list: the next read may. A read the
          // wait's end cut short saw nothing either: its budget was the time left, and its timer can fire a moment before
          // this clock reads the deadline.
          if (cause instanceof EngineError && (cause.retryable || (!looksOnce && (deadline.expired() || cause.code === 'OPERATION_TIMEOUT')))) {
            unread = cause;
            return false;
          }
          throw cause;
        }
        const match = pick(windows);
        if (match === undefined || (!looksOnce && deadline.expired())) return false;
        found = match;
        return true;
      },
      onTimeout: () => new TestError('ACTION_FAILED', timedOut(windows, unread), unread === undefined ? {} : { cause: unread }),
    });
    if (found === undefined) throw new TestError('ACTION_FAILED', timedOut(windows, unread));
    return found;
  };
  /** The open windows, read again while the app does not answer for them, within the operation's budget. */
  const listed = (operation: OperationContext): Promise<readonly OpenWindow[]> =>
    waitFor((windows) => windows, operation, operation.timeoutMs, (_windows, unread) => `the app's windows could not be read: ${unread?.message ?? 'no read answered in time'}`, { margin: false });
  const desktop: Desktop = {
    platform: surface.platform,
    windows: async () => (await listed(context.operation())).map(handle),
    async waitForWindow(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.waitForWindow() takes the function that opens the window');
      const operation = context.operation(stepTimeout(options?.timeout, 'desktop.waitForWindow'));
      const waitMs = operation.timeoutMs;
      // The whole call counts toward the timeout: the read before the trigger, which waits for an app that does not answer, too.
      const begun = Date.now();
      // The windows open before the trigger, read until the app answers: the trigger runs once, after a list it can be told from.
      const before = new Set((await listed(operation)).map((window) => window.id));
      const started = Date.now();
      // The trigger is test code: its error is reported as it is.
      await trigger();
      const triggerMs = Date.now() - started;
      // The one look with the operation's own budget is for a trigger that took the wait, not for time a slow read spent.
      const triggerTookIt = triggerMs >= waitMs - Math.min(WAIT_MARGIN_MS, waitMs / 10);
      const opened = await waitFor(
        // Not a dialog macOS put over the app, which `screen` never reads on its own either.
        (windows) => windows.find((window) => window.readable && !before.has(window.id)),
        operation,
        waitMs - (Date.now() - begun),
        () => `no window opened within ${waitMs}ms; the trigger resolved after ${triggerMs}ms`,
        { looksOnce: triggerTookIt },
      );
      // Activating it reads the windows again, within what is left of the call, or with the operation's own budget after
      // the one look.
      const left = waitMs - (Date.now() - begun);
      await surface.activateWindow(opened.id, triggerTookIt ? operation : { ...operation, timeoutMs: Math.max(1, left) });
      return handle(opened);
    },
    async window(which, options) {
      if (typeof which !== 'object' || which === null || (typeof which.title !== 'string' && !(which.title instanceof RegExp))) {
        throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.window() takes { title }, a string or a RegExp; desktop.windows() lists every window');
      }
      const { title } = which;
      // A copy, with every flag: a sticky RegExp matches only at the start of a title. Each test starts it there.
      const pattern = typeof title === 'string' ? undefined : new RegExp(title);
      const matches = (window: OpenWindow): boolean => {
        if (pattern === undefined) return window.title === title;
        pattern.lastIndex = 0;
        return pattern.test(window.title);
      };
      const operation = context.operation(stepTimeout(options?.timeout, 'desktop.window'));
      return handle(
        await waitFor(
          (windows) => windows.find(matches),
          operation,
          operation.timeoutMs,
          (windows) => `no window has the title ${String(title instanceof RegExp ? title : JSON.stringify(title))}; open: ${windows.map((window) => JSON.stringify(window.title)).join(', ') || 'none'}`,
        ),
      );
    },
    keyboard: {
      async press(key) {
        await surface.pressKey(key, context.operation());
      },
      async type(text) {
        if (typeof text !== 'string') throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.keyboard.type() takes the text to type');
        await surface.typeText(text, { replace: false }, context.operation());
      },
    },
    async closeApp() {
      const operation = context.operation();
      await surface.closeApp(operation.signal, operation.timeoutMs);
    },
  };
  return context.fixture('desktop', desktop, {
    windows: { kind: 'resource' },
    waitForWindow: { kind: 'resource', timeout: false },
    window: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => String(which?.title) },
    keyboard: { press: { kind: 'resource', label: (key) => key }, type: { kind: 'resource', label: (text) => (typeof text === 'string' ? `${text.length} chars` : '') } },
    closeApp: { kind: 'resource' },
  });
}
