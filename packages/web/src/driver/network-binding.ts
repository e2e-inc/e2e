/**
 * The part of an attempt's network that lives as long as one user context:
 * the subscription, collectors, and intercepts installed for it, its tabs,
 * and one record per request it has in flight, decided, or still loading a
 * body. Each request one of its intercepts holds is handed to the decisions
 * with its record (`network-decisions.ts`). A reset or restore replaces the
 * user context, and with it the whole binding, so nothing of the old
 * context's requests reaches the new one.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import { raceAbort } from '@e2e-dev/core/engine';
import type { ContextTree } from './context-tree.ts';
import { BidiError, releaseQuietly } from '../errors.ts';
import { ChromiumCdp } from './cdp.ts';
import { NO_POST_DATA, UNREPORTED_POST_DATA } from './cdp-fixups.ts';
import type { BidiConnection, BidiEventParams } from './connection.ts';
import { storeCookie } from './cookies.ts';
import { RequestDecisions, type DecisionOptions, type DecisionRecord, type DecisionScope, type HeldBody, type NetworkRoute } from './network-decisions.ts';
import { bytesOf, hasBody, headerRecord, stripHash } from './network-wire.ts';

/** A finished response as a response wait reports it. */
export interface ObservedResponse {
  readonly url: string;
  readonly status: number;
  /** Header names lowercased; cookie headers are left out, as Playwright's `response.headers()` does. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body once it finished loading, read once; rejects when the load failed or the browser kept none (a redirect, an evicted body). */
  body(): Promise<Buffer>;
}

/** Everything the binding keeps of one request, from its first event until its last hop settles, its tab closes, or every wait that matched it read its body. */
interface RequestRecord extends DecisionRecord {
  /** How many redirects led to its hop in flight, as the hop's `beforeRequestSent` said. */
  redirectCount?: number;
  /** Whether it counts as in flight for `networkidle`: a request of the attempt's tab that is no EventSource stream, between a hop's start and its settling. */
  counted: boolean;
  /** Whether its last hop settled. */
  settled: boolean;
  /** Response waits that matched it and have not finished reading its body. */
  waits: number;
  /** Told how its hop in flight ends, with what failed the load if anything did: one for each response wait that matched the hop. */
  loads: ((failure: Error | null) => void)[];
  /**
   * Each hands a response wait the response it matched, which answers the
   * hop in flight with a basic-auth challenge not decided yet: the waits are
   * handed it when it goes through to the page as the 401, and never when
   * the hop is sent again with credentials.
   */
  parked: (() => void)[];
  /** Its response body as the collector kept it, read once for every wait that matched it. */
  body?: Promise<Buffer>;
}

/** An intercept in place, and the tabs it covers (none on a browser of its own). */
interface InstalledIntercept {
  readonly id: string;
  readonly covers: string;
}

type InterceptPhase = 'beforeRequestSent' | 'authRequired';

/** What an attempt's network applies, on whatever user context it is bound to. */
export interface NetworkOptions extends DecisionOptions {
  /** Whether no other client drives the browser, so one intercept covers every tab from its first request. */
  readonly exclusive: boolean;
  /** The browsing-context tree, which tells a tab that closed from one still open, and whose subtree of a closed context has its requests retired with it. */
  readonly contexts: ContextTree;
  /** Whether an event belongs to the attempt. */
  readonly ours: (event: { readonly userContext?: string | null; readonly context: string | null }) => boolean;
  /** Whether a context is the attempt's tab or a frame in it, which a response wait and the idle count listen to. */
  readonly onPage: (context: string | null) => boolean;
}

/** The window of no requests in flight Playwright's `networkidle` waits for. */
const NETWORK_IDLE_MS = 500;
/** The largest body a collector keeps, per request or response. */
const MAX_COLLECTED_BODY = 20 * 1024 * 1024;

