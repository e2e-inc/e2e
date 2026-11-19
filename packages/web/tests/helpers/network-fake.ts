/**
 * One attempt's network over a scripted WebDriver BiDi peer, for unit
 * tests: the network with how its tabs open and close, the events of a
 * request and of its response, and a route on a URL pattern.
 */

import type { Network } from 'webdriver-bidi-protocol';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { AttemptNetwork } from '../../src/driver/network.ts';
import type { NetworkRoute } from '../../src/driver/network-decisions.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { requestData, responseData, type FakeBidi } from './bidi-fake.ts';

/** The origin of the app a network is built for, unless it names another (`site`). */
export const SITE = 'http://app.test';

/**
 * An attempt network over `fake`, bound to no user context yet, and the
 * failures it latched; `headers` configures one for the app's origin
 * (`site`, else `SITE`), `credentials` its basic auth, and
 * `credentialOrigins` lists more origins that get both. `fake` numbers the
 * intercepts it adds (`intercept-1`), names a tab's CDP session after the
 * tab (`session-of-tab`), and calls every data collector `collector-1`, or
 * numbers those too when `numberedCollectors`.
 */
export function network(
  fake: FakeBidi,
  options: {
    headers?: boolean;
    credentials?: { username: string; password: string };
    site?: string;
    credentialOrigins?: readonly string[];
    browser?: BrowserName;
    exclusive?: boolean;
    ours?: (context: string | null) => boolean;
    onPage?: (context: string | null) => boolean;
    numberedCollectors?: boolean;
  } = {},
) {
  const failures: Error[] = [];
  const contexts = new ContextTree();
  const lifetime = new AbortController();
  let intercepts = 0;
  let collectors = 0;
  fake.on('network.addIntercept', () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }));
  fake.on('network.addDataCollector', () => ({ result: { collector: `collector-${options.numberedCollectors === true ? (collectors += 1) : 1}` } }));
  fake.on('session.subscribe', { result: { subscription: 'subscription-1' } });
  fake.on('goog:cdp.getSession', (params) => ({ result: { session: `session-of-${String(params['context'])}` } }));
  const net = new AttemptNetwork(fake.connection, {
    protectedApp: new ProtectedApp(new Set([options.site ?? SITE, ...(options.credentialOrigins ?? [])]), options.headers === true ? { 'X-Preview': 'token' } : undefined, options.credentials),
    ours: (event) => options.ours?.(event.context) ?? true,
    onPage: (context) => options.onPage?.(context) ?? true,
    contexts,
    exclusive: options.exclusive ?? false,
    traits: BROWSER_TRAITS[options.browser ?? 'chromium'],
    onFailure: (error) => failures.push(error),
    onNavigationAbort: () => undefined,
    lifetime: lifetime.signal,
  });
  /** Opens top-level tab `tab` of user-1, as its `contextCreated` event records it, and hands it to the network. */
  const open = (tab: string): Promise<void> => {
    contexts.created(tab, 'user-1', null);
    return net.addContext(tab);
  };
  /** Closes `tab`, as its `contextDestroyed` event tells the network and then the tree. */
  const close = (tab: string): Promise<void> => {
    const removed = net.removeContext(tab);
    contexts.destroyed(tab);
    return removed;
  };
  return { net, failures, contexts, open, close, lifetime };
}

/** A `beforeRequestSent` event held by `intercepts`, which a request nothing holds does not name. */
export function request(id: string, url: string, intercepts: string[] = ['intercept-1']): Network.BeforeRequestSentParameters {
  const [first, ...rest] = intercepts;
  return {
    context: 'tab',
    isBlocked: first !== undefined,
    navigation: null,
    redirectCount: 0,
    timestamp: 0,
    ...(first === undefined ? {} : { intercepts: [first, ...rest] }),
    request: requestData(id, url, { headers: [{ name: 'Accept', value: { type: 'string', value: '*/*' } }] }),
  };
}

/** The event of a response with `status` to request `id` at `url`, which nothing holds unless `intercepts` do: with `fields` in its response. */
export function responded(id: string, url: string, status: number, fields: Partial<Network.ResponseData> = {}, intercepts: string[] = []): Network.ResponseStartedParameters {
  return { ...request(id, url, intercepts), response: responseData(url, status, fields) };
}

/** The header that makes a 3xx response a redirect hop. */
export const LOCATION: Network.Header[] = [{ name: 'Location', value: { type: 'string', value: '/next' } }];

/** A route on the URL `pattern` that runs `handle`; without one it lets every request go on as it is. */
export function route(pattern: string, handle: NetworkRoute['handle'] = (_request, decisions) => decisions.continue({})): NetworkRoute {
  return { pattern: { kind: 'string', value: pattern, exact: true }, handle };
}
