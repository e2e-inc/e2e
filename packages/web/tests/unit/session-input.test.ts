/** The input a BiDi session sends: held keys through chords and modifier clicks until their `keyboard.up`, pressure, the viewport bound, what each tab holds while another is shown, and what counts as dispatched, a fill and a press on a node included. */

import { describe, expect, it, vi } from 'vitest';
import { perform } from '../../src/driver/actions.ts';
import { withDeadline } from '../../src/driver/budget.ts';
import { clickSources, moveSources, pressDownSources, swipeSources, typeSource } from '../../src/driver/input-sources.ts';
import { fixtureKeyStroke, strokeSource, type KeyPhase } from '../../src/driver/keyboard.ts';
import { DispatchScope, type BidiInput } from '../../src/driver/input.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import type { BrowserName } from '../../src/browsers.ts';
import { elementShown } from '../../src/in-page/actionability.ts';
import { elementAttached, fill, focus } from '../../src/in-page/edits.ts';
import { afterDispatch, BidiError, classify } from '../../src/errors.ts';
import type { NodeRef } from '@e2e-dev/core/engine';
import { contextInfo, FakeBidi, type Reply, type SentCommand } from '../helpers/bidi-fake.ts';
import { callOf } from '../helpers/page-call.ts';
import { session, sharedSession } from '../helpers/session-fake.ts';
import { ElementRef } from '../../src/driver/script.ts';

const SHIFT = '';