/** One user context's network state and the browser resources installed for it. */
export class NetworkBinding implements DecisionScope {
  /** The context's top-level tabs; intercepts cover exactly the ones still open, so a browser shared with other sessions keeps its own requests. */
  private readonly tops = new Set<string>();
  /** Top-level tabs whose every document request is answered with a blank page (`serveBlank`), before any route. */
  private readonly blank = new Set<string>();
  /** Every intercept added for the context, so a request a replaced one still holds is decided. */
  private readonly intercepts = new Set<string>();
  private readonly requests = new Map<string, RequestRecord>();
  private lastSettled = Date.now();
  private readonly installed = new Map<InterceptPhase, InstalledIntercept>();
  /** Whether the whole browser bypasses its HTTP cache for the binding, on a browser no other client drives. */
  private bypassesCache = false;
  /** The tabs that bypass the HTTP cache for the binding, on a browser other clients drive too. */
  private readonly uncached = new Set<string>();
  private subscription: string | undefined;
  private requestCollector: string | undefined;
  private collector: Promise<string> | undefined;
  /** The listeners of the request events, once something needs them. */
  private listeners: (() => void)[] = [];
  /** The listeners that tell how every request ended, and that the connection closed. */
  private readonly offSettle: (() => void)[];
  /** Fails each response wait still waiting for its response; one that has it, or gave up, is out. */
  private readonly waits = new Set<(failure: Error) => void>();
  private readonly decisions: RequestDecisions;
  private closed = false;

  /** `routes` are the attempt's, oldest first, which it adds to and removes from in place. */
  constructor(
    private readonly connection: BidiConnection,
    private readonly userContext: string,
    private readonly options: NetworkOptions,
    private readonly routes: readonly NetworkRoute[],
  ) {
    this.decisions = new RequestDecisions(connection, this, options, routes);
    this.offSettle = [
      connection.on('network.responseCompleted', (event) => this.settle(event, null)),
      connection.on('network.fetchError', (event) => this.settle(event, new Error(event.errorText))),
      connection.onClose(() => this.endWaits(new Error('the BiDi connection closed before the response finished loading'))),
    ];
  }

  /**
   * Brings what is installed in line with what the attempt needs now. Every
   * request of its tabs is held for configured headers, a route, or a
   * blank-served tab, and basic-auth challenges for credentials or a browser
   * that would prompt; the request events are needed for either, and for the
   * idle count once the attempt is `tracking`; request bodies are collected
   * for routes to read, where the collector is what reads them
   * (`requestBodies`), and the HTTP cache is bypassed while there is a
   * route, which sees only what asks the network. The subscription and its
   * listeners, the request and response collectors, the cache bypass, and
   * the intercepts are each checked on their own, so a step that failed
   * before is installed by the next call, one already in place is kept, and
   * an intercept, request collector, or cache bypass nothing needs any more
   * is removed.
   */
  async reconcile(tracking: boolean): Promise<void> {
    if (this.closed) return;
    const hold = this.options.protectedApp.sendsHeaders || this.routes.length > 0 || this.blank.size > 0;
    const auth = this.options.protectedApp.answersChallenges || this.options.traits.promptsForAuth;
    if (hold || auth || tracking) {
      if (this.listeners.length === 0) {
        this.listeners = [
          this.connection.on('network.beforeRequestSent', (event) => this.onRequest(event)),
          this.connection.on('network.authRequired', (event) => this.onAuth(event)),
        ];
      }
      this.subscription ??= (await this.connection.send('session.subscribe', {
        events: ['network.beforeRequestSent', 'network.authRequired'],
        userContexts: [this.userContext],
      })).subscription;
    }
    if (this.routes.length > 0 && this.options.traits.requestBodies === 'collector') {
      this.requestCollector ??= (await this.connection.send('network.addDataCollector', {
        dataTypes: ['request'],
        maxEncodedDataSize: MAX_COLLECTED_BODY,
        userContexts: [this.userContext],
      })).collector;
    } else if (this.requestCollector !== undefined) {
      await alreadyGone(this.connection.send('network.removeDataCollector', { collector: this.requestCollector }), this.connection);
      this.requestCollector = undefined;
    }
    await this.collectResponses();
    await this.ensureCacheBypass(this.routes.length > 0);
    await this.ensureIntercept('beforeRequestSent', hold);
    await this.ensureIntercept('authRequired', auth);
  }

  /** Covers top-level tab `tab` with the intercepts from the next `reconcile`; false for a tab that already closed. */
  cover(tab: string): boolean {
    if (this.options.contexts.owner(tab) === undefined) return false;
    this.tops.add(tab);
    return true;
  }

