/** A BiDi session's own state: refs a locate just proved, the tabs it opens and the ones it closes again, and the user contexts it removes or refuses to set up once the attempt closed. */

import { describe, expect, it, vi } from 'vitest';
import { connectSource } from '../../src/driver/browser-source.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { clickSources, moveSources } from '../../src/driver/input-sources.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import type { NodeRef } from '@e2e-dev/core/engine';
import { adoptable, FakeBidi, type Reply, settle } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';
import { closedTabs, session, sharedSession, unopened } from '../helpers/session-fake.ts';
import { ElementRef } from '../../src/driver/script.ts';

describe('BidiSession.refs', () => {
  it('claims a located ref as fresh once, and only while no input went out since its locate', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const target = { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } as const };
    held.refs.storeLocated('1', target);
    held.refs.storeLocated('2', target);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(true);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(false);
    await held.input.send(moveSources(1, 1));
    expect(held.refs.claimFresh({ id: '2' } as NodeRef)).toBe(false);
  });

  it('claims no located ref as fresh after a click the page swallowed, whose pointer move still reached it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    held.refs.storeLocated('1', { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    await held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: async () => null, suppressed: () => true });
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(false);
  });
});

/** The tab commands `fake` got, in order, each with its context. */
function tabCommands(fake: FakeBidi): string[] {
  return fake.sent
    .filter((command) => ['browsingContext.create', 'browsingContext.setViewport', 'browsingContext.activate'].includes(command.method))
    .map((command) => `${command.method.replace('browsingContext.', '')} ${String(command.params['context'] ?? '')}`.trim());
}

/** Numbers the user contexts `fake` creates (`uc-1`, `uc-2`), and names each tab it opens after the user context it opened in. */
function numbered(fake: FakeBidi): FakeBidi {
  let userContexts = 0;
  return fake
    .on('browser.createUserContext', () => ({ result: { userContext: `uc-${String(++userContexts)}` } }))
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.create', (params) => ({ result: { context: `tab in ${String(params['userContext'])}` } }));
}

/**
 * Holds `held`'s network on a request count it starts (`track`), so a tab
 * the network is asked to cover waits behind it, as it does behind any
 * round trip of the network's. Returns the release, which resolves once the
 * count is on.
 */
function holdNetwork(fake: FakeBidi, held: BidiSession): () => Promise<void> {
  const { held: released, release } = gate();
  fake.on('session.subscribe', async () => {
    await released;
    return { result: { subscription: 's' } };
  });
  const tracking = held.network.track();
  return async () => {
    release();
    await tracking;
  };
}