/** The BiDi key source of one `browser.keyboard` call, with Shift held before it or not. */
function keySource(key: string, phase: KeyPhase, shiftHeld: boolean) {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

/** Each `input.performActions` call's key actions. */
function keyActions(fake: FakeBidi): { type: string; value?: string }[][] {
  return fake.commands('input.performActions').map((command) =>
    (command.params['actions'] as { type: string; actions: { type: string; value?: string }[] }[]).filter((source) => source.type === 'key').flatMap((source) => source.actions));
}

describe('BidiInput.send', () => {
  it('neither presses nor releases a modifier the test holds, and lets its own up release it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    await held.input.send([keySource('Shift+ArrowRight', 'press', true)]);
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    await held.input.send([keySource('Shift', 'keyUp', true)]);
    const keys = keyActions(fake);
    expect(keys[0]).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(keys[1]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[2]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[3]).toEqual([{ type: 'keyUp', value: SHIFT }]);
  });

  it('keeps a click’s ticks when a held modifier joins one it adds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    const click = clickSources(5, 5, { modifiers: ['Shift', 'Control'] });
    await held.input.send(click);
    const sentKeys = keyActions(fake).at(-1)!;
    const askedKeys = (click.find((source) => source.type === 'key') as { actions: unknown[] }).actions;
    expect(sentKeys).toHaveLength(askedKeys.length);
    expect(sentKeys.filter((action) => action.value === SHIFT)).toEqual([]);
    expect(sentKeys.filter((action) => action.value === '').map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('releases a key with the value that pressed it, after the Shift that changed it is gone', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    for (const [key, phase] of [['Shift', 'keyDown'], ['a', 'keyDown'], ['Shift', 'keyUp'], ['a', 'keyUp']] as const) await held.input.key(fixtureKeyStroke(key, phase));
    expect(keyActions(fake).flat()).toEqual([
      { type: 'keyDown', value: SHIFT },
      { type: 'keyDown', value: 'A' },
      { type: 'keyUp', value: SHIFT },
      { type: 'keyUp', value: 'A' },
    ]);
  });

  it('records what a send holds only once the browser took it', async () => {
    let refuse = true;
    const fake = new FakeBidi().on('input.performActions', () => (refuse ? { error: 'invalid argument', message: 'no' } : { result: {} }));
    const held = await session(fake);
    await expect(held.input.send([keySource('Shift', 'keyDown', false)])).rejects.toThrow('no');
    refuse = false;
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    expect(keyActions(fake).at(-1)!.filter((action) => action.value === SHIFT).map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('moves with pressure only while a button is held, and remembers where the mouse went', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send(moveSources(10, 10));
    await held.input.send(pressDownSources(20, 20));
    await held.input.send(moveSources(30, 30));
    const moves = fake.commands('input.performActions').map((command) => (command.params['actions'] as { actions: { type: string; pressure?: number }[] }[])[0]!.actions[0]!.pressure);
    expect(moves).toEqual([undefined, undefined, 0.5]);
    expect(held.input.pointer).toEqual({ x: 30, y: 30 });
  });

  it('moves the mouse to where a swipe wheels, in the same call', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send(swipeSources(40, 60, 0, 50));
    expect(held.input.pointer).toEqual({ x: 40, y: 60 });
    expect(fake.commands('input.performActions')).toHaveLength(1);
  });

  it('refuses a pointer target outside the viewport before sending, as not dispatched, on either browser', async () => {
    for (const browser of ['chromium', 'firefox'] as const) {
      // Firefox waits for a shown frame before pointer input; the page has one.
      const fake = new FakeBidi()
        .on('input.performActions', { result: {} })
        .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: true } } });
      const held = await session(fake, browser);
      for (const [x, y] of [[-1, -1], [101, 10], [10, 101]] as const) {
        await expect(held.input.send(moveSources(x, y))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('outside the 100x100 viewport') });
        await expect(held.input.send(swipeSources(x, y, 0, 10))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(held.input.dispatches).toBe(0);
      expect(fake.commands('input.performActions')).toEqual([]);
      await held.input.send(clickSources(100, 100));
      expect(held.input.dispatches).toBe(1);
    }
  });

  it('brings a hidden tab to the front before Firefox pointer input, which the parent process sends to the tab on screen', async () => {
    let shown = false;
    const fake = new FakeBidi()
      .on('input.performActions', { result: {} })
      .on('browsingContext.activate', () => {
        shown = true;
        return { result: {} };
      })
      .on('script.callFunction', () => ({ result: { type: 'success', realm: 'r', result: { type: 'boolean', value: shown } } }));
    const held = await session(fake, 'firefox');
    await held.input.send(clickSources(5, 5));
    await held.input.send([typeSource(['a'])]);
    expect(fake.commands('browsingContext.activate').map((command) => command.params)).toEqual([{ context: 'tab' }]);
    expect(fake.commands('input.performActions')).toHaveLength(2);
  });

  it('sends Firefox pointer input to a tab still hidden at the front, as the shown tab of a minimized window is, which takes it', async () => {
    const fake = new FakeBidi()
      .on('input.performActions', { result: {} })
      .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: false } } });
    const held = await session(fake, 'firefox');
    await held.input.send(clickSources(5, 5));
    expect(fake.commands('browsingContext.activate')).toHaveLength(1);
    expect(fake.commands('input.performActions')).toHaveLength(1);
    expect(held.input.dispatches).toBe(1);
  });

  it('waits for the frame of the document that replaced one a navigation took away under the wait, before Firefox pointer input', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake, 'firefox');
    const waits: Reply[] = [
      { error: 'no such frame', message: 'DiscardedBrowsingContextError: Actor \'MessageHandlerFrame\' destroyed before query \'MessageHandlerFrameParent:sendCommand\' was resolved' },
      { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: true } } },
    ];
    fake.on('script.callFunction', () => waits.shift()!);
    await held.input.send(clickSources(5, 5));
    expect(waits).toEqual([]);
    expect(fake.commands('input.performActions')).toHaveLength(1);
  });

  it('sends no Firefox pointer input to a tab that closed under the wait for its frame, as never dispatched', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake, 'firefox');
    const gone: Reply = { error: 'no such frame', message: 'Browsing Context with id tab not found' };
    fake.on('script.callFunction', gone).on('browsingContext.activate', gone);
    await expect(held.input.send(clickSources(5, 5))).rejects.toMatchObject({ error: 'no such frame' });
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(held.input.dispatches).toBe(0);
  });

  it('takes input the page suppressed back from the operation that sent it, and never from the attempt', async () => {
    let fail = false;
    const fake = new FakeBidi().on('input.performActions', () => (fail ? { error: 'unknown error', message: 'gone' } : { result: {} }));
    const held = await session(fake);
    const watch = (verdict: string | null) => ({ arm: async () => undefined, verdict: async () => verdict, suppressed: (seen: string | null): boolean => seen === 'covered' });
    const click = (verdict: string | null) => held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), watch(verdict));
    const [swallowed, seen, failed] = [new DispatchScope(), new DispatchScope(), new DispatchScope()];
    await swallowed.run(() => click('covered'));
    await seen.run(() => click(null));
    fail = true;
    await expect(failed.run(() => click('covered'))).rejects.toThrow('gone');
    expect([swallowed.dispatched, seen.dispatched, failed.dispatched]).toEqual([false, true, true]);
    expect(held.input.dispatches).toBe(3);
  });

  it('takes input whose tab closed under it (a click that closes its own tab) as dispatched, not failed', async () => {
    const fake = new FakeBidi().on('input.performActions', { error: 'no such frame', message: 'Browsing context is gone' });
    const held = await session(fake);
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: async () => null, suppressed: (verdict) => verdict !== null })).resolves.toBeNull();
    expect(held.input.dispatches).toBe(1);
  });

  it('counts input whose verdict never comes as dispatched, so an operation timing out on it may have committed', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    void held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: () => new Promise<never>(() => undefined), suppressed: () => true });
    await vi.waitFor(() => expect(fake.commands('input.performActions')).toHaveLength(1));
    expect(held.input.dispatches).toBe(1);
  });

  it('arms a watch only for input ready to go out, and ends one it armed whatever stopped the input', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const calls: string[] = [];
    const watch = (arm: () => Promise<void>) => ({
      arm: async () => {
        calls.push('arm');
        await arm();
      },
      verdict: async () => {
        calls.push('verdict');
        return null;
      },
      suppressed: () => false,
    });
    await expect(held.input.sendSuppressible(clickSources(500, 5), AbortSignal.timeout(500), watch(async () => undefined))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.abort(new Error('cancelled')), watch(async () => undefined))).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
    const cancelling = new AbortController();
    await expect(held.input.sendSuppressible(clickSources(5, 5), cancelling.signal, watch(async () => cancelling.abort(new Error('cancelled while arming'))))).rejects.toThrow('cancelled while arming');
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), watch(async () => {
      throw new BidiError('script.callFunction', 'no such frame', 'the frame is gone');
    }))).rejects.toThrow('no such frame');
    expect(calls).toEqual(['arm', 'verdict', 'arm', 'verdict']);
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(held.input.dispatches).toBe(0);
  });

  it('sends a key WebDriver has no value for as CDP key events that carry the modifiers BiDi holds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('goog:cdp.getSession', { result: { session: 'cdp' } }).on('goog:cdp.sendCommand', { result: {} });
    const held = await session(fake);
    await held.input.key(fixtureKeyStroke('Shift', 'keyDown'));
    await held.input.key(fixtureKeyStroke('MediaPlayPause', 'press'));
    await held.input.key(fixtureKeyStroke('Shift', 'keyUp'));
    expect(fake.commands('input.performActions')).toHaveLength(2);
    const cdp = fake.commands('goog:cdp.sendCommand').map((command) => command.params as { method: string; session: string; params: { type: string; modifiers: number } });
    expect(cdp.filter((command) => command.method === 'Input.dispatchKeyEvent').map((command) => [command.session, command.params.type, command.params.modifiers])).toEqual([['cdp', 'rawKeyDown', 8], ['cdp', 'keyUp', 8]]);
  });

  it('keeps what each tab holds while another is shown: its keys, its button, and where its mouse is', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const [first] = held.tabs.list();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    await held.input.send(pressDownSources(20, 30));
    const second = await held.newTab();
    expect(held.input.pointer).toEqual({ x: 0, y: 0 });
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    expect(keyActions(fake).at(-1)!.filter((action) => action.value === SHIFT).map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
    await held.tabs.show(first!);
    expect(held.input.pointer).toEqual({ x: 20, y: 30 });
    await held.input.send([keySource('Shift+ArrowRight', 'press', true)]);
    expect(keyActions(fake).at(-1)!.some((action) => action.value === SHIFT)).toBe(false);
    await held.input.send(moveSources(40, 40));
    const sent = fake.commands('input.performActions').at(-1)!.params as { context: string; actions: { actions: { pressure?: number }[] }[] };
    expect([sent.context, sent.actions[0]!.actions[0]!.pressure]).toEqual(['tab', 0.5]);
    await held.tabs.show(second);
    expect(held.input.pointer).toEqual({ x: 5, y: 5 });
  });

  it('drops what a tab held once the browser says the tab is gone', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const shared = await sharedSession(fake);
    // The scripted browser gives the next tab the id of the one that closed, which no browser does: anything kept of the closed one would show in it.
    const reopened = (): Reply => {
      fake.emit('browsingContext.contextCreated', contextInfo('tab-2'));
      return { result: { context: 'tab-2' } };
    };
    fake.on('browsingContext.create', reopened);
    const closing = await shared.newTab();
    await shared.input.send([keySource('Shift', 'keyDown', false)]);
    await shared.tabs.close(closing);
    await shared.newTab();
    await shared.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });

  it('forgets held keys with the tab that held them', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    held.tabs.destroyed('tab');
    await held.ensureContext();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });

  const unsuppressed = { arm: async () => undefined, verdict: async () => null, suppressed: () => false };
  it.each<[string, string, Reply, (input: BidiInput) => Promise<unknown>]>([
    ['a send', 'input.performActions', { result: {} }, (input) => input.send(clickSources(5, 5))],
    ['a suppressible send', 'input.performActions', { result: {} }, (input) => input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), unsuppressed)],
    ['a suppressible send the closed tab failed', 'input.performActions', { error: 'no such frame', message: 'Browsing context is gone' }, (input) => input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), unsuppressed)],
    ['a CDP key', 'goog:cdp.sendCommand', { result: {} }, (input) => input.key(fixtureKeyStroke('MediaPlayPause', 'keyDown'))],
    ['a drag event', 'goog:cdp.sendCommand', { result: {} }, (input) => input.dragEvent('drop', { x: 5, y: 5 }, { items: [], dragOperationsMask: 1 }, AbortSignal.timeout(500))],
  ])('keeps what %s left in a tab that closed under it out of the tab shown next, which has what it had', async (_name, method, reply, send) => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('goog:cdp.getSession', { result: { session: 'cdp' } }).on('goog:cdp.sendCommand', { result: {} });
    const held = await session(fake);
    await held.input.send(moveSources(7, 9));
    await held.newTab();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    // The tab's close reaches the driver before the answer to the input that closed it.
    fake.on(method, () => {
      held.tabs.destroyed('tab-2');
      return reply;
    });
    await send(held.input);
    fake.on(method, { result: {} });
    await held.tabs.settled();
    expect(held.context).toBe('tab');
    expect(held.input.pointer).toEqual({ x: 7, y: 9 });
    await held.input.key(fixtureKeyStroke('MediaPlayPause', 'keyDown'));
    expect(fake.commands('goog:cdp.sendCommand').at(-1)!.params['params']).toMatchObject({ modifiers: 0, autoRepeat: false });
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });
});

