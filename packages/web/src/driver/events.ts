/**
 * The browser-wide events of one BiDi session routed to the running attempt:
 * which user context each browsing context belongs to, the tabs the app
 * opens and closes, user prompts for its dialog router, and the console,
 * errors, and failed requests of its app log.
 */

import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import type { AppLogEntry } from '@e2e-dev/core/engine';
import type { BrowserTraits } from '../browsers.ts';
import { ChromiumCdp } from './cdp.ts';
import { bidiConsoleText, cdpConsoleText, cdpExceptionText } from './console-text.ts';
import type { ContextTree } from './context-tree.ts';
import type { BidiSession } from './session.ts';
import type { BidiConnection } from './connection.ts';
import { asError, releaseQuietly } from '../errors.ts';
import { callFunction } from './script.ts';

/**
 * The events every session subscribes to for as long as the browser runs.
 * A page's log is not among them: each attempt subscribes to it for its own
 * user context, from where its browser reports it (`AttemptLog`).
 */
export const SESSION_EVENTS = [
  'network.responseStarted',
  'network.responseCompleted',
  'network.fetchError',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  'browsingContext.navigationStarted',
  'browsingContext.navigationCommitted',
  'browsingContext.navigationFailed',
  'browsingContext.domContentLoaded',
  'browsingContext.fragmentNavigated',
  'browsingContext.historyUpdated',
  'browsingContext.userPromptOpened',
  'browsingContext.downloadWillBegin',
  'browsingContext.downloadEnd',
  'input.fileDialogOpened',
] as const;

/** The CDP events a Chromium page's log is read off (`BrowserTraits.appLog`), each under the mapper's `goog:cdp` prefix. */
const CDP_LOG_EVENTS = ['goog:cdp.Runtime.consoleAPICalled', 'goog:cdp.Runtime.exceptionThrown', 'goog:cdp.Log.entryAdded'] as const;

/**
 * One attempt's subscriptions to its pages' log: console lines, uncaught
 * errors, and the browser's own lines, from where the browser reports them
 * (`BrowserTraits.appLog`), for each user context the attempt opens a tab
 * in, so a tab the app opens there is heard from its first line. Chromium
 * reports its own lines (`Log.entryAdded`) only for a CDP session told to,
 * so each tab's is, and that of a frame another process renders.
 */
export class AttemptLog {
  /** The subscription of each user context, by its id. */
  private readonly subscriptions = new Map<string, Promise<string>>();
  /** The CDP sessions told to report the browser's own lines. */
  private readonly enabled = new Set<string | undefined>();

  constructor(
    private readonly connection: BidiConnection,
    private readonly traits: BrowserTraits,
  ) {}

  /**
   * Hears the log of the tab `context`, opened in `userContext`: of every
   * tab there, once. A tab the attempt found open (`adopted`) is told to
   * report the browser's own lines before anything listens, so the lines it
   * collected before the attempt, which Chromium sends again as it is
   * told, reach no one.
   */
  async openedTab(userContext: string, context: string, adopted: boolean): Promise<void> {
    if (adopted) await this.reportBrowserLines(context);
    let subscription = this.subscriptions.get(userContext);
    if (subscription === undefined) {
      const events = this.traits.appLog === 'cdp' ? CDP_LOG_EVENTS : (['log.entryAdded'] as const);
      subscription = this.connection.send('session.subscribe', { events: [...events] as never, userContexts: [userContext] }).then((result) => result.subscription);
      this.subscriptions.set(userContext, subscription);
      subscription.catch(() => this.subscriptions.delete(userContext));
    }
    await subscription;
    if (!adopted) await this.reportBrowserLines(context);
  }

  /**
   * Has Chromium report its own lines for the documents `context`'s CDP
   * session renders (`Log.enable`, which sends the ones it collected so far
   * too): a tab's, or a frame's that another process renders. A session
   * already told is left alone. Nothing to do where the browser reports
   * them with the rest (`BrowserTraits.appLog`).
   */
  async reportBrowserLines(context: string): Promise<void> {
    if (this.traits.appLog !== 'cdp') return;
    const cdp = await ChromiumCdp.forContext(this.connection, context);
    if (this.enabled.has(cdp.session)) return;
    this.enabled.add(cdp.session);
    try {
      await cdp.send('Log.enable', {});
    } catch (cause) {
      this.enabled.delete(cdp.session);
      throw cause;
    }
  }

  /** Ends every subscription, so a browser that outlives the attempt reports its pages to no one. */
  async close(): Promise<void> {
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(subscriptions.map(async (subscription) => releaseQuietly(this.connection.send('session.unsubscribe', { subscriptions: [await subscription] }))));
  }
}

/** Documents that are no place the app went: a fresh tab, an inline frame. */
const NO_PLACE = new Set(['about:blank', 'about:srcdoc']);

/** Chromium's and Firefox's codes for a request the page itself abandoned, which is no app failure. */
const ABORTED = new Set(['net::ERR_ABORTED', 'NS_BINDING_ABORTED']);

