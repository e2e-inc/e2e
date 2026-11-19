/**
 * The attempt's top-level tabs, in the order they opened: its own tab, the
 * tabs a test opened (`browser.newTab`), and the tabs the app opened from
 * one of them. They keep which one is shown, the tab the session's
 * `context` names; observation, actions, input, and every page-scoped wait
 * follow it.
 *
 * A tab the app opens (`window.open`, a `target="_blank"` link) joins once
 * a document loads in it, and stays in the background unless
 * `browser.waitForPopup` waits for it. A tab whose only navigation went
 * elsewhere (a download, a `204`, a `mailto:` link) never gets a document,
 * so it never joins. When the shown tab closes, the tab that opened it is
 * shown next, else the open tab shown most recently.
 *
 * A tab that cannot be shown fails whoever asked for it: the step that
 * opened or showed it, or the `browser.waitForPopup` waiting for it. When
 * no step asked, as for the tab shown once the shown one closed, the host
 * is told, and the next step fails with the cause. A tab that closed while
 * it was shown is no failure.
 */

import { EngineError, TestError, type EngineTabs } from '@e2e-dev/core/engine';
import { message } from '../errors.ts';
import { afterTrigger, type OperationBudget } from './budget.ts';

/** One tab of the attempt. The same tab is the same object for the whole attempt. */
export interface AttemptTab {
  /** Its top-level browsing context. */
  readonly context: string;
  /** The tab it was opened from; undefined for the attempt's own tab and one a test opened. */
  readonly opener: AttemptTab | undefined;
  /** When it was last shown, in the attempt's order; 0 for never. */
  shownAt: number;
  /** Whether it has closed. */
  closed: boolean;
}

/** What the tabs ask of the session that shows them. */
export interface TabHost {
  /** Sets up `context` to be shown: the attempt's viewport, and with `front` the browser's focus. */
  prepare(context: string, front: boolean): Promise<void>;
  /** Whether `context` has closed, asked of the browser: its answer to a command can come before the event that tells of the close. */
  gone(context: string): Promise<boolean>;
  /** Another tab is shown, or none: every ref and frame of the one shown before is forgotten. */
  forget(): void;
  /** Moves the recording to `context`, ending the one before; `closed` when that one closed on its own. */
  record(context: string | undefined, closed: boolean): Promise<void>;
  /** Asks the browser to close `context`. */
  close(context: string): Promise<void>;
  /** A tab change no step waits for failed: the next step fails with `error`. */
  failed(error: Error): void;
}

/** A tab the app opened that has no document yet. */
interface Unjoined {
  readonly opener: AttemptTab | undefined;
  /** Whether a navigation to a document other than the blank one started in it. */
  started: boolean;
  /** The URL of the navigation it is loading, until that one fails. */
  loading: string | undefined;
}

/** A `browser.waitForPopup` waiting for the next tab the app opens, told the tab and the change that shows it, which rejects when the tab cannot be shown. */
type PopupWaiter = (tab: AttemptTab, shown: Promise<void>) => void;

/** The attempt's tabs and the changes between them, in the order they happen. */
export class AttemptTabs {
  private open: AttemptTab[] = [];
  /** The open tab shown now, if any. */
  private showing: AttemptTab | undefined;
  private readonly unjoined = new Map<string, Unjoined>();
  /** How many times a tab was shown, for `AttemptTab.shownAt`. */
  private shown = 0;
  /**
   * Tab changes in the order they happened: showing a tab, returning from
   * one that closed. Settles once the last has finished; never rejects.
   */
  private work: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<PopupWaiter>();
  /** Closes being awaited, each resolved once its tab is gone from the tabs. */
  private readonly closes = new Map<AttemptTab, () => void>();

  constructor(private readonly host: TabHost) {}

  /** The open tabs, in the order they opened. */
  list(): readonly AttemptTab[] {
    return this.open;
  }