  /** Stops covering `tab`; false when it was not covered. */
  uncover(tab: string): boolean {
    return this.tops.delete(tab);
  }

  /** Answers every document request of `tab` with a blank page from the next `reconcile`, and covers it. */
  serveBlank(tab: string): void {
    this.blank.add(tab);
    this.tops.add(tab);
  }

  /** Lets `tab`'s requests go to the routes and the network again from the next `reconcile`. */
  unserveBlank(tab: string): void {
    this.blank.delete(tab);
  }

  /** Whether one of the binding's intercepts holds the request `event` reports. */
  private holds(event: { readonly isBlocked: boolean; readonly intercepts?: readonly string[] }): boolean {
    return event.isBlocked && (event.intercepts ?? []).some((intercept) => this.intercepts.has(intercept));
  }

  /**
   * A request started a hop, or the browser announces one again. The
   * attempt's own, from a frame, is recorded; one an intercept of the
   * binding holds is decided, with its record when the hop is the attempt's
   * and starts with the event.
   */
  private onRequest(event: BidiEventParams<'network.beforeRequestSent'>): void {
    const record = event.context !== null && this.options.ours(event) ? this.started(event, event.context) : undefined;
    if (this.holds(event)) this.decisions.decide(event, record, event.context !== null && this.blank.has(event.context));
  }

  /**
   * A basic-auth challenge one of the binding's intercepts holds is
   * answered, with its request's record when the request is the attempt's.
   * The response waits parked on the challenge's 401 are handed it when it
   * goes through; credentials make the browser send the hop again, so the
   * 401 is no response of the page's and the waits go on waiting.
   */
  private onAuth(event: BidiEventParams<'network.authRequired'>): void {
    if (!this.holds(event)) return;
    const record = this.options.ours(event) ? this.record(event.request.request, event.context ?? '') : undefined;
    this.decisions.answerChallenge(event, record);
    if (record === undefined) return;
    const parked = record.parked.splice(0);
    if (record.challenge === 'through') for (const claim of parked) claim();
  }

  /**
   * Keeps one intercept of `phase` in place while `wanted`. On a browser no
   * other client drives it covers every tab, so a tab the app opens is held
   * from its first request; otherwise it covers the open tabs exactly, so
   * other clients keep their own requests, and a change of tabs replaces it,
   * the new one in place before the old goes. Adding that one is tried again
   * while tabs close under it, and none is added once they all closed.
   */
  private async ensureIntercept(phase: InterceptPhase, wanted: boolean): Promise<void> {
    const connection = this.connection;
    const old = this.installed.get(phase);
    if (this.options.exclusive) {
      if (wanted && old === undefined) this.installed.set(phase, await this.addIntercept(phase));
      if (!wanted && old !== undefined) {
        this.installed.delete(phase);
        await alreadyGone(connection.send('network.removeIntercept', { intercept: old.id }), connection);
      }
      return;
    }
    const open = (): string[] => [...this.tops].filter((context) => this.options.contexts.owner(context) !== undefined);
    const target = wanted ? open() : [];
    if (target.length === 0 ? old === undefined : old?.covers === target.join('\n')) return;
    let added: InstalledIntercept | undefined;
    let [first, ...rest] = target;
    while (first !== undefined && added === undefined) {
      try {
        added = await this.addIntercept(phase, [first, ...rest]);
      } catch (cause) {
        const left = open();
        if (left.length === rest.length + 1) throw cause;
        [first, ...rest] = left;
      }
    }
    if (added === undefined) this.installed.delete(phase);
    else this.installed.set(phase, added);
    if (old !== undefined) await alreadyGone(connection.send('network.removeIntercept', { intercept: old.id }), connection);
  }

  /** Adds an intercept of `phase` for the tabs `contexts` lists, every tab when it lists none, and records it. */
  private async addIntercept(phase: InterceptPhase, contexts?: [string, ...string[]]): Promise<InstalledIntercept> {
    const { intercept } = await this.connection.send('network.addIntercept', { phases: [phase], ...(contexts === undefined ? {} : { contexts }) });
    this.intercepts.add(intercept);
    return { id: intercept, covers: contexts?.join('\n') ?? '' };
  }

