/**
 * Routes and the HTTP cache on a browser the engine attached to over CDP,
 * which other clients may drive too: only the attempt's own tabs bypass the
 * cache while it has a route, each from the moment it opens, and another
 * client's tab keeps answering from its cache.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../../src/fixture/types.ts';
import { launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startWebSession, type WebSession } from '../../helpers/web-session.ts';

/** A reply or an event of Chrome's, as its DevTools connection sends it. */
interface CdpReply {
  readonly id?: number;
  readonly method?: string;
  readonly result?: { readonly targetId?: string; readonly sessionId?: string };
}

/** Another client of the browser, on a DevTools connection of its own: a tab it opened, which it loads pages in. */
async function otherClient(endpoint: string): Promise<{ load(url: string): Promise<void>; close(): void }> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`no DevTools connection to ${endpoint}`)), { once: true });
  });
  const replies = new Map<number, (result: NonNullable<CdpReply['result']>) => void>();
  let loaded: () => void = () => undefined;
  socket.addEventListener('message', (message) => {
    const reply = JSON.parse(String(message.data)) as CdpReply;
    if (reply.id !== undefined) replies.get(reply.id)?.(reply.result ?? {});
    if (reply.method === 'Page.loadEventFired') loaded();
  });
  const send = (method: string, params: Record<string, unknown>, sessionId?: string): Promise<NonNullable<CdpReply['result']>> => new Promise((resolve) => {
    const id = replies.size + 1;
    replies.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  return {
    load: async (url) => {
      const fired = new Promise<void>((resolve) => { loaded = resolve; });
      await send('Page.navigate', { url }, sessionId);
      await fired;
    },
    close: () => socket.close(),
  };
}

describe('routes and the HTTP cache on an attached browser', () => {
  let chrome: RemoteChrome;
  let session: WebSession;
  let browser: Browser;
  /** How many requests for `/app.js` reached the server, by the `client` its page names. */
  const served = new Map<string, number>();

  beforeAll(async () => {
    chrome = await launchRemoteChrome();
    session = await startWebSession({ web: { connect: { cdpEndpoint: () => chrome.endpoint } }, timeoutMs: 10_000, startAttempt: false });
    session.serve('/cached-page', (request, response) => {
      const client = new URL(request.url ?? '/', session.origin).searchParams.get('client') ?? '';
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Cached</title><h1>Cached</h1><script src="/app.js?client=${client}"></script>`);
    });
    session.serve('/app.js', (request, response) => {
      const client = new URL(request.url ?? '/', session.origin).searchParams.get('client') ?? '';
      served.set(client, (served.get(client) ?? 0) + 1);
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' });
      response.end('window.app = true;');
    });
  }, 60_000);

  beforeEach(async () => {
    served.clear();
    await session.startAttempt();
    browser = session.browser;
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await tearDownRemote({ ends: [() => session?.close()], chrome });
  });

  it('hands a route the cached script of its own tabs, and leaves another client\'s cache on', async () => {
    await browser.goto('/cached-page?client=routed');
    let hits = 0;
    await browser.route('**/app.js*', async (route) => {
      hits += 1;
      await route.continue();
    });
    await browser.goto('/cached-page?client=routed');
    expect(hits).toBe(1);
    expect(served.get('routed')).toBe(2);
    const tab = await browser.newTab();
    await tab.activate();
    await browser.goto('/cached-page?client=routed');
    expect(hits).toBe(2);
    expect(served.get('routed')).toBe(3);

    const other = await otherClient(chrome.endpoint);
    try {
      await other.load(`${session.origin}/cached-page?client=other`);
      await other.load(`${session.origin}/cached-page?client=other`);
      expect(served.get('other')).toBe(1);
    } finally {
      other.close();
    }
  });

  it('answers its own tabs from the cache again after unrouteAll', async () => {
    await browser.route('**/app.js*', (route) => route.continue());
    await browser.goto('/cached-page?client=routed');
    await browser.goto('/cached-page?client=routed');
    expect(served.get('routed')).toBe(2);
    await browser.unrouteAll();
    await browser.goto('/cached-page?client=routed');
    expect(served.get('routed')).toBe(2);
  });
});