/**
 * Routes `connection`'s events to the attempt `current` returns; returns the
 * unsubscribe. A prompt in a context of another session (a browser shared
 * over CDP) is left for that session to answer. A tab one of the attempt's
 * tabs opens joins them once a document loads in it, its page behaving as
 * focused from when it opened (`BidiInput.emulateFocus`; one that closed
 * before it was told has no page to tell), and a tab that closes leaves
 * them, with the input state kept of it. Where the app went is told
 * to the app log: the shown tab's own navigations, the tabs the app opens,
 * where a background tab went, and the frames it loads, never the driver's.
 * Every origin a document starts or lands at (after a redirect) is visited,
 * for its permissions and a saved session's storage.
 */
export function routeEvents(connection: BidiConnection, contexts: ContextTree, current: () => BidiSession | undefined): () => void {
  const report = (entry: AppLogEntry): void => {
    try {
      current()?.attempt.appLog(entry);
    } catch {
      return;
    }
  };
  const ours = (context: string | null | undefined): BidiSession | undefined => {
    const session = current();
    return session?.owns(context) === true ? session : undefined;
  };
  /** Each attempt's lines still waiting on an earlier one, so the trace reads them in the order they happened. */
  const queued = new WeakMap<BidiSession, Promise<void>>();
  const send = (session: BidiSession, line: string): void => {
    if (session.lifetime.aborted) return;
    try {
      session.attempt.navigation(line);
    } catch {
      return;
    }
  };
  /**
   * Tells `session`'s trace where the app went, in event order: a line whose
   * text is still being read (`line` a promise) holds its place, and the
   * lines after it wait for it. Only the attempt the event belonged to hears
   * it, never one that started since.
   */
  const went = (session: BidiSession, line: string | Promise<string>): void => {
    const before = queued.get(session);
    if (before === undefined && typeof line === 'string') {
      send(session, line);
      return;
    }
    const next = (before ?? Promise.resolve()).then(async () => send(session, await line));
    queued.set(session, next);
    void next.finally(() => {
      if (queued.get(session) === next) queued.delete(session);
    });
  };
  /**
   * Fails the attempt's next step when `setup` of the tab or frame
   * `context` failed, unless that one is gone: the browser announces a
   * close ahead of the failure of a command still out for it.
   */
  const watch = (session: BidiSession, context: string, setup: Promise<void>): void => {
    void setup.catch((cause: unknown) => {
      if (contexts.owner(context) !== undefined) session.latch.latch(asError(cause));
    });
  };
  /** The navigation whose document joined each tab the app opened, which the opening already told. */
  const joinedBy = new Map<string, string>();
  const navigated = (event: { readonly context: string; readonly url: string; readonly navigation?: string | null }): void => {
    const session = ours(event.context);
    if (session === undefined || NO_PLACE.has(event.url) || event.url.startsWith('data:')) return;
    void session.userContext.visit(event.url).catch((cause: unknown) => session.latch.latch(asError(cause)));
    if (contexts.top(event.context) !== event.context) {
      watch(session, event.context, session.log.reportBrowserLines(event.context));
      went(session, frameName(connection, event.context).then((name) => `frame${name === '' ? '' : ` "${name}"`} loaded ${event.url}`));
      return;
    }
    // A tab yet to join (its opening tells its first document) or no tab at all (a saved-state scratch tab).
    if (session.tabs.find(event.context) === undefined) return;
    if (event.navigation != null && joinedBy.get(event.context) === event.navigation) return;
    if (event.context !== session.context) went(session, `a background tab navigated to ${event.url}`);
    else if (!session.navigations.inFlight) went(session, `navigated to ${event.url}`);
  };
  const offs = [
    connection.on('browsingContext.contextCreated', (info) => {
      contexts.created(info.context, info.userContext, info.parent);
      const session = ours(info.context);
      if (info.parent != null || info.originalOpener == null || session === undefined) return;
      // A user context the attempt shares with the browser's own windows also holds the tabs those open, which are not the app's.
      if (!session.tabs.holds(contexts.top(info.originalOpener))) return;
      void session.network.addContext(info.context).catch((cause: unknown) => session.latch.latch(asError(cause)));
      watch(session, info.context, session.input.emulateFocus(info.context));
      watch(session, info.context, session.log.openedTab(session.userContext.id, info.context, false));
      session.tabs.appOpened(info.context, info.originalOpener);
    }),
    connection.on('browsingContext.contextDestroyed', (info) => {
      const session = ours(info.context);
      if (session !== undefined && contexts.top(info.context) !== info.context) {
        session.network.retire(info.context);
      } else if (session !== undefined) {
        session.tabs.destroyed(info.context);
        void session.network.removeContext(info.context).catch((cause: unknown) => session.latch.latch(asError(cause)));
      }
      current()?.input.forget(info.context);
      joinedBy.delete(info.context);
      contexts.destroyed(info.context);
    }),
    connection.on('browsingContext.navigationStarted', (event) => {
      const session = ours(event.context);
      if (session === undefined) return;
      void session.userContext.visit(event.url).catch((cause: unknown) => session.latch.latch(asError(cause)));
      session.tabs.navigationStarted(event.context, event.url);
    }),
    connection.on('browsingContext.navigationFailed', (event) => {
      ours(event.context)?.tabs.navigationFailed(event.context);
    }),
    connection.on('browsingContext.domContentLoaded', (event) => {
      const session = ours(event.context);
      if (session?.tabs.loaded(event.context, event.url) === undefined) return;
      if (event.navigation != null) joinedBy.set(event.context, event.navigation);
      went(session, `the app opened a new tab${NO_PLACE.has(event.url) ? '' : ` at ${event.url}`}`);
    }),
    connection.on('browsingContext.navigationCommitted', navigated),
    connection.on('browsingContext.fragmentNavigated', navigated),
    connection.on('browsingContext.historyUpdated', navigated),
    connection.on('browsingContext.userPromptOpened', (prompt) => {
      const session = ours(prompt.context);
      if (session === undefined) return;
      const answer = async (accept: boolean, userText?: string): Promise<void> => {
        await connection.send('browsingContext.handleUserPrompt', { context: prompt.context, accept, ...(userText === undefined ? {} : { userText }) });
      };
      void session.dialogs.dispatch({
        type: prompt.type,
        message: prompt.message,
        accept: (text) => answer(true, text),
        dismiss: () => answer(false),
      });
    }),
    connection.on('log.entryAdded', (entry) => {
      if (ours(entry.source.context) === undefined || entry.text === null) return;
      if (entry.type === 'javascript') report({ source: 'error', level: 'error', text: entry.text });
      else if (entry.level !== 'debug' && !entry.text.startsWith('Failed to load resource:')) {
        const text = 'args' in entry ? bidiConsoleText(entry.text, entry.args) : entry.text;
        report({ source: 'console', level: entry.level === 'warn' ? 'warning' : entry.level, text: located(text, entry.stackTrace) });
      }
    }),
    cdpLog(connection, 'Runtime.consoleAPICalled', ({ type, args, stackTrace }) => {
      const level = CONSOLE_LEVELS[type] ?? 'info';
      if (level !== 'debug') report({ source: 'console', level, text: located(cdpConsoleText(args), stackTrace) });
    }),
    cdpLog(connection, 'Runtime.exceptionThrown', ({ exceptionDetails }) => {
      report({ source: 'error', level: 'error', text: cdpExceptionText(exceptionDetails) });
    }),
    cdpLog(connection, 'Log.entryAdded', ({ entry }) => {
      // A line that names a request is the console's echo of a load the network line tells of.
      if (entry.level === 'verbose' || entry.networkRequestId !== undefined) return;
      report({ source: 'console', level: entry.level, text: located(entry.text, entry.stackTrace) });
    }),
    connection.on('network.responseCompleted', (event) => {
      const { status, statusText } = event.response;
      if (ours(event.context) === undefined || status < 400 || isMissingFavicon(event.request.url, status)) return;
      report({ source: 'network', level: status >= 500 ? 'error' : 'warning', text: `${event.request.method} ${event.request.url} ${status}${statusText === '' ? '' : ` ${statusText}`}` });
    }),
    connection.on('network.fetchError', (event) => {
      if (ours(event.context) === undefined || ABORTED.has(event.errorText)) return;
      report({ source: 'network', level: 'error', text: `${event.request.method} ${event.request.url} ${event.errorText}` });
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** The frame's name (`window.name`, its iframe's `name` until the frame renames itself), as Playwright's `frame.name()` reads it; empty for a frame gone before it was read. */
async function frameName(connection: BidiConnection, context: string): Promise<string> {
  try {
    const name = await callFunction(connection, context, () => window.name);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/** The app log level of each console method Chromium names that is not a plain `info`; `debug` lines are left out, as BiDi's `debug` level is. */
const CONSOLE_LEVELS: Readonly<Record<string, AppLogEntry['level'] | 'debug'>> = { error: 'error', assert: 'error', warning: 'warning', debug: 'debug', trace: 'debug' };

/**
 * Listens for one of the CDP events a Chromium page's log is read off.
 * Every one that arrives is the attempt's: the only subscription to them is
 * its own, for its own user contexts (`AttemptLog`).
 */
function cdpLog<E extends 'Runtime.consoleAPICalled' | 'Runtime.exceptionThrown' | 'Log.entryAdded'>(
  connection: BidiConnection,
  event: E,
  handler: (params: ProtocolMapping.Events[E][0]) => void,
): () => void {
  return connection.onExtension(`goog:cdp.${event}`, (envelope) => handler(envelope['params'] as ProtocolMapping.Events[E][0]));
}

/** `message (at /app.js:12)`: the text, and the frame that logged it when the browser says, its line counted from one. */
function located(text: string, stackTrace: { readonly callFrames: readonly { readonly url: string; readonly lineNumber: number }[] } | undefined): string {
  const frame = stackTrace?.callFrames[0];
  return frame === undefined || frame.url === '' ? text : `${text} (at ${frame.url}:${frame.lineNumber + 1})`;
}

/** A browser's own request for a site icon the app never served, which the app log leaves out. */
function isMissingFavicon(url: string, status: number): boolean {
  return status === 404 && URL.canParse(url) && new URL(url).pathname === '/favicon.ico';
}