  /**
   * Keeps the browser's HTTP cache bypassed while `wanted`, so every request
   * asks the network, where an intercept holds it. On a browser no other
   * client drives the whole browser bypasses it, so a tab the app opens asks
   * the network from its first request; otherwise the open tabs do, each
   * set on its own, and other clients keep their cache. A tab that closed
   * needs none set, and one that closes under the call is done.
   */
  private async ensureCacheBypass(wanted: boolean): Promise<void> {
    const connection = this.connection;
    if (this.options.exclusive) {
      if (this.bypassesCache === wanted) return;
      await connection.send('network.setCacheBehavior', { cacheBehavior: wanted ? 'bypass' : 'default' });
      this.bypassesCache = wanted;
      return;
    }
    const open = (tab: string): boolean => this.options.contexts.owner(tab) !== undefined;
    for (const tab of wanted ? this.tops : []) {
      if (this.uncached.has(tab) || !open(tab)) continue;
      try {
        await connection.send('network.setCacheBehavior', { cacheBehavior: 'bypass', contexts: [tab] });
      } catch (cause) {
        if (open(tab)) throw cause;
        continue;
      }
      this.uncached.add(tab);
    }
    for (const tab of this.uncached) {
      if (wanted && this.tops.has(tab)) continue;
      if (open(tab)) await alreadyGone(connection.send('network.setCacheBehavior', { cacheBehavior: 'default', contexts: [tab] }), connection);
      this.uncached.delete(tab);
    }
  }

  /** The context's response collector, added once however many waits ask at the same time. */
  private collectResponses(): Promise<string> {
    this.collector ??= this.connection.send('network.addDataCollector', {
      dataTypes: ['response'],
      maxEncodedDataSize: MAX_COLLECTED_BODY,
      userContexts: [this.userContext],
    }).then(({ collector }) => collector);
    const pending = this.collector;
    pending.catch(() => {
      if (this.collector === pending) this.collector = undefined;
    });
    return pending;
  }

  /** The record of `request`, made on first sight, from `context`. */
  private record(request: string, context: string): RequestRecord {
    let record = this.requests.get(request);
    if (record === undefined) this.requests.set(request, (record = { context, counted: false, settled: false, waits: 0, loads: [], parked: [] }));
    return record;
  }

  /**
   * Records the hop of the attempt's request that `event` announces in
   * `context`: where it goes, and whether it counts as in flight, as a
   * request of the attempt's tab does unless it is an EventSource stream,
   * which never settles. Returns the record when the hop starts with the
   * event, which a new redirect count tells: it starts without the
   * fulfilled body and the decided challenge of the hop before it. Under
   * the count of the hop in flight Firefox announces that hop again, each
   * time it sends it again with credentials: the ones its challenge was
   * answered with, or the ones it holds for the realm, which raise no
   * challenge. Nothing is returned for it, so a hop is decided once.
   */
  private started(event: BidiEventParams<'network.beforeRequestSent'>, context: string): RequestRecord | undefined {
    const record = this.record(event.request.request, context);
    const starts = record.redirectCount !== event.redirectCount;
    if (starts) {
      record.redirectCount = event.redirectCount;
      delete record.fulfilledBody;
      delete record.challenge;
    }
    record.context = context;
    record.url = event.request.url;
    record.settled = false;
    record.counted = this.options.onPage(context) && headerRecord(event.request.headers)['accept'] !== 'text/event-stream';
    return starts ? record : undefined;
  }

  /**
   * The body of held `request`, which came from `context`. Where the
   * request collector reads it (`requestBodies`), a request BiDi sizes at
   * nothing has none, and one the collector kept none of (too large, a
   * stream, no collector in place yet) is lost. Chromium's is read over CDP
   * (`pausedBody`).
   */
  async requestBody(request: Network.RequestData, context: string): Promise<HeldBody> {
    if (this.options.traits.requestBodies === 'cdp') return this.pausedBody(request, context);
    if (!hasBody(request)) return 'none';
    const collector = this.requestCollector;
    if (collector === undefined) return 'lost';
    try {
      return bytesOf((await this.connection.send('network.getData', { dataType: 'request', request: request.request, collector })).bytes);
    } catch (cause) {
      if (cause instanceof BidiError && cause.error === 'no such network data') return 'lost';
      throw cause;
    }
  }

