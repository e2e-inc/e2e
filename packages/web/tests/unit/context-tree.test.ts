/**
 * The browsing-context tree on the BiDi driver: a snapshot taken on connect
 * reconciled with the context events that race it, and the requests of a
 * closed frame, tab, or restarted page retired with every frame in it.
 */

import type { BrowsingContext, Network } from 'webdriver-bidi-protocol';
import { describe, expect, it } from 'vitest';
import { ContextTree } from '../../src/driver/context-tree.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { contextInfo, FakeBidi, requestData } from '../helpers/bidi-fake.ts';
import { unopened } from '../helpers/session-fake.ts';

/** A context's info, as `getTree` lists it and its events carry it. */
function info(context: string, parent: string | null, children: BrowsingContext.Info[] | null = null): BrowsingContext.Info {
  return contextInfo(context, { parent, children });
}

/** A request from `context` that no event ever finishes. */
function request(context: string, id: string): Network.BeforeRequestSentParameters {
  return { context, isBlocked: false, navigation: null, redirectCount: 0, timestamp: 0, request: requestData(id, `http://app.test/${id}`) };
}

/**
 * A session on `fake` in the user context `mine` it opened there, its tab
 * `tab` open, its events routed through a tree that knows `tab` and its
 * frames `frame` and `inner`. The tab it opens next is `next`, and `fake`
 * announces each tab it opens and closes, as a browser does.
 */
async function attempt(fake: FakeBidi) {
  const tabs = ['tab', 'next'];
  fake
    .on('session.subscribe', { result: { subscription: 'subscription' } })
    .on('network.addDataCollector', { result: { collector: 'collector' } })
    .on('browsingContext.getTree', { result: { contexts: [info('tab', null)] } })
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('browsingContext.create', () => {
      const context = tabs.shift()!;
      fake.emit('browsingContext.contextCreated', info(context, null));
      return { result: { context } };
    })
    .on('browsingContext.close', (params) => {
      fake.emit('browsingContext.contextDestroyed', info(String(params['context']), null));
      return { result: {} };
    });
  const session = unopened(fake, 'chromium', 'fresh', { settings: { viewport: null }, routed: true });
  await session.openUserContext(new AbortController().signal);
  await session.ensureContext();
  fake.emit('browsingContext.contextCreated', info('frame', 'tab'));
  fake.emit('browsingContext.contextCreated', info('inner', 'frame'));
  await session.network.track();
  return session;
}

/** Waits for the network to go idle, failing the test after two seconds. */
function idle(session: BidiSession): Promise<void> {
  return session.network.waitForIdle(AbortSignal.timeout(2_000));
}

/** Asserts the network stays busy past its idle window. */
async function busy(session: BidiSession): Promise<void> {
  await expect(session.network.waitForIdle(AbortSignal.timeout(700))).rejects.toThrow();
}

describe('ContextTree', () => {
  it('registers a snapshot’s contexts with their frames, keeping events that raced it', async () => {
    const contexts = new ContextTree();
    await contexts.sync(async () => {
      contexts.created('opened', 'mine', null);
      contexts.destroyed('closed');
      return [info('tab', null, [info('frame', null, [info('inner', null)])]), info('closed', null, [info('closed-frame', null)]), info('opened', null)];
    });
    expect(contexts.owner('inner')).toBe('mine');
    expect(contexts.top('inner')).toBe('tab');
    expect([...contexts.subtree('tab')]).toEqual(['tab', 'frame', 'inner']);
    expect(contexts.owner('opened')).toBe('mine');
    expect(contexts.owner('closed')).toBeUndefined();
    expect(contexts.owner('closed-frame')).toBeUndefined();
  });

  it('forgets every frame of a closed context', () => {
    const contexts = new ContextTree();
    contexts.created('tab', 'mine', null);
    contexts.created('frame', 'mine', 'tab');
    contexts.created('inner', 'mine', 'frame');
    contexts.destroyed('frame');
    expect(contexts.owner('inner')).toBeUndefined();
    expect([...contexts.subtree('tab')]).toEqual(['tab']);
  });
});

describe('request retirement', () => {
  it('stops counting the requests of a frame that closed', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('inner', 'stuck'));
    await busy(session);
    fake.emit('browsingContext.contextDestroyed', info('frame', 'tab'));
    await idle(session);
  });

  it('stops counting the requests of every frame in a tab that closed', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('frame', 'stuck'));
    fake.emit('network.beforeRequestSent', request('inner', 'stuck-too'));
    await busy(session);
    fake.emit('browsingContext.contextDestroyed', info('tab', null));
    await idle(session);
  });

  it('goes idle after a restart while a frame’s request never finished', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('inner', 'stuck'));
    await busy(session);
    await session.replaceTabs(new AbortController().signal);
    await idle(session);
  });
});
