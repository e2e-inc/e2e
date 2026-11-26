/**
 * The running app's windows: the registry of the pages it opened, which one
 * `screen` and the agent read, and the node refs that name a node in one.
 */

import type { Page } from 'playwright-core';
import { pollCondition, type NodeRef, type OperationContext } from '@e2e-dev/core/engine';
import { invalidState, notActionable, stale } from './errors.ts';
import { waitDeadline } from './input-gate.ts';

/** The observation root's id: one surface, one root, whichever window it reads. */
export const ROOT_ID = 'window';

/** One open window of the app: its page and the serial its node ids carry. */
export interface AppWindow {
  readonly page: Page;
  readonly serial: number;
}

/** A window of the running app, as the `electron` fixture lists it. */
export interface ElectronWindow {
  /** Its position among the open windows, in the order they opened: what `useWindow` and the agent's tab tools take. */
  readonly index: number;
  readonly title: string;
  readonly url: string;
  /** Whether `screen` and the agent read and act in this window. */
  readonly shown: boolean;
}

/** Which window `useWindow` picks: a position, or the first whose title or URL matches. */
export type WindowMatcher = number | { readonly title?: string | RegExp; readonly url?: string | RegExp };

/** The node id a window's node carries: the window's serial and the node's backend id. */
export function nodeId(window: AppWindow, backendNodeId: number): string {
  return `${window.serial}.${backendNodeId}`;
}

export class Windows {
  private readonly byPage = new Map<Page, AppWindow>();
  private shown: AppWindow | undefined;
  private nextSerial = 1;

  /** Registers a page the app opened, once; undefined when it is already known or closed. Its node ids get a serial of their own. */
  add(page: Page): AppWindow | undefined {
    if (this.byPage.has(page) || page.isClosed()) return undefined;
    const window: AppWindow = { page, serial: this.nextSerial++ };
    this.byPage.set(page, window);
    this.shown ??= window;
    page.on('close', () => {
      this.byPage.delete(page);
      if (this.shown === window) this.shown = [...this.byPage.values()].at(-1);
    });
    return window;
  }

  /** Forgets every window: the app quit. */
  clear(): void {
    this.byPage.clear();
    this.shown = undefined;
  }

  isShown(window: AppWindow): boolean {
    return this.shown === window;
  }

  /** The open windows, in the order they opened. A `WebContentsView` is a page of its own and counts as a window. */
  open(): AppWindow[] {
    return [...this.byPage.values()].filter(isOpen).toSorted((a, b) => a.serial - b.serial);
  }

  /** The window `screen` and the agent read: the one chosen, else the first the app opened; once that one closes, the newest still open. */
  current(): AppWindow | undefined {
    if (this.shown !== undefined && isOpen(this.shown)) return this.shown;
    this.shown = this.open().at(-1);
    return this.shown;
  }

  /** The current window, or why there is none. */
  require(running: boolean): AppWindow {
    const window = this.current();
    if (window === undefined) throw invalidState(running ? 'the app has no open window' : 'the app is not running: open it with app.open()');
    return window;
  }

  /** The window and backend node a ref names, or a stale error when it is gone or from another window. */
  bind(ref: NodeRef): { readonly window: AppWindow; readonly backendNodeId: number } {
    const match = /^(\d+)\.(\d+)$/.exec(ref.id);
    if (match === null) throw stale(`node ${ref.id} is not a node of this app`);
    const window = this.current();
    if (window === undefined || window.serial !== Number(match[1])) throw stale(`node ${ref.id} is in a window that is not shown now`);
    return { window, backendNodeId: Number(match[2]) };
  }

  /** Shows the open window at `index`. */
  show(index: number): AppWindow {
    const window = this.open()[index];
    if (window === undefined) throw notActionable(`the app has ${this.open().length} windows; there is no window ${index}`);
    this.shown = window;
    return window;
  }

  /** The open window at `index`, which closing leaves another open. */
  closable(index: number): AppWindow {
    const open = this.open();
    const window = open[index];
    if (window === undefined) throw notActionable(`the app has ${open.length} windows; there is no window ${index}`);
    // The contract keeps the last tab open; for most apps the last window closing quits the app.
    if (open.length === 1) throw notActionable('this is the app\'s only window; closing it would end the app');
    return window;
  }

  /** The open windows as the fixture lists them, each beside its handle, so a window that closes while the titles are read cannot shift a match onto another. */
  async list(): Promise<readonly { readonly window: AppWindow; readonly entry: ElectronWindow }[]> {
    const shown = this.current();
    return await Promise.all(
      this.open().map(async (window, index) => ({
        window,
        entry: { index, title: await window.page.title().catch(() => ''), url: window.page.url(), shown: window === shown },
      })),
    );
  }

  /** Shows the first open window `which` matches, waiting for it to open until a little before the operation's deadline. */
  async use(which: WindowMatcher, operation: OperationContext): Promise<ElectronWindow> {
    let listed: Awaited<ReturnType<Windows['list']>> = [];
    let shown: ElectronWindow | undefined;
    await pollCondition({
      deadline: waitDeadline(operation),
      signal: operation.signal,
      negated: false,
      evaluate: async () => {
        listed = await this.list();
        const found = listed.find(({ entry }) => matchesWindow(entry, which));
        // A match that closed while the list was read is not shown; the next read looks again.
        const index = found === undefined ? -1 : this.open().indexOf(found.window);
        if (found === undefined || index === -1) return false;
        this.shown = found.window;
        await found.window.page.bringToFront().catch(() => undefined);
        shown = { ...found.entry, index, shown: true };
        return true;
      },
      onTimeout: () => notActionable(`no window matches ${describeMatcher(which)}; open: ${listed.map(({ entry }) => JSON.stringify(entry.title)).join(', ') || 'none'}`),
    });
    if (shown === undefined) throw notActionable(`no window matches ${describeMatcher(which)}`);
    return shown;
  }
}

/** Whether a window is one the app shows its user: open, and not an inspector the app's own DevTools opened. */
function isOpen(window: AppWindow): boolean {
  return !window.page.isClosed() && !window.page.url().startsWith('devtools://');
}

function matchesWindow(window: ElectronWindow, which: WindowMatcher): boolean {
  if (typeof which === 'number') return window.index === which;
  const test = (pattern: string | RegExp | undefined, value: string): boolean =>
    pattern === undefined || (typeof pattern === 'string' ? value === pattern : new RegExp(pattern.source, pattern.flags).test(value));
  return test(which.title, window.title) && test(which.url, window.url);
}

function describeMatcher(which: WindowMatcher): string {
  if (typeof which === 'number') return `index ${which}`;
  return [which.title === undefined ? '' : `title ${String(which.title)}`, which.url === undefined ? '' : `url ${String(which.url)}`].filter(Boolean).join(' and ') || 'any window';
}