/** A page call's answer of `outcome`. */
const answer = (outcome: Record<string, string>): Reply =>
  ({ result: { type: 'success', realm: 'r', result: { type: 'object', value: Object.entries(outcome).map(([key, value]) => [key, { type: 'string', value }]) } } });

/** The page calls of `fn` that `fake` got. */
const calls = (fake: FakeBidi, fn: { toString(): string }): SentCommand[] => fake.commands('script.callFunction').filter((command) => callOf(fn, command.params) !== undefined);

/** What each browser answers for a node it refuses, one of a document a navigation replaced, settled and in flight. */
const REFUSED_NODES: readonly (readonly [BrowserName, Reply])[] = [
  ['chromium', { error: 'no such node', message: 'SharedId "f.1.d.2.e.3" belongs to different document. Current document is 4.' }],
  ['chromium', { error: 'no such node', message: 'SharedId "f.1.d.2.e.3" was not found.' }],
  ['chromium', { error: 'unknown error', message: 'Node with given id does not belong to the document' }],
  ['firefox', { error: 'no such node', message: 'The node with the reference e is not known' }],
];

/** What each browser answers for a call into a frame that is gone. */
const GONE_FRAMES: readonly (readonly [BrowserName, Reply])[] = [
  ['chromium', { error: 'no such frame', message: 'Context 046C34E7A7D4F228602F3B47BEDF8F34 not found' }],
  ['firefox', { error: 'no such frame', message: 'Browsing Context with id 15032385537 not found' }],
];