  /**
   * The browsing context of every tab the attempt has open: the ones in
   * `list`, and the ones the app opened that have yet to join, or never
   * will. What the attempt closes when it ends in a user context that stays.
   */
  contexts(): string[] {
    return [...this.open.map((tab) => tab.context), ...this.unjoined.keys()];
  }

  /** The open tab of `context`, if it is one. */
  find(context: string | null | undefined): AttemptTab | undefined {
    return context == null ? undefined : this.open.find((tab) => tab.context === context);
  }

  /** Whether `context` is a tab the attempt has open, one that has yet to join included. */
  holds(context: string): boolean {
    return this.find(context) !== undefined || this.unjoined.has(context);
  }

  /** The tab shown now, if any. */
  active(): AttemptTab | undefined {
    return this.showing;
  }

  /** Where `tab` stands among the open tabs, for a snapshot read from it; undefined while it is the only one, or once it closed. */
  describe(tab: AttemptTab | undefined): EngineTabs | undefined {
    const active = tab === undefined ? -1 : this.open.indexOf(tab);
    return this.open.length < 2 || active === -1 ? undefined : { count: this.open.length, active };
  }

  /** Settles once every tab change queued so far has finished. */
  settled(): Promise<void> {
    return this.work;
  }

  /**
   * Records a tab the attempt opened itself (its own tab, `browser.newTab`)
   * and shows it. With no tab shown it is the attempt's first, and stays
   * where the browser opened it or its user left it; one opened beside the
   * shown tab takes its place at the front, as a tab shown later does. A
   * tab that cannot be shown leaves the tabs again, and its failure is
   * thrown; one that closed, or that the tabs forgot, while it was being
   * shown is `NODE_STALE`.
   */
  async own(context: string): Promise<AttemptTab> {
    const tab: AttemptTab = { context, opener: undefined, shownAt: 0, closed: false };
    this.open.push(tab);
    try {
      await this.inTurn(() => this.reveal(tab, this.showing !== undefined));
    } catch (cause) {
      this.destroyed(context);
      throw cause;
    }
    if (tab.closed) throw new EngineError('NODE_STALE', 'the tab closed while it opened', { retryable: true });
    return tab;
  }

  /** The app opened `context` from `opener`: it joins once a document loads in it. */
  appOpened(context: string, opener: string | null | undefined): void {
    this.unjoined.set(context, { opener: this.find(opener), started: false, loading: undefined });
  }

  /** A navigation started in a top-level context. */
  navigationStarted(context: string, url: string): void {
    const pending = this.unjoined.get(context);
    if (pending === undefined || url === 'about:blank') return;
    pending.started = true;
    pending.loading = url;
  }

  /** A navigation failed in a top-level context: the tab is no longer loading it. */
  navigationFailed(context: string): void {
    const pending = this.unjoined.get(context);
    if (pending !== undefined) pending.loading = undefined;
  }

  /**
   * A document loaded in a top-level context. A tab the app opened joins
   * with its first document: one it navigated to, or the blank one when
   * nothing else started in it, as a tab the app writes itself. The blank
   * document a failed navigation leaves behind is none. Returns the tab when
   * this joined it. A `browser.waitForPopup` waiting for it has it shown, and
   * is told when that fails; a tab that closed while it was shown is none
   * (`unlessClosed`).
   */
  loaded(context: string, url: string): AttemptTab | undefined {
    const pending = this.unjoined.get(context);
    if (pending === undefined || (url === 'about:blank' && pending.started)) return undefined;
    this.unjoined.delete(context);
    const tab: AttemptTab = { context, opener: pending.opener, shownAt: 0, closed: false };
    this.open.push(tab);
    if (this.waiters.size > 0) {
      const shown = this.inTurn(() => this.unlessClosed(tab, () => this.reveal(tab, true)));
      for (const waiter of this.waiters) waiter(tab, shown);
    }
    return tab;
  }

