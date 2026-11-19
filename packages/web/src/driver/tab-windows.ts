/**
 * The windows of the attempt's tabs, each grown until it shows its tab's
 * whole viewport. `browsingContext.setViewport` lays a page out at any size
 * and resizes no window. Firefox sends mouse and wheel input through the
 * window, as a person's input arrives (`remote.events.async.*`), so a point
 * of the page past the window's content area takes none: in a headless
 * window of 1366 by 768 with 85 pixels of toolbars, the last 37 rows of a
 * 1280 by 720 viewport. A window is as large as the page that fills it plus
 * its chrome, so it grows to the viewport plus that chrome before the tab
 * is sized, and a viewport no window can hold is refused.
 *
 * A tab is sized whatever its page does meanwhile: a command that reads or
 * sets something of the tab, not of the document it shows, is sent again
 * when a navigation replaced that document under it (`acrossNavigations`).
 */

import type { Browser, BrowsingContext } from 'webdriver-bidi-protocol';
import { EngineError, type ViewportSize } from '@e2e-dev/core/engine';
import { BidiError, isStale, releaseQuietly } from '../errors.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, type Wire } from './script.ts';

/** Tab `context` as the browser's tree has it now; undefined once the tab closed, which the browser answers `no such frame`. */
async function openTab(connection: BidiConnection, context: string): Promise<BrowsingContext.Info | undefined> {
  try {
    return (await connection.send('browsingContext.getTree', { root: context, maxDepth: 0 })).contexts[0];
  } catch (cause) {
    if (cause instanceof BidiError && cause.error === 'no such frame') return undefined;
    throw cause;
  }
}

/** Whether tab `context` has closed, as the browser's own tree tells. */
export async function tabClosed(connection: BidiConnection, context: string): Promise<boolean> {
  return (await openTab(connection, context)) === undefined;
}

/**
 * Sends `command`, which reads or sets something every document of tab
 * `context` shares (its window's chrome, its viewport), again each time a
 * navigation replaced the document under it. Firefox runs part of such a
 * command in the tab's document and fails it `no such frame` when that
 * document goes away first, the answer it has for a closed tab too. The
 * browser's tree tells the two apart: a tab still open shows its next
 * document, which answers the same, so the command goes to that one; for a
 * closed tab its failure stands.
 */
export async function acrossNavigations<T>(connection: BidiConnection, context: string, command: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await command();
    } catch (cause) {
      if (!isStale(cause) || (await tabClosed(connection, context))) throw cause;
    }
  }
}

/** The sandbox realm a window's chrome is read in, where no script of the page replaces the sizes it reads. */
const WINDOW_SANDBOX = 'e2e-window';

/** How much larger the window is than the page that fills it: its toolbars and borders. Runs in the page. */
function windowChrome(): { width: number; height: number } {
  return { width: outerWidth - innerWidth, height: outerHeight - innerHeight };
}

/** The windows the attempt has sized a tab in, with the chrome of each. */
export class TabWindows {
  /**
   * Each window's chrome by its id, read from the first tab sized in it.
   * That tab has no viewport yet and fills the window, as every tab does
   * until the driver sizes it; once it has one, its page no longer tells
   * how large the window's content area is.
   */
  private readonly chrome = new Map<string, ViewportSize>();

  constructor(private readonly connection: BidiConnection) {}

  /**
   * Grows the window of tab `context` until its content area holds a page of
   * `viewport`'s size, before the tab is sized to it. A window that holds
   * one already is left as it is, so no window shrinks under a tab.
   * `UNSUPPORTED_CAPABILITY` when the window cannot grow that far: a headed
   * window ends at its display, a headless one at the browser's largest
   * window. It is then put back at the size it had, which holds the
   * viewport its tab has. `NODE_STALE` when the tab or its window closed
   * before or while it was sized, whichever command the close reached. The
   * browser answers each its own way (`no such frame`, `no such client
   * window`, an `unknown error` from a window half closed), so a failure
   * asks for the tab's window again, and a tab without one reads as closed.
   */
  async hold(context: string, viewport: ViewportSize): Promise<void> {
    const closed = (cause?: unknown): EngineError => new EngineError('NODE_STALE', 'the tab closed while its window was sized', { retryable: true, cause });
    const open = await this.windowOf(context);
    if (open === undefined) throw closed();
    let short: string[];
    try {
      short = await this.grow(context, open, viewport);
    } catch (cause) {
      throw (await this.windowOf(context)) === undefined ? closed(cause) : cause;
    }
    if (short.length === 0) return;
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      `the browser window cannot hold a ${String(viewport.width)}x${String(viewport.height)} viewport: it shows at most ${short.join(' and ')}, and pointer input reaches only what the window shows. `
        + 'A headed window ends at its display, a headless one at the browser\'s largest window; set a viewport that fits',
      { retryable: false },
    );
  }

  /**
   * Grows `open`, the window of tab `context`, as far as a page of
   * `viewport`'s size needs. Returns what of the page the window shows each
   * way it still falls short, after putting it back at the size it had;
   * nothing for a window that holds the page.
   */
  private async grow(context: string, open: Browser.ClientWindowInfo, viewport: ViewportSize): Promise<string[]> {
    const { clientWindow } = open;
    const chrome = this.chrome.get(clientWindow) ?? (await this.readChrome(context, clientWindow));
    const needed = { width: viewport.width + chrome.width, height: viewport.height + chrome.height };
    const holds = (window: ViewportSize): boolean => window.width >= needed.width && window.height >= needed.height;
    if (holds(open)) return [];
    const resize = (width: number, height: number): Promise<Browser.ClientWindowInfo> => this.connection.send('browser.setClientWindowState', { clientWindow, state: 'normal', width, height });
    const grown = await resize(Math.max(open.width, needed.width), Math.max(open.height, needed.height));
    if (holds(grown)) return [];
    await releaseQuietly(resize(open.width, open.height));
    return [
      ...(grown.width < needed.width ? [`${String(grown.width - chrome.width)} pixels of the page's width`] : []),
      ...(grown.height < needed.height ? [`${String(grown.height - chrome.height)} pixels of the page's height`] : []),
    ];
  }

  /** The window tab `context` is in, at its size now; undefined once the tab closed or the browser lists its window no more. */
  private async windowOf(context: string): Promise<Browser.ClientWindowInfo | undefined> {
    const tab = await openTab(this.connection, context);
    if (tab === undefined) return undefined;
    const { clientWindows } = await this.connection.send('browser.getClientWindows', {});
    return clientWindows.find((window) => window.clientWindow === tab.clientWindow);
  }

  /**
   * Reads the chrome of `clientWindow` from tab `context`, which fills it,
   * and keeps it. The read runs in the tab's document and every document of
   * the tab answers it the same, so a tab that navigates under it (a popup
   * that redirects as it opens) is read in its next one.
   */
  private async readChrome(context: string, clientWindow: string): Promise<ViewportSize> {
    const read = (): Promise<unknown> => callFunction(this.connection, context, windowChrome, [], { sandbox: WINDOW_SANDBOX });
    const chrome = (await acrossNavigations(this.connection, context, read)) as Wire<ReturnType<typeof windowChrome>>;
    this.chrome.set(clientWindow, chrome);
    return chrome;
  }
}