describe('BidiSession tabs', () => {
  it('opens its first tab at the viewport without activating it, and a tab opened beside it at the front', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    expect(tabCommands(fake)).toEqual(['create', 'setViewport tab']);
    // Scale factor 1 whatever the display's, so a headed run renders what a headless one does.
    expect(fake.commands('browsingContext.setViewport')[0]?.params).toMatchObject({ context: 'tab', devicePixelRatio: 1 });
    const beside = await held.newTab();
    expect(tabCommands(fake).slice(2)).toEqual(['create', 'setViewport tab-2', 'activate tab-2']);
    expect(held.context).toBe('tab-2');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab', 'tab-2']);
    expect(held.tabs.active()).toBe(beside);
  });

  /**
   * Gives `fake` one window of 50 by 60, 10 of its height chrome, which
   * every tab is in and which grows no taller than `tallest`. Returns the
   * window and viewport commands `fake` got, in order.
   */
  function oneWindow(fake: FakeBidi, tallest: number): () => string[] {
    const window = { clientWindow: 'w', active: true, state: 'normal', x: 0, y: 0, width: 50, height: 60 };
    fake
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', { result: { context: 'tab' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', clientWindow: 'w' }] } })
      .on('browser.getClientWindows', () => ({ result: { clientWindows: [{ ...window }] } }))
      .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'object', value: [['width', { type: 'number', value: 0 }], ['height', { type: 'number', value: 10 }]] } } })
      .on('browser.setClientWindowState', (params) => {
        Object.assign(window, { width: params['width'], height: Math.min(Number(params['height']), tallest) });
        return { result: { ...window } };
      });
    return () => fake.sent
      .filter((command) => ['browser.setClientWindowState', 'browsingContext.setViewport'].includes(command.method))
      .map((command) => {
        const size = (command.params['viewport'] ?? command.params) as { width: number; height: number };
        return `${command.method.split('.')[1]!} ${String(size.width)}x${String(size.height)}`;
      });
  }

  it('grows a tab\'s window to hold the viewport before it sizes the tab, where a window cuts a viewport short', async () => {
    const fake = new FakeBidi();
    const sized = oneWindow(fake, Infinity);
    const clipped = unopened(fake, 'firefox', 'fresh', { traits: BROWSER_TRAITS.firefox });
    await clipped.openUserContext(new AbortController().signal);
    await clipped.ensureContext();
    expect(sized()).toEqual(['setClientWindowState 100x110', 'setViewport 100x100']);
    await clipped.setViewport({ width: 300, height: 200 });
    expect(sized().slice(2)).toEqual(['setClientWindowState 300x210', 'setViewport 300x200']);
    await clipped.setViewport({ width: 100, height: 100 });
    expect(sized().slice(4)).toEqual(['setViewport 100x100']);
  });

  it('keeps the viewport it has when the window cannot hold a new one, for the shown tab and the tabs after it', async () => {
    const fake = new FakeBidi();
    const sized = oneWindow(fake, 500);
    const clipped = unopened(fake, 'firefox', 'fresh', { traits: BROWSER_TRAITS.firefox });
    await clipped.openUserContext(new AbortController().signal);
    await clipped.ensureContext();
    await expect(clipped.setViewport({ width: 300, height: 600 })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('cannot hold a 300x600 viewport: it shows at most 490 pixels of the page\'s height') });
    expect(sized().slice(2)).toEqual(['setClientWindowState 300x610', 'setClientWindowState 100x110']);
    expect(await clipped.viewportSize()).toEqual({ width: 100, height: 100 });
    await clipped.setViewport({ width: 300, height: 490 });
    expect(sized().slice(4)).toEqual(['setClientWindowState 300x500', 'setViewport 300x490']);
    expect(await clipped.viewportSize()).toEqual({ width: 300, height: 490 });
  });

  it('sizes a tab and no window where a window cuts no viewport short', async () => {
    const fake = new FakeBidi();
    const sized = oneWindow(fake, Infinity);
    const whole = unopened(fake, 'chromium', 'fresh', { traits: BROWSER_TRAITS.chromium });
    await whole.openUserContext(new AbortController().signal);
    await whole.ensureContext();
    await whole.setViewport({ width: 300, height: 200 });
    expect(sized()).toEqual(['setViewport 100x100', 'setViewport 300x200']);
    expect(fake.commands('browser.getClientWindows')).toEqual([]);
  });

  it('answers its own tab to a newTab before any tab is open, opened once', async () => {
    const fake = new FakeBidi()
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', { result: { context: 'tab' } });
    const opening = unopened(fake);
    await opening.openUserContext(new AbortController().signal);
    const [context, tab] = await Promise.all([opening.ensureContext(), opening.newTab()]);
    expect(context).toBe('tab');
    expect(opening.tabs.list()).toEqual([tab]);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
  });

  it('closes a tab it created that it cannot show, and opens another on the next use', async () => {
    let refuse = true;
    const fake = new FakeBidi().on('browsingContext.setViewport', () => (refuse ? { error: 'unknown error', message: 'no viewport' } : { result: {} }));
    const opened = ['tab', 'tab-2'];
    fake
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const opening = unopened(fake);
    await opening.openUserContext(new AbortController().signal);
    await expect(opening.ensureContext()).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(opening.context).toBeUndefined();
    expect(opening.tabs.list()).toEqual([]);
    refuse = false;
    await expect(opening.ensureContext()).resolves.toBe('tab-2');
    expect(opening.tabs.list().map((tab) => tab.context)).toEqual(['tab-2']);
  });

  it('closes a tab a newTab created that it cannot show, and keeps showing the tab before it', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.activate', { error: 'unknown error', message: 'no focus' });
    await expect(held.newTab()).rejects.toThrow('no focus');
    expect(closedTabs(fake)).toEqual(['tab-2']);
    expect(held.context).toBe('tab');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab']);
  });

  it('closes a tab it created when the network cannot cover it', async () => {
    const tree = new ContextTree();
    const fake = new FakeBidi()
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('session.subscribe', { result: { subscription: 's' } })
      .on('network.addIntercept', { error: 'unknown error', message: 'no intercept' })
      .on('browsingContext.create', () => {
        tree.created('tab', 'mine', null);
        return { result: { context: 'tab' } };
      });
    const shared = unopened(fake, 'chromium', 'fresh', {
      settings: { viewport: null },
      exclusive: false,
      protectedApp: new ProtectedApp(new Set(['http://app.test']), { 'x-preview': 'on' }, undefined),
      tree,
    });
    await shared.openUserContext(new AbortController().signal);
    await expect(shared.ensureContext()).rejects.toThrow('no intercept');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(shared.tabs.list()).toEqual([]);
  });

  it('leaves a tab it adopted open when it cannot show it, and adopts it again on the next use', async () => {
    let refuse = true;
    const fake = adoptable(new FakeBidi(), 'theirs')
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
      .on('browsingContext.setViewport', () => (refuse ? { error: 'unknown error', message: 'no viewport' } : { result: {} }));
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await expect(attached.openUserContext(new AbortController().signal)).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual([]);
    expect(attached.tabs.list()).toEqual([]);
    refuse = false;
    await expect(attached.ensureContext()).resolves.toBe('theirs');
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
    expect(fake.commands('browsingContext.create')).toEqual([]);
    expect(fake.commands('browsingContext.activate')).toEqual([]);
  });

  it('fails a tab open stale, and closes the tab unshown, when a reset replaced the user context before the tab joined', async () => {
    const fake = numbered(new FakeBidi());
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const release = holdNetwork(fake, resetting);
    const opening = resetting.ensureContext();
    await settle();
    const replacing = resetting.replaceUserContext(new AbortController().signal);
    await settle();
    expect(resetting.userContext.id).toBe('uc-2');
    await release();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    await replacing;
    expect(tabCommands(fake)).toEqual(['create']);
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
    expect(resetting.context).toBeUndefined();
    await expect(resetting.ensureContext()).resolves.toBe('tab in uc-2');
  });

  it('fails a tab open stale when a reset forgot the tab while it was being shown', async () => {
    const { held: sizing, release: sized } = gate();
    const fake = numbered(new FakeBidi()).on('browsingContext.setViewport', () => sizing.then(() => ({ result: {} })));
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const opening = resetting.ensureContext();
    await settle();
    expect(resetting.tabs.list().map((tab) => tab.context)).toEqual(['tab in uc-1']);
    await resetting.replaceUserContext(new AbortController().signal);
    sized();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
    expect(resetting.context).toBeUndefined();
    expect(resetting.tabs.list()).toEqual([]);
  });

  it('opens the first tab of the user context a reset moved to, never joining one still opening in the old', async () => {
    const created: (() => void)[] = [];
    const fake = numbered(new FakeBidi()).on('browsingContext.create', (params) =>
      new Promise((resolve) => created.push(() => resolve({ result: { context: `tab in ${String(params['userContext'])}` } }))));
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const opening = resetting.ensureContext();
    await settle();
    await resetting.replaceUserContext(new AbortController().signal);
    const first = resetting.ensureContext();
    await settle();
    created[0]!();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    const second = resetting.ensureContext();
    await settle();
    expect(created).toHaveLength(2);
    created[1]!();
    await expect(Promise.all([first, second])).resolves.toEqual(['tab in uc-2', 'tab in uc-2']);
    expect(fake.commands('browsingContext.create').map((command) => command.params['userContext'])).toEqual(['uc-1', 'uc-2']);
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
  });

  it('closes a tab still opening when the attempt closes in the browser’s own user context', async () => {
    const opened = ['first', 'second'];
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const kept = unopened(fake, 'chromium', 'default');
    await kept.openUserContext(new AbortController().signal);
    await kept.ensureContext();
    const release = holdNetwork(fake, kept);
    const opening = kept.newTab();
    await settle();
    const closing = kept.close();
    await settle();
    await release();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    await closing;
    expect(closedTabs(fake)).toEqual(['first', 'second']);
    expect(kept.tabs.list()).toEqual([]);
  });

  it('keeps its tabs when a restart is given up on before it closed them', async () => {
    const { held: listing, release: listed } = gate();
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', () => listing.then(() => ({ result: { contexts: [{ context: 'tab', userContext: 'mine' }] } })));
    const givenUp = new AbortController();
    const restarting = held.replaceTabs(givenUp.signal);
    await settle();
    givenUp.abort(new Error('given up'));
    listed();
    await expect(restarting).rejects.toThrow('given up');
    expect(closedTabs(fake)).toEqual([]);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(held.context).toBe('tab');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab']);
  });

  it('opens the blank tab of a restart before it closes the old ones, so its user context is never without a tab', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }, { context: 'popup', userContext: 'mine' }, { context: 'theirs', userContext: 'other' }] } });
    await held.replaceTabs(new AbortController().signal);
    expect(fake.sent.filter((command) => command.method === 'browsingContext.create' || command.method === 'browsingContext.close').slice(1).map((command) => command.method))
      .toEqual(['browsingContext.create', 'browsingContext.close', 'browsingContext.close']);
    expect(closedTabs(fake)).toEqual(['tab', 'popup']);
    expect(held.context).toBe('tab-2');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab-2']);
  });

  it('closes the old tabs of a restart whose blank tab cannot open', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }] } });
    fake.on('browsingContext.setViewport', { error: 'unknown error', message: 'no viewport' });
    await expect(held.replaceTabs(new AbortController().signal)).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual(['tab-2', 'tab']);
    expect(held.context).toBeUndefined();
    expect(held.tabs.list()).toEqual([]);
  });

  it('closes the old tabs of a restart given up on while their recording ended, and opens no tab', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }] } });
    const givenUp = new AbortController();
    vi.spyOn(held.video, 'contextClosing').mockImplementation(async () => givenUp.abort(new Error('given up')));
    await expect(held.replaceTabs(givenUp.signal)).rejects.toThrow('given up');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(held.context).toBeUndefined();
  });

  it('closes the old tabs of a restart whose network cannot let go of them, and leaves the failure to the next step', async () => {
    const fake = new FakeBidi();
    const shared = await sharedSession(fake);
    fake.on('network.removeIntercept', (params) => (params['intercept'] === 'intercept-2' ? { error: 'unknown error', message: 'no removal' } : { result: {} }));
    await shared.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(shared.context).toBe('tab-2');
    await settle();
    expect(() => shared.latch.throwPending()).toThrow('no removal');
  });

  it('shows the tab an attached browser had open again after a restart, and closes only the ones opened since', async () => {
    const open = ['theirs', 'background'];
    const fake = adoptable(new FakeBidi(), 'theirs', 'background', 'mine')
      .on('script.getRealms', (params) => ({ result: { realms: [{ type: 'window', realm: `realm of ${String(params['context'])}`, origin: 'http://app.test', context: params['context'] }] } }))
      .on('script.callFunction', (params) => ({ result: { type: 'success', realm: 'r', result: { type: 'boolean', value: (params['target'] as { realm?: string }).realm === 'realm of theirs' } } }))
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', () => ({ result: { contexts: open.map((context) => ({ context, userContext: 'default' })) } }))
      .on('browsingContext.create', () => {
        open.push('mine');
        return { result: { context: 'mine' } };
      });
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await attached.openUserContext(new AbortController().signal);
    await attached.newTab();
    await attached.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['mine']);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(attached.context).toBe('theirs');
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
  });
});

