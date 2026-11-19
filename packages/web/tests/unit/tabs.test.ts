/**
 * The attempt's tabs on their own: which tab the app opened joins, where the
 * screen goes when the shown tab closes, and what the agent's index-based
 * verbs refuse.
 */

import { describe, expect, it } from 'vitest';
import { AttemptTabs } from '../../src/driver/tabs.ts';

/**
 * Tabs over a host that records what it was asked to forget, record, and
 * close and what it was told failed, with the attempt's own tab `own` shown.
 * `refuse` makes the setup of a tab fail from then on, with the error it
 * returns for that tab; `lost` names the tabs the browser no longer has,
 * whether or not the tabs were told.
 */
async function tabsOn() {
  let forgotten = 0;
  let refusal: (context: string) => Error | undefined = () => undefined;
  const recorded: { context: string | undefined; closed: boolean }[] = [];
  const closed: string[] = [];
  const prepared: string[] = [];
  const failed: Error[] = [];
  const lost = new Set<string>();
  const tabs: AttemptTabs = new AttemptTabs({
    prepare: async (context) => {
      const error = refusal(context);
      if (error !== undefined) throw error;
      prepared.push(context);
    },
    gone: async (context) => lost.has(context),
    forget: () => void (forgotten += 1),
    record: async (context, wasClosed) => void recorded.push({ context, closed: wasClosed }),
    close: async (context) => {
      closed.push(context);
      tabs.destroyed(context);
    },
    failed: (error) => void failed.push(error),
  });
  await tabs.own('own');
  return {
    tabs,
    shown: () => tabs.active()?.context,
    forgotten: () => forgotten,
    recorded,
    closed,
    prepared,
    failed,
    lost,
    refuse: (answer: (context: string) => Error | undefined) => void (refusal = answer),
  };
}

/** Rejections no handler took by the time the queued work and one macrotask ran. */
async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => void unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return unhandled;
}