/** Whether the refusal of a node proves the call never ran: Chromium refuses a node before the call runs and sends no call twice, Firefox sends one again that it sent to a first, empty document. */
const provesNothingRan = (browser: BrowserName): boolean => browser === 'chromium';

describe('a fill', () => {
  /**
   * Has `fake` answer the page's `fill` with `filled`, the read of the field
   * before each try with `read`, and every check before those as a shown,
   * enabled field.
   */
  function field(fake: FakeBidi, filled: () => Reply | Promise<Reply>, read: () => Reply = () => answer({ kind: 'ok' })): void {
    fake.on('script.callFunction', (params) => {
      if (callOf(fill, params) !== undefined) return filled();
      if (callOf(elementAttached, params) !== undefined) return read();
      if (callOf(elementShown, params) !== undefined) return answer({ kind: 'ok' });
      return { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: false } } };
    });
  }

  /** Fills the field `held` located as `id`, counted by a scope of its own. */
  function filling(held: BidiSession, id: string, timeoutMs: number): { scope: DispatchScope; done: Promise<void> } {
    held.refs.storeLocated(id, { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    const scope = new DispatchScope();
    return { scope, done: scope.run(() => perform(held, { id } as NodeRef, { kind: 'fill', value: 'x', sensitive: false }, timeoutMs, new AbortController().signal)) };
  }

  /** What `done` failed with, as the engine reports a failure of an operation counted by `scope`. */
  const reported = async ({ scope, done }: { scope: DispatchScope; done: Promise<void> }): Promise<Error> => {
    const failure = await done.then(() => undefined, (cause: unknown) => cause);
    return afterDispatch(classify(failure, 'fill'), 'fill', scope.dispatched);
  };

  it('counts as dispatched while the page still runs it, so an operation timing out on it may have committed', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    let sent = false;
    field(fake, () => {
      sent = true;
      return new Promise<never>(() => undefined);
    });
    const { scope } = filling(held, '1', 5_000);
    await vi.waitFor(() => expect(sent).toBe(true));
    expect(scope.dispatched).toBe(true);
    expect(held.input.dispatches).toBe(1);
  });

  it('takes a try that changed nothing back from the operation, and never from the attempt', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    field(fake, () => answer({ kind: 'not-yet', reason: 'element is not editable' }));
    const { scope, done } = filling(held, '1', 120);
    await expect(done).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('element is not editable') });
    expect(scope.dispatched).toBe(false);
    expect(held.input.dispatches).toBeGreaterThan(0);
  });

  it('fails with the reason its last try gave when a try takes longer than the lead of the operation\'s deadline', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    field(fake, async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
      return answer({ kind: 'not-yet', reason: 'element is not editable' });
    });
    held.refs.storeLocated('1', { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    const started = Date.now();
    const done = withDeadline({ timeoutMs: 1_000, signal: new AbortController().signal }, 'fill', (budget) =>
      perform(held, { id: '1' } as NodeRef, { kind: 'fill', value: 'x', sensitive: false }, budget.timeoutMs, budget.signal));
    await expect(done).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('element is not editable') });
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
  });

  it('fails stale, as never dispatched, when the field left the document since its checks', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    field(fake, () => answer({ kind: 'detached' }));
    const { scope, done } = filling(held, '1', 5_000);
    await expect(done).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(scope.dispatched).toBe(false);
  });

  it.each([...REFUSED_NODES, ...GONE_FRAMES])('reads the field before every try of a poll, so one %s refuses between two tries fails stale, as never dispatched: %j', async (browser, refusal) => {
    const fake = new FakeBidi();
    const held = await session(fake, browser);
    const reads: Reply[] = [answer({ kind: 'ok' }), refusal];
    field(fake, () => answer({ kind: 'not-yet', reason: 'element is not editable' }), () => reads.shift()!);
    expect(await reported(filling(held, '1', 5_000))).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(reads).toEqual([]);
    expect(calls(fake, fill)).toHaveLength(1);
  });

  it.each(REFUSED_NODES)('takes back a try of a poll whose field %s refused once the read passed it only where that proves nothing ran: %j', async (browser, refusal) => {
    const fake = new FakeBidi();
    const held = await session(fake, browser);
    const fills: Reply[] = [answer({ kind: 'not-yet', reason: 'element is not editable' }), refusal];
    field(fake, () => fills.shift()!);
    expect(await reported(filling(held, '1', 5_000))).toMatchObject(
      provesNothingRan(browser) ? { code: 'NODE_STALE', retryable: true } : { code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false },
    );
    expect(fills).toEqual([]);
    expect(calls(fake, elementAttached)).toHaveLength(2);
  });
});

