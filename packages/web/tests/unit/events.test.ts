/**
 * Browser-wide events routed to the running BiDi attempt: context
 * ownership, user prompts through its dialog router (and never another
 * session's), its app log, and the input state it drops with a tab that
 * closed.
 */

import { describe, expect, it } from 'vitest';
import type { BrowsingContext, Log } from 'webdriver-bidi-protocol';
import type { AppLogEntry } from '@e2e-dev/core/engine';
import { DialogRouter } from '../../src/driver/dialogs.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { contextInfo, FakeBidi, navigationInfo, settle } from '../helpers/bidi-fake.ts';
import { ErrorLatch } from '../../src/errors.ts';
import { AttemptTabs } from '../../src/driver/tabs.ts';

/** The parts of a session the event router reads, owning `userContext`'s contexts, with its tab `tab` shown. */
async function attempt(owners: ContextTree, userContext: string) {
  const latch = new ErrorLatch();
  const log: AppLogEntry[] = [];
  const added: string[] = [];
  const lines: string[] = [];
  const visited: string[] = [];
  const forgotten: string[] = [];
  const session = {
    get context(): string | undefined {
      return session.tabs.active()?.context;
    },
    tabs: undefined as unknown as AttemptTabs,
    navigations: { inFlight: false },
    lifetime: new AbortController().signal,
    latch,
    dialogs: new DialogRouter(latch),
    attempt: { appLog: (entry: AppLogEntry) => log.push(entry), navigation: (line: string) => lines.push(line) },
    userContext: { visit: async (url: string) => void visited.push(url) },
    network: { addContext: async (context: string) => void added.push(context), removeContext: async () => undefined, retire: () => undefined },
    owns: (context: string | null | undefined) => context != null && owners.owner(context) === userContext,
    input: { forget: (context: string) => void forgotten.push(context), emulateFocus: async () => undefined },
    log: { openedTab: async () => undefined, reportBrowserLines: async () => undefined },
  };
  session.tabs = new AttemptTabs({
    prepare: async () => undefined,
    gone: async () => false,
    forget: () => undefined,
    record: async () => undefined,
    close: async () => undefined,
    failed: (error) => latch.latch(error),
  });
  await session.tabs.own('tab');
  return { session: session as unknown as BidiSession, state: session, log, added, latch, lines, visited, forgotten };
}

/** A user prompt event in `context`. */
function prompt(context: string, type: BrowsingContext.UserPromptType = 'confirm'): BrowsingContext.UserPromptOpenedParameters {
  return { context, handler: 'ignore', message: 'Really delete everything?', type };
}

