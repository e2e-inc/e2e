/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import type { EngineFixtureContext, FixtureTestLine } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, DesktopWindow } from './surface.ts';

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows, the focused one marked. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Reads and acts in this window from now on, rather than the focused one,
   * until the app quits: a panel or bubble that takes focus then cannot hide
   * the window the test is about. With no window, goes back to the focused
   * one.
   */
  useWindow(window?: DesktopWindow | string): Promise<void>;
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
      await surface.useWindow(typeof window === 'string' ? window : window?.id, operation.signal, operation.timeoutMs);
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
    // A window id holds only while the window stays open: a test line from `e2e mcp` finds the window by its title instead.
    useWindow: { kind: 'resource', testLine: windowLine },
    press: { kind: 'resource', label: (key) => key },
    closeApp: { kind: 'resource' },
  });
}

/**
 * How a test line names the window `useWindow` got: by its title, which holds
 * on the next launch, where its id does not. When no window has that title
 * on replay, the line passes `titled <title>` as the id, which `useWindow`
 * refuses ("the app has no window titled Inbox"), rather than `undefined`,
 * which would quietly go back to the focused window. A window with no title,
 * or one named only by its id, keeps its arguments, with a note that they
 * may not hold.
 */
function windowLine(window?: DesktopWindow | string): FixtureTestLine | undefined {
  if (window === undefined) return undefined;
  const title: unknown = typeof window === 'object' ? window.title : undefined;
  if (typeof title === 'string' && title.trim() !== '') {
    return { args: `(await desktop.windows()).find((window) => window.title === ${JSON.stringify(title)}) ?? ${JSON.stringify(`titled ${title}`)}` };
  }
  return { note: 'a window id holds only while the window stays open; on the next launch, pick the window from desktop.windows()' };
}