describe('a press on a node', () => {
  it('sends no key once the node left the document, and fails stale as never dispatched', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('script.callFunction', (params) => answer({ kind: callOf(focus, params) === undefined ? 'ok' : 'detached' }));
    const held = await session(fake);
    held.refs.storeLocated('1', { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    const scope = new DispatchScope();
    const pressing = scope.run(() => perform(held, { id: '1' } as NodeRef, { kind: 'press', key: 'a' }, 5_000, new AbortController().signal));
    await expect(pressing).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(scope.dispatched).toBe(false);
  });

  const ok = answer({ kind: 'ok' });

  /**
   * Presses a key on a node an observation gave, on a page that answers its
   * `focus` with `focused` and the read before it with `read`; counted by a
   * scope of its own.
   */
  async function press(browser: BrowserName, focused: Reply, read: Reply = ok): Promise<{ fake: FakeBidi; scope: DispatchScope; failure: unknown }> {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('script.callFunction', (params) => (callOf(focus, params) === undefined ? read : focused));
    const held = await session(fake, browser);
    held.refs.publish(new Map([['1', { element: new ElementRef('e'), context: 'tab' }]]));
    const scope = new DispatchScope();
    const failure = await scope.run(() => perform(held, { id: '1' } as NodeRef, { kind: 'press', key: 'a' }, 5_000, new AbortController().signal)).then(() => undefined, (cause: unknown) => cause);
    return { fake, scope, failure };
  }

  it.each([...REFUSED_NODES, ...GONE_FRAMES])('reads the node before it focuses it, so one %s refused fails stale, as never dispatched, and no key goes out: %j', async (browser, refusal) => {
    const { fake, scope, failure } = await press(browser, ok, refusal);
    expect(afterDispatch(classify(failure, 'press'), 'press', scope.dispatched)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(calls(fake, elementAttached)).toHaveLength(1);
    expect(calls(fake, focus)).toEqual([]);
    expect(fake.commands('input.performActions')).toEqual([]);
  });

  // The read passed the node, so a navigation replaced its document in the moment since. Chromium refuses the node before the focus runs and sends no call twice; Firefox sends a call again that it sent to a first, empty document, so its refusal may follow a focus that ran.
  it.each(REFUSED_NODES)('takes back a focus whose node %s refused only where that proves nothing ran, and sends no key: %j', async (browser, refusal) => {
    const { fake, scope, failure } = await press(browser, refusal);
    expect(afterDispatch(classify(failure, 'press'), 'press', scope.dispatched)).toMatchObject(
      provesNothingRan(browser) ? { code: 'NODE_STALE', retryable: true } : { code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false },
    );
    expect(scope.dispatched).toBe(!provesNothingRan(browser));
    expect(fake.commands('input.performActions')).toEqual([]);
  });

  // What the browsers answered for a focus whose function ran and whose document, frame, or tab went away under it; the answer for a frame already gone reads the same.
  it.each<readonly [BrowserName, Reply]>([
    ...GONE_FRAMES,
    ['chromium', { error: 'unknown error', message: 'Inspected target navigated or closed' }],
    ['chromium', { error: 'unknown error', message: 'Cannot find context with specified id' }],
    ['chromium', { error: 'unknown error', message: 'Execution context was destroyed.' }],
    ['chromium', { error: 'no such frame', message: 'Browsing context is gone' }],
    ['firefox', { error: 'no such frame', message: 'DiscardedBrowsingContextError: Actor \'MessageHandlerFrame\' destroyed before query \'MessageHandlerFrameParent:sendCommand\' was resolved' }],
  ])('keeps a focus on %s whose document or frame went away under it counted, so it may have committed: %j', async (browser, gone) => {
    const { fake, scope, failure } = await press(browser, gone);
    expect(afterDispatch(classify(failure, 'press'), 'press', scope.dispatched)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(scope.dispatched).toBe(true);
  });

  it.each(['chromium', 'firefox'] as const)('reads the node, focuses it, and sends the key on %s: two page calls and one input', async (browser) => {
    const { fake, scope, failure } = await press(browser, ok);
    expect(failure).toBeUndefined();
    expect([calls(fake, elementAttached).length, calls(fake, focus).length, fake.commands('input.performActions').length]).toEqual([1, 1, 1]);
    expect(scope.dispatched).toBe(true);
  });
});