  /**
   * The body of `request`, paused in `context`, from CDP's
   * `Network.getRequestPostData`, which the fixups in front of the mapper
   * answer from the pause (`cdp-fixups.ts`): the bytes the browser will
   * send, none for a request without a body, and unreadable when a part of
   * it has no bytes the browser reports, or when `context` closed under the
   * read and took the request with it. A GET or HEAD carries no body, and
   * is not asked for.
   */
  private async pausedBody(request: Network.RequestData, context: string): Promise<Buffer | 'none' | 'unreadable'> {
    if (request.method === 'GET' || request.method === 'HEAD') return 'none';
    try {
      const cdp = await ChromiumCdp.forContext(this.connection, context);
      const { postData, base64Encoded } = await cdp.send('Network.getRequestPostData', { requestId: request.request });
      return Buffer.from(postData, base64Encoded ? 'base64' : 'utf8');
    } catch (cause) {
      if (cause instanceof BidiError && cause.message.includes(NO_POST_DATA)) return 'none';
      if (cause instanceof BidiError && cause.message.includes(UNREPORTED_POST_DATA)) return 'unreadable';
      if (this.options.contexts.owner(context) === undefined) return 'unreadable';
      throw cause;
    }
  }

  /**
   * Stores `cookies` in the user context's jar, as a route's fetch does with
   * the ones its response set. Once the binding closed, its user context is
   * replaced or going, so the rest are dropped.
   */
  async storeCookies(cookies: readonly Storage.PartialCookie[], signal: AbortSignal): Promise<void> {
    for (const cookie of cookies) {
      if (this.closed) return;
      await raceAbort(() => storeCookie(this.connection, this.userContext, cookie), signal, 'route.fetch cookies');
    }
  }

  /**
   * A request's hop finished, with the `failure` that ended its load if one
   * did; the response waits that matched the hop are told, after any still
   * parked on a challenge nobody decided are handed its 401. The request
   * collector lets go of the hop's body: routes read it only while the first
   * hop is held, and a redirect seldom carries it on. A redirect hop
   * (`isRedirect`) stops counting and its record stays for the next hop; a
   * last hop's record goes, unless a response wait still reads its body, and
   * the collector lets go of a response body no wait matched.
   */
  private settle(event: { readonly context: string | null; readonly request: Network.RequestData; readonly response?: Network.ResponseData }, failure: Error | null): void {
    const id = event.request.request;
    const record = this.requests.get(id);
    if (record !== undefined) {
      this.stopCounting(record);
      for (const claim of record.parked.splice(0)) claim();
      for (const ended of record.loads.splice(0)) ended(failure);
    }
    const ours = !this.closed && this.options.ours(event);
    const requestCollector = this.requestCollector;
    if (ours && requestCollector !== undefined && hasBody(event.request)) {
      void releaseQuietly(this.connection.send('network.disownData', { dataType: 'request', collector: requestCollector, request: id }));
    }
    if (event.response !== undefined && isRedirect(event.response)) return;
    const read = record !== undefined && record.waits > 0;
    if (record !== undefined) record.settled = true;
    if (!read) this.requests.delete(id);
    if (!ours || read || record?.fulfilledBody !== undefined) return;
    void releaseQuietly(this.collector?.then((collector) => this.connection.send('network.disownData', { dataType: 'response', collector, request: id })));
  }

  /**
   * Retires the requests from any of `contexts`, which closed, whatever
   * events their teardown still sends. One a response wait still reads stays
   * until the wait is told how its load ended.
   */
  retire(contexts: ReadonlySet<string>): void {
    for (const [request, record] of this.requests) {
      if (!contexts.has(record.context)) continue;
      this.stopCounting(record);
      if (record.waits === 0) this.requests.delete(request);
    }
  }

  /** Drops one request from the in-flight count. */
  private stopCounting(record: RequestRecord): void {
    if (!record.counted) return;
    record.counted = false;
    if (![...this.requests.values()].some((one) => one.counted)) this.lastSettled = Date.now();
  }