describe('AttemptTabs', () => {
  it('names every tab the attempt has open, the ones yet to join and the one that never will with the ones listed, until each closes', async () => {
    const { tabs } = await tabsOn();
    tabs.appOpened('joined', 'own');
    tabs.loaded('joined', 'http://app.test/joined');
    tabs.appOpened('loading', 'own');
    tabs.navigationStarted('loading', 'http://app.test/slow');
    tabs.appOpened('nowhere', 'own');
    tabs.navigationStarted('nowhere', 'http://app.test/export.csv');
    tabs.navigationFailed('nowhere');
    expect(tabs.list().map((tab) => tab.context)).toEqual(['own', 'joined']);
    expect(tabs.contexts()).toEqual(['own', 'joined', 'loading', 'nowhere']);
    tabs.destroyed('loading');
    tabs.destroyed('joined');
    expect(tabs.contexts()).toEqual(['own', 'nowhere']);
    tabs.clear();
    expect(tabs.contexts()).toEqual([]);
  });

  it('joins a tab the app opened with its first document, never with the blank one a failed navigation left', async () => {
    const { tabs } = await tabsOn();
    tabs.appOpened('download', 'own');
    tabs.navigationStarted('download', 'http://app.test/export.csv');
    tabs.navigationFailed('download');
    expect(tabs.loaded('download', 'about:blank')).toBeUndefined();
    tabs.appOpened('written', 'own');
    expect(tabs.loaded('written', 'about:blank')?.opener?.context).toBe('own');
    tabs.appOpened('help', 'own');
    tabs.navigationStarted('help', 'http://app.test/help');
    expect(tabs.loaded('help', 'http://app.test/help')).toBeDefined();
    expect(tabs.list().map((tab) => tab.context)).toEqual(['own', 'written', 'help']);
    expect(tabs.describe(tabs.active())).toEqual({ count: 3, active: 0 });
  });

  it('shows the nearest open opener when the shown tab closes, else the tab shown most recently', async () => {
    const { tabs, shown, recorded } = await tabsOn();
    tabs.appOpened('middle', 'own');
    const middle = tabs.loaded('middle', 'http://app.test/middle')!;
    tabs.appOpened('last', 'middle');
    const last = tabs.loaded('last', 'http://app.test/last')!;
    await tabs.show(middle);
    await tabs.show(last);
    tabs.destroyed('middle');
    expect(shown()).toBe('last');
    tabs.destroyed('last');
    expect(shown()).toBe('own');
    await tabs.settled();
    expect(recorded.at(-1)).toEqual({ context: 'own', closed: true });
    await expect(tabs.show(middle)).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'the tab is closed' });
  });

  it('refuses an index no tab is at, and closing the last open tab, as ACTION_FAILED', async () => {
    const { tabs, closed } = await tabsOn();
    await expect(tabs.showAt(1)).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'there is no tab 2: 1 tab is open' });
    await expect(tabs.closeAt(0)).rejects.toMatchObject({ code: 'ACTION_FAILED', message: 'tab 1 is the only open tab' });
    tabs.appOpened('popup', 'own');
    tabs.loaded('popup', 'http://app.test/popup');
    const both = await Promise.allSettled([tabs.closeAt(1), tabs.closeAt(0)]);
    expect(both.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(closed).toEqual(['popup']);
  });

  it('shows the next tab the app opens to a popup wait, and names the page one is still loading', async () => {
    const { tabs, shown } = await tabsOn();
    const popup = tabs.nextPopup();
    tabs.appOpened('slow', 'own');
    tabs.navigationStarted('slow', 'http://app.test/slow');
    expect(popup.loading()).toBe('http://app.test/slow');
    tabs.loaded('slow', 'http://app.test/slow');
    expect((await popup.opened).context).toBe('slow');
    expect(shown()).toBe('slow');
    popup.cancel();
  });

  it('shows no tab once it forgot them all, and has the host forget each time the shown tab changes', async () => {
    const { tabs, shown, forgotten } = await tabsOn();
    tabs.appOpened('popup', 'own');
    const popup = tabs.loaded('popup', 'http://app.test/popup')!;
    expect(forgotten()).toBe(1);
    await tabs.show(popup);
    expect(forgotten()).toBe(2);
    tabs.clear();
    expect([shown(), tabs.list(), popup.closed, forgotten()]).toEqual([undefined, [], true, 3]);
    await expect(tabs.own('next')).resolves.toMatchObject({ context: 'next', shownAt: 3 });
    expect(shown()).toBe('next');
  });

  it('fails a popup wait with what kept the tab from being shown, also when it settles before the trigger returned', async () => {
    const { tabs, shown, refuse, recorded } = await tabsOn();
    const refusal = new Error('browsingContext.setViewport: unknown error: no viewport');
    refuse((context) => (context === 'popup' ? refusal : undefined));
    const unhandled = await unhandledDuring(async () => {
      let returned = false;
      const waited = tabs.waitForPopup(async () => {
        tabs.appOpened('popup', 'own');
        tabs.loaded('popup', 'http://app.test/popup');
        await tabs.settled();
        await new Promise((resolve) => setTimeout(resolve, 0));
        returned = true;
      }, { timeoutMs: 1_000, signal: new AbortController().signal });
      await expect(waited).rejects.toBe(refusal);
      expect(returned).toBe(true);
    });
    expect(unhandled).toEqual([]);
    expect(shown()).toBe('own');
    expect(tabs.list().map((tab) => tab.context)).toEqual(['own', 'popup']);
    expect(recorded).toEqual([{ context: 'own', closed: false }]);
  });

  it('resolves a popup wait with the tab closed when it closed while it was shown, told by an event or only by the browser', async () => {
    const { tabs, shown, refuse, lost, failed } = await tabsOn();
    refuse((context) => (context === 'own' ? undefined : new Error('script.callFunction: no such frame')));
    const told = tabs.nextPopup();
    tabs.appOpened('told', 'own');
    tabs.loaded('told', 'http://app.test/told');
    tabs.destroyed('told');
    expect(await told.opened).toMatchObject({ context: 'told', closed: true });

    const asked = tabs.nextPopup();
    tabs.appOpened('asked', 'own');
    lost.add('asked');
    tabs.loaded('asked', 'http://app.test/asked');
    expect(await asked.opened).toMatchObject({ context: 'asked', closed: true });
    expect(tabs.list().map((tab) => tab.context)).toEqual(['own']);
    expect(shown()).toBe('own');
    expect(failed).toEqual([]);
  });

  it('tells the host when the tab behind a shown tab that closed cannot be set up, and moves the recording all the same', async () => {
    const { tabs, shown, refuse, recorded, failed } = await tabsOn();
    tabs.appOpened('popup', 'own');
    await tabs.show(tabs.loaded('popup', 'http://app.test/popup')!);
    const refusal = new Error('browsingContext.activate: unknown error: no window');
    refuse(() => refusal);
    tabs.destroyed('popup');
    expect(shown()).toBe('own');
    expect(failed).toEqual([]);
    await tabs.settled();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
      message: 'showing the tab behind a tab that closed failed: browsingContext.activate: unknown error: no window',
      cause: refusal,
    });
    expect(recorded.at(-1)).toEqual({ context: 'own', closed: true });
    expect(shown()).toBe('own');
  });

  it('moves on to the next tab when the tab behind a shown tab that closed has closed too, and reports no failure', async () => {
    const { tabs, shown, refuse, recorded, prepared, failed, lost } = await tabsOn();
    tabs.appOpened('middle', 'own');
    const middle = tabs.loaded('middle', 'http://app.test/middle')!;
    tabs.appOpened('last', 'middle');
    const last = tabs.loaded('last', 'http://app.test/last')!;
    await tabs.show(middle);
    await tabs.show(last);
    refuse((context) => (context === 'middle' ? new Error('browsingContext.setViewport: no such frame') : undefined));
    lost.add('middle');
    tabs.destroyed('last');
    expect(shown()).toBe('middle');
    await tabs.settled();
    expect(middle.closed).toBe(true);
    // The close of `middle`, found while it was set up, queued a change of its own.
    await tabs.settled();
    expect(shown()).toBe('own');
    expect(failed).toEqual([]);
    expect(prepared.at(-1)).toBe('own');
    expect(recorded.slice(-2)).toEqual([{ context: undefined, closed: true }, { context: 'own', closed: true }]);
  });
});