describe('routeEvents', () => {
  it('answers a prompt in the attempt’s context through its dialog router', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session } = await attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', contextInfo('tab'));
    let seen = '';
    session.dialogs.add(async (dialog) => {
      seen = `${dialog.type}: ${dialog.message}`;
      await dialog.accept();
    });
    fake.emit('browsingContext.userPromptOpened', prompt('tab'));
    await settle();
    expect(seen).toBe('confirm: Really delete everything?');
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: true }]);
  });

  it('leaves a prompt in another session’s context alone', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session } = await attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', contextInfo('theirs', { userContext: 'other' }));
    fake.emit('browsingContext.userPromptOpened', prompt('theirs'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt')).toEqual([]);
  });

  it('dismisses an unhandled prompt and fails the next step naming it', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, latch } = await attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', contextInfo('tab'));
    fake.emit('browsingContext.userPromptOpened', prompt('tab', 'alert'));
    await settle();
    expect(fake.commands('browsingContext.handleUserPrompt').map((command) => command.params)).toEqual([{ context: 'tab', accept: false }]);
    expect(() => latch.throwPending()).toThrow('unhandled alert dialog: Really delete everything?');
  });

  it('records a frame under its tab’s owner, covers a tab the app opens, and logs only the attempt’s pages', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, log, added } = await attempt(owners, 'mine');
    const off = routeEvents(fake.connection, owners, () => session);
    fake.emit('browsingContext.contextCreated', contextInfo('tab'));
    fake.emit('browsingContext.contextCreated', contextInfo('frame', { parent: 'tab' }));
    fake.emit('browsingContext.contextCreated', contextInfo('popup', { originalOpener: 'tab' }));
    expect(owners.owner('frame')).toBe('mine');
    expect(added).toEqual(['popup']);
    const entry = (context: string, text: string): Log.ConsoleLogEntry => ({ type: 'console', level: 'error', text, timestamp: 0, method: 'error', args: [], source: { realm: 'r', context } });
    fake.emit('log.entryAdded', entry('frame', 'boom'));
    fake.emit('log.entryAdded', entry('elsewhere', 'not mine'));
    fake.emit('log.entryAdded', entry('tab', 'Failed to load resource: 404'));
    off();
    fake.emit('log.entryAdded', entry('tab', 'after unsubscribe'));
    expect(log).toEqual([{ source: 'console', level: 'error', text: 'boom' }]);
  });

  it('drops the input state kept of a tab once it closed, a tab of a user context the attempt left too', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, forgotten } = await attempt(owners, 'mine');
    routeEvents(fake.connection, owners, () => session);
    for (const [context, userContext] of [['tab', 'mine'], ['old', 'replaced']] as const) {
      fake.emit('browsingContext.contextCreated', contextInfo(context, { userContext }));
      fake.emit('browsingContext.contextDestroyed', contextInfo(context, { userContext }));
    }
    expect(forgotten).toEqual(['tab', 'old']);
  });

  it('tells where the app went in event order, never the driver’s own navigations, names each frame and tab once as it joins the tabs, and visits every document it starts or lands at', async () => {
    const fake = new FakeBidi();
    const owners = new ContextTree();
    const { session, state, lines, visited } = await attempt(owners, 'mine');
    fake.on('script.callFunction', (params) => ({
      result: { type: 'success', realm: 'r', result: { type: 'string', value: (params['target'] as { context: string }).context === 'frame' ? 'pay' : '' } },
    }));
    routeEvents(fake.connection, owners, () => session);
    const created = (context: string, fields: Partial<BrowsingContext.Info> = {}) => fake.emit('browsingContext.contextCreated', contextInfo(context, fields));
    const nav = navigationInfo;
    created('tab');
    created('scratch');
    fake.emit('browsingContext.contextCreated', contextInfo('frame', { parent: 'tab' }));
    state.navigations.inFlight = true;
    fake.emit('browsingContext.navigationCommitted', nav('tab', 'http://app.test/'));
    state.navigations.inFlight = false;
    fake.emit('browsingContext.navigationStarted', nav('tab', 'http://app.test/checkout'));
    fake.emit('browsingContext.navigationCommitted', nav('tab', 'http://app.test/checkout'));
    fake.emit('browsingContext.historyUpdated', { context: 'tab', url: 'http://app.test/checkout?step=2', timestamp: 0 });
    fake.emit('browsingContext.navigationCommitted', nav('frame', 'http://pay.test/embed'));
    fake.emit('browsingContext.navigationCommitted', nav('frame', 'about:srcdoc'));
    fake.emit('browsingContext.navigationCommitted', nav('scratch', 'http://app.test/'));
    created('popup', { originalOpener: 'tab' });
    fake.emit('browsingContext.navigationStarted', nav('popup', 'http://app.test/help', 'p1'));
    fake.emit('browsingContext.navigationCommitted', nav('popup', 'http://app.test/help', 'p1'));
    fake.emit('browsingContext.domContentLoaded', nav('popup', 'http://app.test/help', 'p1'));
    fake.emit('browsingContext.navigationCommitted', nav('popup', 'http://app.test/help/2', 'p2'));
    created('download', { originalOpener: 'tab' });
    fake.emit('browsingContext.navigationStarted', nav('download', 'http://app.test/export.csv', 'd1'));
    fake.emit('browsingContext.navigationFailed', nav('download', 'http://app.test/export.csv', 'd1'));
    fake.emit('browsingContext.domContentLoaded', nav('download', 'about:blank', 'd2'));
    created('written', { originalOpener: 'tab' });
    fake.emit('browsingContext.domContentLoaded', nav('written', 'about:blank', 'w1'));
    created('blank', { originalOpener: 'tab' });
    fake.emit('browsingContext.contextDestroyed', contextInfo('blank', { originalOpener: 'tab' }));
    await settle();
    expect(lines).toEqual([
      'navigated to http://app.test/checkout',
      'navigated to http://app.test/checkout?step=2',
      'frame "pay" loaded http://pay.test/embed',
      'the app opened a new tab at http://app.test/help',
      'a background tab navigated to http://app.test/help/2',
      'the app opened a new tab',
    ]);
    expect(session.tabs.list().map((tab) => tab.context)).toEqual(['tab', 'popup', 'written']);
    expect(new Set(visited)).toEqual(new Set(['http://app.test/', 'http://app.test/checkout', 'http://app.test/checkout?step=2', 'http://pay.test/embed', 'http://app.test/help', 'http://app.test/help/2', 'http://app.test/export.csv']));
  });
});