  /**
   * A top-level context closed. When it was the shown tab, its nearest open
   * opener is shown next, else the open tab shown most recently, at once;
   * its setup and the recording follow in turn. No step waits for those, so
   * a failure of either is the host's to report (`TabHost.failed`): the tab
   * is shown, and may lack the attempt's viewport or the browser's focus.
   * The recording moves whatever the setup did. A tab that closed in turn
   * while it was set up is no failure (`unlessClosed`).
   */
  destroyed(context: string): void {
    this.unjoined.delete(context);
    const tab = this.find(context);
    if (tab === undefined) return;
    tab.closed = true;
    this.open.splice(this.open.indexOf(tab), 1);
    this.closes.get(tab)?.();
    this.closes.delete(tab);
    if (this.showing !== tab) return;
    const next = this.returnTo(tab);
    this.publish(next);
    void this.inTurn(async () => {
      try {
        if (next !== undefined && this.showing === next) await this.unlessClosed(next, () => this.host.prepare(next.context, true));
      } finally {
        await this.host.record(next !== undefined && this.showing === next ? next.context : undefined, true);
      }
    }).catch((cause: unknown) => {
      this.host.failed(new EngineError('ENGINE_FAILURE', `showing the tab behind a tab that closed failed: ${message(cause)}`, { retryable: false, cause }));
    });
  }

  /** Forgets every tab, the shown one with them, as a restart or a new user context closes them all. */
  clear(): void {
    for (const tab of this.open) tab.closed = true;
    this.open = [];
    this.unjoined.clear();
    for (const resolve of this.closes.values()) resolve();
    this.closes.clear();
    this.publish(undefined);
  }

  /** Shows one open tab: every read and action from now on is on it. `ACTION_FAILED` once it closed. */
  async show(tab: AttemptTab): Promise<void> {
    const open = (): void => {
      if (tab.closed) throw new TestError('ACTION_FAILED', 'the tab is closed');
    };
    open();
    // Checked again in turn: a change queued before this one may be the tab closing.
    await this.inTurn(async () => {
      open();
      await this.reveal(tab, true);
    });
  }

  /** Shows the open tab at `index` in opening order, as the agent's `switchTab` counts them. */
  async showAt(index: number): Promise<void> {
    await this.show(this.at(index));
  }

  /**
   * Closes one tab and waits until it is gone and the tab shown next is
   * shown. With `keepLast`, naming the tab, the last open tab stays:
   * closing it is `ACTION_FAILED`.
   */
  async close(tab: AttemptTab, keepLast?: string): Promise<void> {
    const refused = (): boolean => keepLast !== undefined && this.open.every((other) => other === tab);
    const refusal = (): TestError => new TestError('ACTION_FAILED', `${keepLast ?? 'the tab'} is the only open tab`);
    if (!tab.closed && refused()) throw refusal();
    // Checked again in turn: a change queued before this one may be another tab closing.
    await this.inTurn(async () => {
      if (tab.closed) return;
      if (refused()) throw refusal();
      const gone = new Promise<void>((resolve) => this.closes.set(tab, resolve));
      try {
        await this.host.close(tab.context);
      } catch (cause) {
        this.closes.delete(tab);
        if (tab.closed) return;
        throw cause;
      }
      await gone;
    });
    await this.settled();
  }

  /** Closes the open tab at `index` in opening order, as the agent's `closeTab` counts them; the last open tab stays. */
  async closeAt(index: number): Promise<void> {
    await this.close(this.at(index), `tab ${String(index + 1)}`);
  }

  /**
   * Waits for the next tab the app opens: `opened` resolves with it once it
   * is shown, or with it closed when it closed first, and rejects with what
   * kept it from being shown. It can settle before anything awaits it (the
   * trigger of `waitForPopup` still running), so a rejection nothing awaits
   * yet is handled here. `loading` names the page a tab the app opened is
   * still loading, for a wait that times out. `cancel` stops waiting.
   */
  nextPopup(): { readonly opened: Promise<AttemptTab>; loading(): string | undefined; cancel(): void } {
    let waiter!: PopupWaiter;
    const opened = new Promise<AttemptTab>((resolve) => {
      waiter = (tab, shown) => {
        this.waiters.delete(waiter);
        resolve(shown.then(() => tab));
      };
    });
    this.waiters.add(waiter);
    opened.catch(() => undefined);
    return {
      opened,
      loading: () => [...this.unjoined.values()].findLast((pending) => pending.loading !== undefined)?.loading,
      cancel: () => {
        this.waiters.delete(waiter);
      },
    };
  }