  /** How long until the context has had no request in flight for 500 ms, Playwright's `networkidle`; undefined while one is. */
  untilIdle(): number | undefined {
    for (const record of this.requests.values()) if (record.counted) return undefined;
    return NETWORK_IDLE_MS - (Date.now() - this.lastSettled);
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive (`network.responseStarted`, in the
   * session's subscription); start the wait before the action that triggers
   * the response. The wait joins the request's record as the headers arrive,
   * so the ledger tells it how the load ends, even one that completes in the
   * same burst as its headers. The response to a basic-auth challenge the
   * binding may yet answer is parked on the record instead
   * (`pendingChallenge`), until the challenge is decided. Its body comes
   * from the response collector, and reading it waits for the load to
   * finish, then takes the body from the collector so the browser keeps it
   * no longer.
   */
  async waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const connection = this.connection;
    const { onPage } = this.options;
    if (this.closed) throw new Error('waitForResponse: the network ended');
    let claimed: RequestRecord | undefined;
    let fail: (failure: Error) => void = () => undefined;
    let offStart: () => void = () => undefined;
    const first = new Promise<{ event: BidiEventParams<'network.responseStarted'>; record: RequestRecord; loaded: Promise<void> }>((resolve, reject) => {
      fail = reject;
      offStart = connection.on('network.responseStarted', (event) => {
        if (claimed !== undefined || this.closed || !onPage(event.context) || !matches(stripHash(event.response.url))) return;
        const record = this.record(event.request.request, event.context ?? '');
        const claim = (): void => {
          if (claimed !== undefined || !this.waits.has(fail)) return;
          claimed = record;
          record.waits += 1;
          resolve({ event, record, loaded: hopLoaded(record) });
        };
        if (this.pendingChallenge(event.response, record)) record.parked.push(claim);
        else claim();
      });
    });
    first.catch(() => undefined);
    this.waits.add(fail);
    try {
      const collector = await this.collectResponses();
      const { event, record, loaded } = await raceAbort(first, signal, 'waitForResponse');
      const request = event.request.request;
      let read: Promise<Buffer> | undefined;
      const readOnce = async (): Promise<Buffer> => {
        try {
          if (isRedirect(event.response)) throw new Error('Response body is unavailable for redirect responses');
          await loaded;
          if (record.fulfilledBody !== undefined) return record.fulfilledBody;
          if (endsAtItsHeaders(event.response)) {
            void releaseQuietly(connection.send('network.disownData', { dataType: 'response', collector, request }));
            return Buffer.alloc(0);
          }
          record.body ??= connection.send('network.getData', { dataType: 'response', request, collector, disown: true }).then((data) => bytesOf(data.bytes), (cause: unknown) => {
            throw unkeptBody(cause);
          });
          return await record.body;
        } finally {
          record.waits -= 1;
          if (record.waits === 0 && record.settled && this.requests.get(request) === record) this.requests.delete(request);
        }
      };
      return {
        url: stripHash(event.response.url),
        status: event.response.status,
        headers: withoutCookies(headerRecord(event.response.headers)),
        body: () => (read ??= readOnce()),
      };
    } catch (cause) {
      if (claimed !== undefined) claimed.waits -= 1;
      throw cause;
    } finally {
      offStart();
      this.waits.delete(fail);
    }
  }

  /**
   * Whether `response` answers the hop of `record` in flight with a
   * basic-auth challenge the binding may yet answer, so it is not known to
   * be the page's: it names a challenge, while challenges are held and none
   * of the hop went through. Firefox reports a challenge's response before
   * the challenge; Chromium only the response the page gets, after it.
   */
  private pendingChallenge(response: Network.ResponseData, record: RequestRecord): boolean {
    return this.installed.has('authRequired') && record.challenge !== 'through' && (response.authChallenges ?? []).length > 0;
  }

  /** Ends every response wait still pending with `failure`, as when the connection closes: one that matched no response yet, and one whose response is still loading. */
  private endWaits(failure: Error): void {
    for (const fail of this.waits) fail(failure);
    for (const record of this.requests.values()) {
      for (const ended of record.loads.splice(0)) ended(failure);
    }
  }

  /**
   * Ends the binding at once: its listeners stop, so no later event of the
   * old context reaches anything, its requests stop counting, and its
   * pending response waits fail. Its browser resources stay for `release`.
   */
  close(): void {
    this.closed = true;
    for (const off of [...this.listeners.splice(0), ...this.offSettle]) off();
    this.endWaits(new Error('the network ended before the response finished loading'));
    this.requests.clear();
  }

  /** The removals of everything installed for the context: every intercept ever added, the collectors, the subscription, and the cache bypass, for the browser or for each tab that has it. */
  removals(): (() => Promise<unknown>)[] {
    const connection = this.connection;
    const collector = this.collector;
    const requestCollector = this.requestCollector;
    const subscription = this.subscription;
    const removals: (() => Promise<unknown>)[] = [
      ...[...this.intercepts].map((intercept) => () => connection.send('network.removeIntercept', { intercept })),
      ...(collector === undefined ? [] : [() => collector.then((id) => connection.send('network.removeDataCollector', { collector: id }))]),
      ...(requestCollector === undefined ? [] : [() => connection.send('network.removeDataCollector', { collector: requestCollector })]),
      ...(subscription === undefined ? [] : [() => connection.send('session.unsubscribe', { subscriptions: [subscription] })]),
      ...(this.bypassesCache ? [() => connection.send('network.setCacheBehavior', { cacheBehavior: 'default' })] : []),
      ...[...this.uncached].map((tab) => () => connection.send('network.setCacheBehavior', { cacheBehavior: 'default', contexts: [tab] })),
    ];
    this.collector = this.requestCollector = this.subscription = undefined;
    this.intercepts.clear();
    this.installed.clear();
    this.bypassesCache = false;
    this.uncached.clear();
    return removals;
  }
}

/** Resolves when the hop of `record` in flight finishes loading; rejects with what failed the load, or ended the network before it. */
function hopLoaded(record: RequestRecord): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    record.loads.push((failure) => (failure === null ? resolve() : reject(failure)));
  });
  loaded.catch(() => undefined);
  return loaded;
}

