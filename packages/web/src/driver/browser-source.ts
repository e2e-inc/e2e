/**
 * Where the BiDi surface gets its browser: a local launch, the `connect`
 * endpoint (in a context of the attempt's own, or on the page it shows), a
 * browser provider's lease (one per worker or one per attempt), or
 * `attachBrowser`'s endpoint, whose open tab the attempt adopts. Each is
 * one `BrowserSource`, resolved once by `web()`; the surface asks it for a
 * browser and reads what it allows, and the source words its own limits, so
 * nothing re-derives the mode from options or branches on which source it is.
 */

import { CONNECT_EXISTING, type CdpTarget, type ConnectContext } from '../options.ts';
import {
  EngineError,
  withTimeout,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
} from '@e2e-dev/core/engine';
import type { LeasedBrowsers, LeaseRecording } from '../provider.ts';
import { ContextTree } from './context-tree.ts';
import type { RemoteDownloads } from './downloads.ts';
import { abortError, releaseQuietly } from '../errors.ts';
import { routeEvents, SESSION_EVENTS } from './events.ts';
import { connectBidiOverCdp, launchBidiBrowser, type BidiBrowser } from './launch.ts';
import type { BrowserName } from '../browsers.ts';
import type { BidiSession } from './session.ts';
import type { UserContextMode } from './user-context.ts';
import type { WebMedia } from '../options.ts';
import { browserCheck, ensureBrowsersInstalled } from '../install/provision.ts';

/** How long each stage of opening a browser (launch, attach, subscribe) may take. */
export const BROWSER_OPEN_TIMEOUT_MS = 60_000;

/** Resolves a CDP endpoint to attach to; `signal` aborts when the browser is no longer wanted. */
export type CdpEndpointResolver = (signal: AbortSignal) => string | CdpTarget | Promise<string | CdpTarget>;

/** What the surface asks a source for a browser with. */
interface BrowserRequestContext {
  /** Aborts when the browser is no longer wanted: the worker disposed, or the attempt it was for ended. */
  readonly signal: AbortSignal;
  /** The attempt the browser is for, in `attempt` scope. */
  readonly attempt?: EngineAttemptContext | undefined;
}

/** One of the ways the surface gets its browser: how it provisions, opens, and gives back its browsers, beside what it allows. */
export interface BrowserSource {
  /** What its errors call opening a browser: one on this machine is launched, any other connected to. */
  readonly opening: 'launch' | 'connect';
  /** `worker`: one browser for the worker, opened at init and again once it drops. `attempt`: a fresh browser for every attempt. */
  readonly scope: 'worker' | 'attempt';
  /**
   * The user context an attempt runs in. Only a `fresh` one lets an attempt
   * replace it (`app.clearState()`, saved sessions); any other is the
   * browser's own, and its `limit` says why `what` cannot replace that. A
   * `fresh` one a browser may be unable to create names what to do then
   * (`instead`).
   */
  readonly userContext: { readonly mode: 'fresh'; readonly instead?: string } | { readonly mode: Exclude<UserContextMode, 'fresh'>; readonly limit: (what: string) => string };
  /** Whether the browser's files are on this machine or on another one, which local paths do not reach. */
  readonly files: 'local' | 'remote';
  /** The `e2e doctor` checks of the browser. */
  doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]>;
  /** Provisions what the run's browsers need, once per run. */
  prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void>;
  /** Releases what `prepare` provisioned. */
  finish(info: EngineFinishInfo): Promise<void>;
  /** Records the worker's run, before any browser is opened. */
  init(info: EngineInitInfo): void;
  /** Opens one browser, failing once `request.signal` aborts at any stage: `CANCELLED`, or the deadline it aborted with. */
  open(request: BrowserRequestContext): Promise<BidiBrowser>;
  /** Gives back what `open` took for the attempt, in `attempt` scope; safe when it took nothing. */
  endAttempt(context: EngineCleanupContext): Promise<void>;
  /** Releases what the worker took for itself. */
  dispose(context: EngineCleanupContext): Promise<void>;
  /** How an attempt records the browser when its provider records it, in place of the screencast. */
  recorder(attemptId: string): ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined;
  /** How a download is read back off a provider's browser, or why one saved on another machine cannot be when its provider serves none; undefined for a browser that saves them on this machine. */
  downloads(): RemoteDownloads | undefined;
}