  /**
   * Runs `trigger` and waits for the next tab the app opens, resolving once
   * it is shown (`browser.waitForPopup`, over `afterTrigger`). A tab that
   * opened and could not be shown fails the wait with the cause. A wait that
   * runs out names the page a tab was still loading, else whether the
   * trigger had resolved.
   */
  async waitForPopup(trigger: () => Promise<void>, budget: OperationBudget): Promise<AttemptTab> {
    const waitMs = budget.timeoutMs;
    const popup = this.nextPopup();
    try {
      return await afterTrigger(trigger, () => popup.opened, budget, (triggerMs) => {
        const url = popup.loading();
        if (url !== undefined) return new TestError('ACTION_FAILED', `the tab the app opened did not load ${url} within ${waitMs}ms`);
        return new TestError(
          'ACTION_FAILED',
          triggerMs === undefined ? `browser.waitForPopup exceeded its timeout of ${waitMs}ms` : `no tab opened within ${waitMs}ms; the trigger resolved after ${triggerMs}ms`,
        );
      });
    } finally {
      popup.cancel();
    }
  }

  /** The open tab at `index` in opening order, or an `ACTION_FAILED` the model reads. */
  private at(index: number): AttemptTab {
    const tab = Number.isSafeInteger(index) ? this.open[index] : undefined;
    if (tab === undefined) {
      const count = this.open.length;
      throw new TestError('ACTION_FAILED', `there is no tab ${String(index + 1)}: ${String(count)} tab${count === 1 ? ' is' : 's are'} open`);
    }
    return tab;
  }

  /** Shows `tab` once it is set up, at the `front` of the browser or where it is, then moves the recording to it; a tab that closed meanwhile is left alone. */
  private async reveal(tab: AttemptTab, front: boolean): Promise<void> {
    if (this.showing === tab) return;
    await this.host.prepare(tab.context, front);
    if (tab.closed) return;
    this.publish(tab);
    await this.host.record(tab.context, false);
  }

  /**
   * Runs `change`, which sets `tab` up or shows it, for a caller that takes
   * a tab closing under it for no failure: the app closed it, as it may any
   * tab. The browser can fail a command of a closed tab before its event
   * tells of the close, so the host is asked (`TabHost.gone`), and a tab it
   * finds gone leaves the tabs here. Any other failure is thrown, as is the
   * change's own when the host cannot tell.
   */
  private async unlessClosed(tab: AttemptTab, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (cause) {
      if (!tab.closed && !(await this.host.gone(tab.context).catch(() => false))) throw cause;
      this.destroyed(tab.context);
    }
  }

  /** Makes `tab` the shown one at once, or none; the host forgets what it kept of the one shown before. */
  private publish(tab: AttemptTab | undefined): void {
    this.showing = tab;
    this.host.forget();
    if (tab !== undefined) tab.shownAt = ++this.shown;
  }

  /** The tab shown when `closed` closes: its nearest open opener, else the open tab shown most recently. */
  private returnTo(closed: AttemptTab): AttemptTab | undefined {
    for (let opener = closed.opener; opener !== undefined; opener = opener.opener) {
      if (!opener.closed) return opener;
    }
    return this.open.reduce<AttemptTab | undefined>((best, tab) => (best === undefined || tab.shownAt > best.shownAt ? tab : best), undefined);
  }

  /**
   * Queues one tab change behind the earlier ones and returns it. The queue
   * never rejects: the change's own failure is its caller's to take.
   */
  private inTurn(work: () => Promise<void>): Promise<void> {
    const run = this.work.then(work);
    this.work = run.catch(() => undefined);
    return run;
  }
}
