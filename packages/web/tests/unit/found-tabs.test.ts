/**
 * The tab an attempt adopts (`foundTabs`), told from what the browser
 * reports: a plain `page` target of the attempt's user context, the visible
 * one of several, and a refusal that names the tabs when none stands out;
 * beside it, everything open in that user context.
 */

import { describe, expect, it } from 'vitest';
import { foundTabs } from '../../src/driver/found-tabs.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

/** One top-level context as the browser reports it: its CDP target, its user context, and whether its document is visible. */
interface Reported {
  readonly context: string;
  readonly type: string;
  readonly subtype?: string;
  readonly userContext?: string;
  readonly visible?: boolean;
  /** Its document has no script context: a tab that shows none yet. */
  readonly unscripted?: boolean;
  /** Its browsing context is gone by the time its script context is read. */
  readonly gone?: boolean;
  /** Its document went away between the read of its script context and the question put to it. */
  readonly replaced?: boolean;
}

/** The id of the default realm of the document `context` shows. */
const realmOf = (context: string): string => `realm of ${context}`;

/** A browser that reports `open`, in that order, and answers a question put to a document's realm. */
function browserWith(open: readonly Reported[]): FakeBidi {
  return new FakeBidi()
    .on('browsingContext.getTree', {
      result: { contexts: open.map((each) => ({ context: each.context, url: `http://app.test/${each.context}`, userContext: each.userContext ?? 'default', children: null })) },
    })
    .on('goog:cdp.sendCommand', {
      result: { result: { targetInfos: open.map((each) => ({ targetId: each.context, type: each.type, ...(each.subtype === undefined ? {} : { subtype: each.subtype }) })) } },
    })
    .on('script.getRealms', (params) => {
      const reported = open.find((each) => each.context === params['context'])!;
      if (reported.gone) return { error: 'no such frame' };
      return { result: { realms: reported.unscripted ? [] : [{ type: 'window', realm: realmOf(reported.context), origin: 'http://app.test', context: reported.context }] } };
    })
    .on('script.callFunction', (params) => {
      const reported = open.find((each) => realmOf(each.context) === (params['target'] as { realm?: string }).realm)!;
      if (reported.replaced) return { error: 'no such frame' };
      return { result: { type: 'success', realm: realmOf(reported.context), result: { type: 'boolean', value: reported.visible ?? false } } };
    });
}

/** What each question put to a document was aimed at, in order. */
function asked(fake: FakeBidi): unknown[] {
  return fake.commands('script.callFunction').map((command) => command.params['target']);
}

describe('foundTabs', () => {
  it('is the one page target, wherever it stands among a prerendered page and a DevTools front-end, with no document read', async () => {
    const fake = browserWith([
      { context: 'prerender', type: 'page', subtype: 'prerender', visible: true },
      { context: 'devtools', type: 'other', visible: true },
      { context: 'tab', type: 'page' },
    ]);
    expect(await foundTabs(fake.connection, 'default', undefined)).toEqual({ shown: 'tab', all: ['prerender', 'devtools', 'tab'] });
    expect(fake.commands('script.callFunction')).toEqual([]);
  });

  it('is undefined when no tab is open in the user context', async () => {
    const fake = browserWith([{ context: 'theirs', type: 'page', userContext: 'other', visible: true }, { context: 'prerender', type: 'page', subtype: 'prerender' }]);
    expect(await foundTabs(fake.connection, 'default', undefined)).toEqual({ shown: undefined, all: ['prerender'] });
  });

  it('is the only visible tab of several, and never a tab of another user context', async () => {
    const fake = browserWith([
      { context: 'background', type: 'page' },
      { context: 'theirs', type: 'page', userContext: 'other', visible: true },
      { context: 'shown', type: 'page', visible: true },
      { context: 'closing', type: 'page', gone: true },
    ]);
    expect((await foundTabs(fake.connection, 'default', undefined)).shown).toBe('shown');
    expect(fake.commands('script.getRealms').map((command) => command.params['context'])).toEqual(['background', 'shown', 'closing']);
  });

  it('asks each document by its own realm, which answers at once, never by its browsing context, which the browser may hold for good', async () => {
    const fake = browserWith([{ context: 'background', type: 'page' }, { context: 'shown', type: 'page', visible: true }]);
    expect((await foundTabs(fake.connection, 'default', undefined)).shown).toBe('shown');
    expect(asked(fake)).toEqual([{ realm: realmOf('background') }, { realm: realmOf('shown') }]);
  });

  it('counts a tab that shows no document as not visible, and asks nothing of it or of one that closed', async () => {
    const fake = browserWith([
      { context: 'waiting', type: 'page', unscripted: true, visible: true },
      { context: 'shown', type: 'page', visible: true },
      { context: 'closed', type: 'page', gone: true, visible: true },
    ]);
    expect((await foundTabs(fake.connection, 'default', undefined)).shown).toBe('shown');
    expect(asked(fake)).toEqual([{ realm: realmOf('shown') }]);
  });

  it('counts a tab whose document went away under the question as not visible', async () => {
    const fake = browserWith([{ context: 'navigating', type: 'page', replaced: true, visible: true }, { context: 'shown', type: 'page', visible: true }]);
    expect((await foundTabs(fake.connection, 'default', undefined)).shown).toBe('shown');
  });

  it('fails on an answer that is no gone document', async () => {
    const fake = browserWith([{ context: 'a', type: 'page' }, { context: 'b', type: 'page' }]).on('script.callFunction', { error: 'unknown error', message: 'renderer crashed' });
    await expect(foundTabs(fake.connection, 'default', undefined)).rejects.toThrow('renderer crashed');
  });

  it('stays the tab adopted before while it is open, whatever is visible, and is chosen again once it closed', async () => {
    const open = [{ context: 'adopted', type: 'page' }, { context: 'opened', type: 'page', visible: true }];
    const fake = browserWith(open);
    expect((await foundTabs(fake.connection, 'default', 'adopted')).shown).toBe('adopted');
    expect(fake.commands('script.callFunction')).toEqual([]);
    expect((await foundTabs(browserWith(open.slice(1)).connection, 'default', 'adopted')).shown).toBe('opened');
  });

  it('refuses several visible tabs, naming every open one', async () => {
    const fake = browserWith([{ context: 'a', type: 'page', visible: true }, { context: 'b', type: 'page', visible: true }, { context: 'c', type: 'page' }]);
    await expect(foundTabs(fake.connection, 'default', undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'cannot tell which tab of the attached browser to drive: 3 are open (http://app.test/a, http://app.test/b, http://app.test/c) and 2 of them are visible. Leave one tab visible, or close the others.',
    });
  });

  it('refuses several tabs when none is visible', async () => {
    const fake = browserWith([{ context: 'a', type: 'page' }, { context: 'b', type: 'page' }]);
    await expect(foundTabs(fake.connection, 'default', undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'cannot tell which tab of the attached browser to drive: 2 are open (http://app.test/a, http://app.test/b) and none of them is visible. Leave one tab visible, or close the others.',
    });
  });
});