/** The parts of a source that do nothing for it. */
const NOTHING = {
  finish: async (): Promise<void> => undefined,
  endAttempt: async (): Promise<void> => undefined,
  dispose: async (): Promise<void> => undefined,
  recorder: (): undefined => undefined,
  downloads: (): undefined => undefined,
};

/** A browser launched on this machine from the pinned build `prepare` installs into the run's browsers cache, with the `media` the run sets for every page. */
export function launchSource(browser: BrowserName, media: WebMedia): BrowserSource {
  let run: { readonly headed: boolean; readonly env: Readonly<Record<string, string | undefined>> } | undefined;
  return {
    ...NOTHING,
    opening: 'launch',
    scope: 'worker',
    userContext: { mode: 'fresh' },
    files: 'local',
    doctor: (info) => browserCheck(browser, info.env, info.headed),
    prepare: async (info) => {
      await ensureBrowsersInstalled([browser], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
    },
    init: (info) => {
      run = { headed: info.headed, env: info.env };
    },
    open: ({ signal }) => {
      if (run === undefined) throw new EngineError('ENGINE_FAILURE', 'the browser was asked for before init', { retryable: false });
      return launchBidiBrowser(browser, { headed: run.headed, env: run.env, timeoutMs: BROWSER_OPEN_TIMEOUT_MS, signal, media });
    },
  };
}

/**
 * `web({ connect })`: a remote Chromium at the endpoint `endpoint` resolves,
 * each attempt in a fresh user context, or, with `context` `'existing'`, on
 * the page the browser already shows (`adoptedPage`).
 */
export function connectSource(endpoint: CdpEndpointResolver, context: ConnectContext): BrowserSource {
  const fresh = { mode: 'fresh', instead: `Set ${CONNECT_EXISTING} to drive the page it already shows.` } as const;
  return cdpSource('connect.cdpEndpoint', context === 'existing' ? adoptedPage(`with ${CONNECT_EXISTING}`, 'attempt') : fresh, endpoint);
}

/**
 * `attachBrowser`: the Chromium at `cdpEndpoint`, whose attempt adopts the
 * tab the browser shows (`adoptedPage`) and leaves both as they are.
 */
export function attachSource(cdpEndpoint: string): BrowserSource {
  return cdpSource("attachBrowser's cdpEndpoint", adoptedPage('on an attached browser', 'attach'), () => cdpEndpoint);
}

/**
 * The user context of an attempt that adopts the tab the browser shows in
 * its own user context (`foundTabs`) and creates neither a context nor a
 * tab. Its limit names how the browser was reached (`reached`) and what
 * drives it (`driver`).
 */
function adoptedPage(reached: string, driver: string): BrowserSource['userContext'] {
  return { mode: 'adopt-tab', limit: (what) => `${what} is unavailable ${reached}: it replaces the browser context, and the ${driver} drives the browser's own` };
}

/**
 * A Chromium attached to over CDP at the endpoint `endpoint` resolves,
 * which an error names as `named`, its attempts in `userContext`.
 */
function cdpSource(named: string, userContext: BrowserSource['userContext'], endpoint: CdpEndpointResolver): BrowserSource {
  return {
    ...NOTHING,
    opening: 'connect',
    scope: 'worker',
    userContext,
    files: 'local',
    doctor: async () => [{ id: 'browser', status: 'skip', message: 'the browser is attached over CDP' }],
    prepare: async () => undefined,
    init: () => undefined,
    open: async ({ signal }) => attach(named, await endpoint(signal), signal),
  };
}

/**
 * Browsers a provider leases: in `worker` scope one per worker slot, each
 * attempt in a fresh user context; in `attempt` scope a fresh browser per
 * attempt, run in that browser's own user context, which its `prepare` may
 * have signed in.
 */
export function leaseSource(leases: LeasedBrowsers): BrowserSource {
  return {
    opening: 'connect',
    scope: leases.scope,
    userContext: leases.scope === 'attempt'
      ? {
          mode: 'default',
          limit: (what) => `${what} is unavailable with browser provider "${leases.name}" with scope "attempt": it replaces the browser context, and the attempt rides the leased browser's own; every attempt already starts on a fresh browser, and scope "worker" can clear one mid-test`,
        }
      : { mode: 'fresh' },
    files: 'remote',
    doctor: async () => [{ id: 'browser', status: 'skip', message: `browsers come from the "${leases.name}" provider` }],
    prepare: (info) => leases.prepare(info),
    finish: (info) => leases.finish(info),
    init: (info) => leases.init(info),
    open: async ({ signal, attempt }) => {
      const target = attempt === undefined ? await leases.endpoint(signal) : await leases.cdpTarget(await leases.startAttempt({ ...attempt, signal }), signal);
      return attach('the browser provider', target, signal);
    },
    endAttempt: (context) => (leases.scope === 'attempt' ? leases.endAttempt(context) : Promise.resolve()),
    dispose: (context) => leases.dispose(context),
    recorder: (attemptId) => leases.recorder(attemptId),
    downloads: () => leases.downloads() ?? { unserved: `browser provider "${leases.name}" serves no downloads, so a file its browser saves on another machine cannot be read back` },
  };
}

/**
 * Attaches over CDP to the endpoint `source` resolved, a URL or a
 * `CdpTarget`, unless `signal` aborted while it resolved; an empty endpoint,
 * or headers that are not strings, are refused by the name of its source.
 */
function attach(source: string, resolved: unknown, signal: AbortSignal): Promise<BidiBrowser> {
  if (signal.aborted) throw abortError(signal, 'browser connect');
  const target = typeof resolved === 'string' ? { endpoint: resolved } : resolved;
  const endpoint = typeof target === 'object' && target !== null ? Reflect.get(target, 'endpoint') : undefined;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new EngineError('ENGINE_FAILURE', `${source} resolved to an empty CDP endpoint`, { retryable: false });
  }
  const headers: unknown = Reflect.get(target as object, 'headers');
  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Object.values(headers).some((value) => typeof value !== 'string'))) {
    throw new EngineError('ENGINE_FAILURE', `${source} resolved CDP headers that are not a record of strings`, { retryable: false });
  }
  return connectBidiOverCdp({ endpoint, ...(headers === undefined ? {} : { headers: headers as Readonly<Record<string, string>> }) }, BROWSER_OPEN_TIMEOUT_MS, signal);
}

