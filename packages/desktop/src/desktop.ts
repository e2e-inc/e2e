/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import { TestError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, DesktopWindow, WindowChoice } from './surface.ts';

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows, the focused one marked. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Reads and acts in this window from now on, rather than the focused one,
   * until the app quits: a panel or bubble that takes focus then cannot hide
   * the window the test is about. Name it as `desktop.windows()` lists it, by
   * `{ title }` (a string matches the whole title, a RegExp any part), or by
   * a string, an id or else a title. A window id changes at every launch, so
   * a listed window whose id is gone is found again by its title. Called
   * with no argument, goes back to the focused window; `undefined` passed
   * explicitly (a `find()` that matched nothing) fails.
   */
  useWindow(window?: DesktopWindow | WindowChoice): Promise<void>;
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
    async useWindow(...choice: [(DesktopWindow | WindowChoice)?]) {
      const [window] = choice;
      // `useWindow(windows.find(...))` that found nothing would otherwise go back to the focused window and hide the miss.
      if (choice.length > 0 && window === undefined) {
        throw new TestError('INVALID_ARGUMENT', 'desktop.useWindow() was given undefined, which names no window. Call desktop.useWindow() with no argument to go back to the focused window');
      }
      const operation = context.operation();
      await surface.useWindow(window, operation.signal, operation.timeoutMs);
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
    useWindow: { kind: 'resource' },
    press: { kind: 'resource', label: (key) => key },
    closeApp: { kind: 'resource' },
  });
}
