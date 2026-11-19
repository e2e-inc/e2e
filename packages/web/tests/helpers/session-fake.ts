/**
 * One attempt's session over a scripted WebDriver BiDi peer, for unit
 * tests: the session before it opened anything, the peer scripted to open
 * its tabs as a browser does, and the session with its first tab open.
 */

import type { AppLogEntry } from '@e2e-dev/core/engine';
import { BROWSER_TRAITS, type BrowserName, type BrowserTraits } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { BidiSession, type SessionSettings } from '../../src/driver/session.ts';
import type { UserContextMode } from '../../src/driver/user-context.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { adoptable, contextInfo, type FakeBidi } from './bidi-fake.ts';

/** What a session is built with where the defaults of `unopened` do not hold. */
interface SessionSetup {
  /** Settings over the defaults: a 100 by 100 viewport, `data-testid` as the test id attribute, and no media, init script, or permission. */
  readonly settings?: Partial<SessionSettings>;
  /** The browser's traits as they are, in place of `browser`'s with windows that hold any viewport. */
  readonly traits?: BrowserTraits;
  /** False for a browser other clients drive too. */
  readonly exclusive?: boolean;
  /** The app's origins with their configured headers and credentials, where the default has none. */
  readonly protectedApp?: ProtectedApp;
  /** Takes what the attempt's pages log, which goes nowhere by default. */
  readonly appLog?: (entry: AppLogEntry) => void;
  /** The tree the session reads its contexts from, where the default is one of its own that knows none. */
  readonly tree?: ContextTree;
  /** Routes the browser's events to the session and its tree (`routeEvents`), which hear none by default. */
  readonly routed?: boolean;
}

/**
 * A session on `fake` that has opened nothing yet, in `browser` with
 * windows that hold any viewport: `fake` models no window, and how one
 * grows has tests of its own (`tab-windows.test.ts`). It runs in a user
 * context of its own unless `userContext` says otherwise, on a 100 by 100
 * viewport, in a browser no other client drives, and hears none of the
 * browser's events, unless `setup` says otherwise.
 */
export function unopened(fake: FakeBidi, browser: BrowserName = 'chromium', userContext: UserContextMode = 'fresh', setup: SessionSetup = {}): BidiSession {
  const tree = setup.tree ?? new ContextTree();
  const settings = { media: {}, viewport: { width: 100, height: 100 }, initScripts: { forAttempt: () => [] }, permissions: [], userContext, testIdAttribute: 'data-testid', ...setup.settings };
  const attempt = { protectedApp: setup.protectedApp ?? new ProtectedApp(new Set(), undefined, undefined), appLog: setup.appLog ?? (() => undefined), navigation: () => undefined };
  const traits = setup.traits ?? { ...BROWSER_TRAITS[browser], windowClipsViewport: false };
  const built = new BidiSession({ connection: fake.connection, exclusive: setup.exclusive ?? true, traits } as never, settings as never, attempt as never, tree);
  if (setup.routed === true) routeEvents(fake.connection, tree, () => built);
  return built;
}

/**
 * Has `fake` answer as the browser an attempt opens its tabs in: the user
 * context it creates is `mine`, its data collector `c`, and the tabs it
 * opens are `tab`, then `tab-2`, each announced as a browser announces one.
 * For an attempt that adopts a tab (`adopt-tab`) it shows the one tab
 * `theirs` in its own user context (`adoptable`).
 */
export function opensTabs(fake: FakeBidi, userContext: UserContextMode = 'fresh'): FakeBidi {
  const tabs = ['tab', 'tab-2'];
  if (userContext === 'adopt-tab') adoptable(fake, 'theirs').on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } });
  return fake
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.create', () => {
      const context = tabs.shift() ?? 'none';
      fake.emit('browsingContext.contextCreated', contextInfo(context));
      return { result: { context } };
    });
}

/** A session (`unopened`) on `browser` with its user context and its tab `tab` open, on a `fake` that opens its tabs (`opensTabs`); the tab it opens next is `tab-2`. */
export async function session(fake: FakeBidi, browser: BrowserName = 'chromium'): Promise<BidiSession> {
  const opened = unopened(opensTabs(fake), browser);
  await opened.openUserContext(new AbortController().signal);
  await opened.ensureContext();
  return opened;
}

/**
 * A session with its tab `tab` open in a browser other clients drive too,
 * with headers configured, so an intercept covers exactly its tabs. `fake`
 * announces each tab it opens and closes, as a browser does, and the
 * session's events are routed. The tab it opens next is `tab-2`.
 */
export async function sharedSession(fake: FakeBidi): Promise<BidiSession> {
  let intercepts = 0;
  opensTabs(fake)
    .on('session.subscribe', { result: { subscription: 's' } })
    .on('network.addIntercept', () => ({ result: { intercept: `intercept-${String(++intercepts)}` } }))
    .on('browsingContext.getTree', { result: { contexts: [contextInfo('tab')] } })
    .on('browsingContext.close', (params) => {
      fake.emit('browsingContext.contextDestroyed', contextInfo(String(params['context'])));
      return { result: {} };
    });
  const shared = unopened(fake, 'chromium', 'fresh', {
    settings: { viewport: null },
    exclusive: false,
    protectedApp: new ProtectedApp(new Set(['http://app.test']), { 'x-preview': 'on' }, undefined),
    routed: true,
  });
  await shared.openUserContext(new AbortController().signal);
  await shared.ensureContext();
  return shared;
}

/** The contexts `fake` was asked to close, in order. */
export function closedTabs(fake: FakeBidi): unknown[] {
  return fake.commands('browsingContext.close').map((command) => command.params['context']);
}
