/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import { TestError, type EngineFixtureContext, type FixtureTestLine } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface } from './surface.ts';
import { choiceLabel, windowChoice, type DesktopWindow, type WindowArgument } from './window-choice.ts';

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows, the focused one marked. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Reads and acts in this window from now on, rather than the focused one,
   * until the app quits: a panel or bubble that takes focus then cannot hide
   * the window the test is about. A string is the window's whole title and a
   * `RegExp` matches a part of it, as `screen` matches text; either waits
   * within the action timeout for a window still opening, and is refused
   * when two windows match. A window from `desktop.windows()` is picked by
   * its id, with no wait. With no window, goes back to the focused one.
   */
  useWindow(window?: WindowArgument): Promise<void>;
  /**
   * Presses one key, or a combo such as `ControlOrMeta+2`, into the app's
   * window, for an app with no control that takes keyboard focus. Without
   * `headed` the window must be the app's key window.
   */
  press(key: string): Promise<void>;
  /** Quits the app. `app.open()` launches it again; every test ends with it quit. */
  closeApp(): Promise<void>;
}

export function createDesktopFixture(surface: DesktopSurface, context: EngineFixtureContext): Desktop {
  const desktop: Desktop = {
    platform: surface.platform,
    async windows() {
      const operation = context.operation();
      return await surface.windows(operation.signal, operation.timeoutMs);
    },
    async useWindow(window) {
      const operation = context.operation();
      const choice = windowChoice(window);
      if (window !== undefined && choice === undefined) {
        throw new TestError('INVALID_ARGUMENT', `desktop.useWindow() takes a window's title, as a string or a RegExp, or a window from desktop.windows(), not ${window === null ? 'null' : typeof window}`);
      }
      await surface.useWindow(choice, operation.signal, operation.timeoutMs);
    },
    async press(key) {
      await surface.pressKey(key, context.operation());
    },
    async closeApp() {
      const operation = context.operation();
      await surface.closeApp(operation.signal, operation.timeoutMs);
    },
  };
  return context.fixture('desktop', desktop, {
    windows: { kind: 'resource' },
    // The wait for a title owns the deadline, so a window that never shows fails with the titles the app has; an id is looked up in one window list, which the driver call bounds.
    // A window id holds only while the window stays open: a test line from `e2e mcp` names the window by its title instead.
    useWindow: { kind: 'resource', timeout: false, label: (window) => choiceLabel(windowChoice(window)), testLine: windowLine },
    press: { kind: 'resource', label: (key) => key },
    closeApp: { kind: 'resource' },
  });
}

/**
 * How a test line names the window `useWindow` got: by its title, which holds
 * on the next launch, where its id does not. A title or a pattern is written
 * as given. A window with no title, or one named only by its id, keeps its
 * arguments, with a note that they may not hold.
 */
function windowLine(window?: WindowArgument): FixtureTestLine | undefined {
  if (window === undefined || typeof window !== 'object' || window instanceof RegExp) return undefined;
  const title: unknown = 'title' in window ? window.title : undefined;
  if (typeof title === 'string' && title.trim() !== '') return { args: JSON.stringify(title) };
  return { note: 'a window id holds only while the window stays open; on the next launch, pick the window by its title' };
}
