/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, DesktopWindow } from './surface.ts';
import { titleText } from './window-choice.ts';

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
   * `RegExp` matches a part of it; either waits within the action timeout
   * for a window still opening, and is refused when two windows match. A
   * window from `desktop.windows()` is picked by its id, with no wait. With
   * no window, goes back to the focused one.
   */
  useWindow(window?: string | RegExp | Pick<DesktopWindow, 'id'>): Promise<void>;
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
      const choice = window === undefined ? undefined : typeof window === 'string' || window instanceof RegExp ? { title: window } : { id: window.id };
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
    // The wait for a title owns the deadline, so a window that never shows fails with the titles the app has.
    useWindow: { kind: 'resource', timeout: false, label: (window) => (typeof window === 'string' || window instanceof RegExp ? titleText(window) : '') },
    press: { kind: 'resource', label: (key) => key },
    closeApp: { kind: 'resource' },
  });
}