/**
 * One open browser as the surface holds it: the browser, its events routed
 * to the running attempt, and the tree of its browsing contexts, all ended
 * by one `close`.
 */
export class BrowserHandle {
  private constructor(
    readonly browser: BidiBrowser,
    readonly contexts: ContextTree,
    private readonly unroute: () => void,
  ) {}

  /**
   * Routes `browser`'s events to the attempt `current` returns, subscribes
   * to them, and adds the browsing contexts already open to the tree. A
   * browser that fails that, or whose `signal` aborted meanwhile, is closed.
   */
  static async open(browser: BidiBrowser, current: () => BidiSession | undefined, signal: AbortSignal): Promise<BrowserHandle> {
    const contexts = new ContextTree();
    // Routed before subscribing, so no context event is lost; the snapshot then adds the contexts already open.
    const unroute = routeEvents(browser.connection, contexts, current);
    try {
      await withTimeout(
        (async () => {
          await browser.connection.send('session.subscribe', { events: [...SESSION_EVENTS] });
          await contexts.sync(async () => (await browser.connection.send('browsingContext.getTree', {})).contexts);
        })(),
        BROWSER_OPEN_TIMEOUT_MS,
        () => new EngineError('OPERATION_TIMEOUT', `the browser did not take its event subscription and list its open contexts within ${BROWSER_OPEN_TIMEOUT_MS}ms`, { retryable: false }),
      );
      if (signal.aborted) throw abortError(signal, 'browser open');
    } catch (cause) {
      unroute();
      await releaseQuietly(browser.close());
      throw cause;
    }
    return new BrowserHandle(browser, contexts, unroute);
  }

  /** Whether the browser is still connected. */
  get alive(): boolean {
    return !this.browser.connection.isClosed;
  }

  /** Stops routing its events and closes the browser: a launched one is killed, an attached one detached. */
  async close(): Promise<void> {
    this.unroute();
    await this.browser.close();
  }
}