describe('BidiSession.close', () => {
  it('removes a user context that a reset opened after the attempt closed', async () => {
    const { held: creating, release: created } = gate<Reply>();
    const fake = new FakeBidi()
      .on('browser.createUserContext', () => creating)
      .on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    const opening = closing.openUserContext(new AbortController().signal);
    await settle();
    await closing.close();
    created({ result: { userContext: 'late' } });
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['late']);
    expect(fake.commands('script.addPreloadScript')).toEqual([]);
  });

  it('sets up no user context for a reset that starts after the attempt closed', async () => {
    const fake = new FakeBidi().on('browser.createUserContext', { result: { userContext: 'mine' } }).on('network.addDataCollector', { result: { collector: 'c' } });
    const closed = unopened(fake);
    await closed.openUserContext(new AbortController().signal);
    await closed.close();
    await expect(closed.replaceUserContext(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.commands('browser.createUserContext')).toHaveLength(1);
    expect(closed.userContext.id).toBe('');
  });

  it('ends the attempt’s lifetime, so work it started that nothing awaits stops', async () => {
    const fake = new FakeBidi();
    const closing = unopened(fake);
    const lifetime = closing.lifetime;
    expect(lifetime.aborted).toBe(false);
    await closing.close();
    expect(lifetime.aborted).toBe(true);
  });

  it('owes a user context whose removal failed in a reset, and removes it on close', async () => {
    const names = ['first', 'second'];
    const fake = new FakeBidi().on('browser.createUserContext', async () => ({ result: { userContext: names.shift() } })).on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    await closing.openUserContext(new AbortController().signal);
    fake.on('browser.removeUserContext', { error: 'unknown error', message: 'busy' });
    await expect(closing.replaceUserContext(new AbortController().signal)).rejects.toThrow('busy');
    expect(closing.userContext.id).toBe('second');
    fake.on('browser.removeUserContext', { result: {} });
    await closing.close();
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first', 'first', 'second']);
  });

  it('removes the user context a reset replaced when the network cannot bind to the new one', async () => {
    const names = ['first', 'second'];
    const fake = new FakeBidi().on('browser.createUserContext', async () => ({ result: { userContext: names.shift() } })).on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    await closing.openUserContext(new AbortController().signal);
    fake.on('network.addDataCollector', { error: 'unknown error', message: 'no collector' });
    await expect(closing.replaceUserContext(new AbortController().signal)).rejects.toThrow('no collector');
    expect(closing.userContext.id).toBe('second');
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first']);
    await closing.close();
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first', 'second']);
  });

  it('closes every tab it opened in a browser it attached to, whichever is shown, and leaves the one it adopted', async () => {
    const fake = adoptable(new FakeBidi(), 'theirs')
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
      .on('browsingContext.create', { result: { context: 'mine' } });
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await attached.openUserContext(new AbortController().signal);
    await attached.newTab();
    await attached.tabs.show(attached.tabs.find('theirs')!);
    await attached.close();
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['mine']);
    expect(fake.commands('browser.removeUserContext')).toEqual([]);
  });

  it('closes every tab it opened in the browser’s own user context when a reset replaces it', async () => {
    const opened = ['first', 'second'];
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const kept = unopened(fake, 'chromium', 'default');
    await kept.openUserContext(new AbortController().signal);
    await kept.ensureContext();
    await kept.newTab();
    await kept.tabs.show(kept.tabs.find('first')!);
    await kept.replaceUserContext(new AbortController().signal);
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['first', 'second']);
    expect(kept.tabs.list()).toEqual([]);
  });
});

describe('a browser that can create no user context', () => {
  const refuses = (): FakeBidi => new FakeBidi().on('browser.createUserContext', () => ({ error: 'unknown error', message: 'Failed to create browser context.' }));

  it('fails as UNSUPPORTED_CAPABILITY with the browser\'s words and what to do instead, when its source knows', async () => {
    const instead = connectSource(() => 'ws://localhost:0', 'new').userContext;
    expect(instead).toEqual({ mode: 'fresh', instead: "Set web({ connect: { context: 'existing' } }) to drive the page it already shows." });
    const opened = unopened(refuses(), 'chromium', 'fresh', { settings: { withoutUserContexts: 'instead' in instead ? instead.instead : undefined } });
    await expect(opened.openUserContext(new AbortController().signal)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: "the browser cannot create a browser context (Failed to create browser context.). Set web({ connect: { context: 'existing' } }) to drive the page it already shows.",
    });
  });

  it('fails with the browser\'s own error when its source names nothing else to do', async () => {
    await expect(unopened(refuses()).openUserContext(new AbortController().signal)).rejects.toThrow('browser.createUserContext: unknown error: Failed to create browser context.');
  });
});