/** The failure of a response body read: one the browser refused for want of the body says so, with the size past which a collector keeps none; any other stands as it is. */
function unkeptBody(cause: unknown): unknown {
  if (!(cause instanceof BidiError) || cause.error !== 'no such network data') return cause;
  return new Error(`the browser kept none of the response body (it keeps none over ${String(MAX_COLLECTED_BODY / 1024 / 1024)} MB)`);
}

/**
 * Whether `response` ends at its headers: a 204 and a 304 cannot carry
 * content (RFC 9110, section 6.4.1), so a read of its body asks the browser
 * for nothing. Firefox answers `network.getData` for a 304 seconds late.
 */
function endsAtItsHeaders(response: Network.ResponseData): boolean {
  return response.status === 204 || response.status === 304;
}

/** `headers` without the cookie headers, which a response wait leaves out as Playwright's `response.headers()` does. */
function withoutCookies(headers: Record<string, string>): Record<string, string> {
  const { 'set-cookie': _setCookie, cookie: _cookie, ...rest } = headers;
  return rest;
}

/** The redirect statuses of the Fetch standard: the ones a browser follows when the response names a `Location`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Whether the browser follows `response` to another hop of its request, and
 * so keeps no body for it: a redirect status with a `Location` header, the
 * rule Chromium and Firefox both apply to a fetch and to a navigation. Any
 * other 3xx is a request's last hop: a 300, a 304, a 305, one with no
 * `Location`. BiDi says of no hop that it is the last, and a redirect the
 * page does not follow (`fetch` with `redirect: 'manual'` or `'error'`)
 * reads the same: Chromium announces its hop and fails it, Firefox says
 * nothing more, so there its record stays until its tab closes.
 */
function isRedirect(response: Network.ResponseData): boolean {
  return REDIRECT_STATUSES.has(response.status) && namesLocation(response);
}

/** Whether `response` carries a `Location` header. */
function namesLocation(response: Network.ResponseData): boolean {
  return response.headers.some((header) => header.name.toLowerCase() === 'location');
}

/** Errors that mean what a removal removes is already gone: the browser dropped it, its tab closed, or the browser itself is gone. */
const GONE = new Set(['no such intercept', 'no such network collector', 'no such network data', 'no such frame', 'invalid argument']);

/** Waits for a removal, taking a resource the browser no longer has (or a browser that is gone) as removed. */
export async function alreadyGone(removal: Promise<unknown> | undefined, connection: BidiConnection): Promise<void> {
  try {
    await removal;
  } catch (cause) {
    if (connection.isClosed || (cause instanceof BidiError && GONE.has(cause.error))) return;
    throw cause;
  }
}
