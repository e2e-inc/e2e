/**
 * What becomes of a request one of a user context's intercepts holds: a
 * redirect hop goes on with what its first hop was continued with, a hop
 * the browser sends again with credentials goes on as it is, a CORS
 * preflight is answered while routes are set, a blank-served tab gets a
 * blank document, and every other request runs the test's routes to one
 * decision (`network.continueRequest`, `provideResponse`, or `failRequest`),
 * after any fetch of its own a route makes of it. A held basic-auth
 * challenge is answered here too (`continueWithAuth`). The binding hands
 * each request over with its record when its hop starts, where a decision
 * keeps what the request's later hops and a response wait read.
 */

import { readFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';
import path from 'node:path';
import type { Network, Storage } from 'webdriver-bidi-protocol';
import { EngineError, TestError, type JsonValue, type OperationContext, type TextPattern } from '@e2e-dev/core/engine';
import type { BrowserTraits } from '../browsers.ts';
import { asError, BidiError, releaseQuietly } from '../errors.ts';
import { lowercaseNames, type ProtectedApp } from '../protected-app.ts';
import type { BidiConnection, BidiEventParams } from './connection.ts';
import { CONTENT_TYPES } from './content-types.ts';
import { bytesText, headerRecord, stripHash, wireHeaders } from './network-wire.ts';
import { fetchedResponse, replayRequest, setCookieOf, type FetchedResponse } from './route-fetch.ts';
import { routePatternMatches } from './route-pattern.ts';

/** A request the browser holds for a route to decide. */
export interface InterceptedRequest {
  readonly id: string;
  readonly url: string;
  readonly method: string;
  /** Header names lowercased, as Playwright reports a request's headers. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The request body's bytes decoded as UTF-8, when it has one the browser
   * reports: a body that is not text reads with U+FFFD in place of each
   * byte that is no UTF-8.
   */
  readonly postData?: string;
}

/** What `route.fulfill` hands the driver once the response is validated. */
export interface FulfillDecision {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly contentType?: string;
  readonly json?: JsonValue;
  /** A `Buffer` for bytes, sent unchanged. */
  readonly body?: string | Buffer;
  /** Absolute; the driver reads it and derives `Content-Type` from its extension when none is given. */
  readonly path?: string;
}

/**
 * What `route.continue` hands the driver once the overrides are validated;
 * `headers` before the site's are merged in, a header set to `undefined`
 * left out so the request goes without it.
 */
export interface ContinueDecision {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly postData?: string;
}

/** What a route does with one held request: exactly one of continue, fulfill, abort, and fallback runs, after any fetch. */
export interface RouteDecisions {
  continue(decision: ContinueDecision): Promise<void>;
  fulfill(decision: FulfillDecision): Promise<void>;
  abort(): Promise<void>;
  /** Hands the request to the next older matching route, or to the network. */
  fallback(): Promise<void>;
  /** Reads the upstream response within `budget`, without deciding the request or following a redirect. */
  fetch(budget: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<FetchedResponse>;
}

/** One registered route: the URL pattern it takes, and what it does with each request. */
export interface NetworkRoute {
  readonly pattern: TextPattern;
  readonly handle: (request: InterceptedRequest, decisions: RouteDecisions) => Promise<void>;
}

/** How the redirect hops of a request go on: the route's header overrides, the method its first hop was continued or answered as, and the site headers a request that starts where it did carries. */
interface RedirectPolicy {
  readonly overrides?: Readonly<Record<string, string>>;
  readonly method: string;
  readonly injected?: Readonly<Record<string, string>>;
}

/** The part of a request's record the decisions read and keep; the binding holds the record until the request is over, and drops what belongs to one hop when the next starts. */
export interface DecisionRecord {
  /** The browsing context its hop in flight came from: its body is read there, and its closing retires the request. */
  context: string;
  /**
   * Where its latest hop went, as its `beforeRequestSent` said: Firefox
   * names a challenge from a redirect's target with the URL the request
   * started at.
   */
  url?: string;
  /** How its redirect hops go on, kept until its last hop settles. */
  redirect?: RedirectPolicy;
  /** The body a route fulfilled its hop in flight with, which a response wait reads since the browser keeps none. */
  fulfilledBody?: Buffer;
  /**
   * What became of the basic-auth challenge of its hop in flight: `answered`
   * with the credentials, once, or let `through` as the 401 the page gets.
   */
  challenge?: 'answered' | 'through';
}

/** What a decision reads and writes of the user context that holds the request; the binding provides it. */
export interface DecisionScope {
  /** The body of held `request`, which came from `context`, as the browser gives it. */
  requestBody(request: Network.RequestData, context: string): Promise<HeldBody>;
  /** Stores `cookies` in the user context's jar, giving up once `signal` aborts. */
  storeCookies(cookies: readonly Storage.PartialCookie[], signal: AbortSignal): Promise<void>;
}

/**
 * A held request's body as the browser gives it: its bytes, `none` for a
 * request without one, `lost` for one the collector kept none of, and
 * `unreadable` for one with a part the browser reports no bytes of.
 */
export type HeldBody = Buffer | 'none' | 'lost' | 'unreadable';

/** Why a route's fetch has no body to replay a request with, for each way the scope found none. */
const NO_BODY: Readonly<Record<'lost' | 'unreadable', string>> = {
  lost: 'the browser kept none of the request body (too large or streamed)',
  unreadable: 'the browser reports no bytes for a part of the request body (a file on disk, or a stream)',
};

/** What deciding held requests needs of the attempt. */
export interface DecisionOptions {
  /** The configured headers and the basic-auth credentials the attempt reaches a protected app with. */
  readonly protectedApp: ProtectedApp;
  /** How the browser handles a continued request and a basic-auth challenge. */
  readonly traits: BrowserTraits;
  /** Takes a failure on a path no step awaits (deciding a held request, answering a challenge), for the next step to fail with. */
  readonly onFailure: (error: Error) => void;
  /** Takes the URL of a document request a test route aborted in `context`, before the abort goes out. */
  readonly onNavigationAbort: (context: string, url: string) => void;
  /** Aborts when the attempt closes, ending a route's fetch that nothing awaits any more. */
  readonly lifetime: AbortSignal;
}

/** Decides the requests and basic-auth challenges the intercepts of one user context hold. */
export class RequestDecisions {
  /** `routes` are the attempt's, oldest first, which it adds to and removes from in place. */
  constructor(
    private readonly connection: BidiConnection,
    private readonly scope: DecisionScope,
    private readonly options: DecisionOptions,
    private readonly routes: readonly NetworkRoute[],
  ) {}

  /**
   * Decides a held request as Playwright does. One with no `record` goes on
   * untouched: it is not the attempt's (another user context's, or of no
   * frame), or its hop was announced before. Firefox announces a hop again
   * when it sends it again with credentials, carrying what it was continued
   * with the first time, and deciding it again would run a route twice for
   * one request and apply header overrides that leave the credentials out.
   * Of the others, a redirect hop goes on with what its first hop was
   * continued with, a CORS preflight is answered while routes are set, a
   * request of a `blank`-served tab gets a blank page, and the rest go
   * through the routes.
   */
  decide(event: BidiEventParams<'network.beforeRequestSent'>, record: DecisionRecord | undefined, blank: boolean): void {
    const request = event.request.request;
    if (record === undefined) {
      this.pass(request);
      return;
    }
    const headers = headerRecord(event.request.headers);
    if (event.redirectCount > 0) {
      this.pass(request, this.redirectHeaders(event, record, headers));
      return;
    }
    if (event.request.method === 'OPTIONS' && headers['access-control-request-method'] !== undefined && this.routes.length > 0) {
      void this.answerPreflight(request, headers).catch((cause: unknown) => this.fail(cause));
      return;
    }
    const decided = blank ? this.answerBlank(event) : this.route(event, record, headers);
    void decided.catch(async (cause: unknown) => {
      await releaseQuietly(this.connection.send('network.failRequest', { request }));
      this.fail(cause);
    });
  }

  /**
   * Answers a held basic-auth challenge. One with no `record` is another
   * client's and gets the browser's default. The attempt's from a credential
   * origin gets the credentials, once on each hop of its request, so every
   * credential origin a redirect leads through is answered; one from any
   * other origin, a second one on the same hop (the credentials were
   * refused), and any without credentials go through as the 401. The record
   * keeps which it was (`challenge`). Firefox's default is a login prompt
   * BiDi neither reports nor dismisses, which stalls the navigation, so
   * there challenges are held even without credentials.
   */
  answerChallenge(event: BidiEventParams<'network.authRequired'>, record: DecisionRecord | undefined): void {
    const request = event.request.request;
    let answer: Network.ContinueWithAuthParameters;
    if (record === undefined) {
      answer = { request, action: 'default' };
    } else {
      const credentials = record.challenge === undefined ? this.options.protectedApp.credentialsFor(record.url ?? event.request.url) : undefined;
      record.challenge = credentials === undefined ? 'through' : 'answered';
      answer = credentials === undefined ? { request, action: 'cancel' } : { request, action: 'provideCredentials', credentials: { type: 'password', ...credentials } };
    }
    void this.connection.send('network.continueWithAuth', answer).catch((cause: unknown) => this.fail(cause));
  }

  /** Lets a held request go on, untouched unless `overrides` change it; a failure is the attempt's. */
  private pass(request: string, overrides: Partial<Network.ContinueRequestParameters> = {}): void {
    void this.connection.send('network.continueRequest', { request, ...overrides }).catch((cause: unknown) => this.fail(cause));
  }

  /**
   * The headers a redirect hop goes on with: the hop's own headers, with the
   * configured headers its request started with, to whatever origin the hop
   * names (a request that started elsewhere gets none on the way); the
   * route's overrides applied again, as Playwright does (a redirect is never
   * routed again), without the body's headers on every hop once a redirect
   * turned the request into a GET: Fetch makes a GET of a POST on a 301 or
   * 302 and of every method but HEAD on a 303, and drops the body with its
   * headers. A hop with nothing to change goes on untouched.
   */
  private redirectHeaders(event: BidiEventParams<'network.beforeRequestSent'>, record: DecisionRecord, headers: Record<string, string>): Partial<Network.ContinueRequestParameters> {
    const policy = record.redirect;
    if (policy === undefined) return {};
    let applied = headers;
    if (policy.overrides !== undefined) {
      applied = applyHeaderOverrides(applied, policy.overrides, this.options.traits.continueAddsCookies);
      if (policy.method !== 'GET' && event.request.method === 'GET') {
        for (const name of REQUEST_BODY_HEADERS) delete applied[name];
      }
    }
    if (policy.injected !== undefined) applied = { ...applied, ...policy.injected };
    return applied === headers ? {} : { headers: wireHeaders(applied) };
  }

  /** Answers a CORS preflight while routes are set, accepting it as Playwright does: a route on the URL means the test meant the request to go. */
  private async answerPreflight(request: string, headers: Record<string, string>): Promise<void> {
    const answer: Record<string, string> = {
      'access-control-allow-origin': headers['origin'] ?? '*',
      'access-control-allow-methods': headers['access-control-request-method'] ?? '',
      'access-control-allow-credentials': 'true',
      ...(headers['access-control-request-headers'] === undefined ? {} : { 'access-control-allow-headers': headers['access-control-request-headers'] }),
    };
    await this.connection.send('network.provideResponse', { request, statusCode: 204, reasonPhrase: 'No Content', headers: wireHeaders(answer) });
  }

  /** Answers a document request with an empty page; any other request of a blank-served tab fails. */
  private async answerBlank(event: BidiEventParams<'network.beforeRequestSent'>): Promise<void> {
    const request = event.request.request;
    if (event.navigation === null) {
      await this.connection.send('network.failRequest', { request });
      return;
    }
    await this.connection.send('network.provideResponse', {
      request,
      statusCode: 200,
      headers: [{ name: 'content-type', value: { type: 'string', value: 'text/html' } }],
      body: { type: 'string', value: '<!doctype html><title></title>' },
    });
  }

  /**
   * Hands a failure of an unawaited path to the attempt. A request the
   * browser already let go (the page navigated away under it, or cancelled
   * it) is no failure.
   */
  private fail(cause: unknown): void {
    if (cancelledRequest(cause)) return;
    this.options.onFailure(asError(cause));
  }

  /** Runs the matching routes newest first, then lets the request through with the site headers. */
  private async route(event: BidiEventParams<'network.beforeRequestSent'>, record: DecisionRecord, headers: Record<string, string>): Promise<void> {
    const request = event.request;
    const address = stripHash(request.url);
    const url = URL.canParse(address) ? new URL(address) : undefined;
    const matching = url === undefined ? [] : this.routes.filter((route) => routePatternMatches(route.pattern, url.href)).toReversed();
    const body = matching.length === 0 ? 'none' : await this.scope.requestBody(request, record.context);
    const intercepted: InterceptedRequest = {
      id: request.request,
      url: address,
      method: request.method,
      headers,
      ...(Buffer.isBuffer(body) ? { postData: body.toString() } : {}),
    };
    for (const route of matching) {
      let passed = false;
      await route.handle(intercepted, {
        continue: (decision) => unlessCancelled(this.continue(intercepted, record, decision)),
        fulfill: (response) => unlessCancelled(this.fulfill(intercepted, record, response)),
        abort: () => {
          if (event.navigation !== null && event.context !== null) this.options.onNavigationAbort(event.context, address);
          return unlessCancelled(this.connection.send('network.failRequest', { request: intercepted.id }));
        },
        fallback: async () => {
          passed = true;
        },
        fetch: (budget) => this.fetch(intercepted, request.cookies, body, budget),
      });
      if (!passed) return;
    }
    await unlessCancelled(this.continue(intercepted, record));
  }

  /**
   * A route's fetch of the request it holds: sends it from Node as the
   * browser sent it (its body bytes and its cookies) with the configured
   * headers `continue` adds, within `budget` and the attempt's lifetime, and
   * stores the cookies the response sets in the user context, as
   * Playwright's `route.fetch` does. A Basic challenge is answered with the
   * credentials a challenge to the browser from that origin gets, once. A
   * body the browser did not keep, or does not report whole, refuses the
   * fetch with that reason (`NO_BODY`) rather than send none or a part.
   */
  private async fetch(request: InterceptedRequest, cookies: readonly Network.Cookie[], body: HeldBody, budget: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<FetchedResponse> {
    if (body === 'lost' || body === 'unreadable') {
      throw new TestError('ACTION_FAILED', `route.fetch: ${NO_BODY[body]}, so the request cannot be replayed`);
    }
    const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(budget.timeoutMs), this.options.lifetime]);
    const { protectedApp } = this.options;
    const headers = {
      ...request.headers,
      ...(cookies.length === 0 ? {} : { cookie: cookies.map((cookie) => `${cookie.name}=${bytesText(cookie.value)}`).join('; ') }),
      ...protectedApp.headersFor(request.url),
    };
    const sent = { url: request.url, method: request.method, headers, ...(body === 'none' ? {} : { body }) };
    const fetched = await replayRequest(sent, protectedApp.credentialsFor(request.url), signal);
    const set = fetched.headers.getSetCookie().flatMap((header) => setCookieOf(header, new URL(request.url)) ?? []);
    if (set.length > 0) await this.scope.storeCookies(set, signal);
    return fetchedResponse(request.url, fetched);
  }

  /**
   * Lets a held request go on, with its overrides and, for the app's site,
   * the configured headers. Header overrides follow Playwright's rules: a
   * header the browser owns (cookie, host, origin, content-length, `sec-*`
   * and the like) keeps the browser's value, and a new body sets its own
   * `content-length` on a browser that would keep the old one. The route's
   * header overrides and the configured headers added are kept for the
   * request's redirect hops (`keepRedirectPolicy`). Firefox cannot rewrite
   * the URL (`firefoxUrlRewrite`), so there a rewrite is refused before the
   * request goes.
   */
  private async continue(request: InterceptedRequest, record: DecisionRecord, overrides: ContinueDecision = {}): Promise<void> {
    if (overrides.url !== undefined && !this.options.traits.continueRewritesUrl) throw firefoxUrlRewrite(request.url);
    const site = this.options.protectedApp.headersFor(overrides.url ?? request.url);
    const routeHeaders = overrides.headers === undefined ? undefined : lowercaseNames(overrides.headers);
    let headers = routeHeaders === undefined ? undefined : applyHeaderOverrides(request.headers, routeHeaders, this.options.traits.continueAddsCookies);
    if (overrides.postData !== undefined && this.options.traits.continueKeepsContentLength) headers = { ...(headers ?? request.headers), 'content-length': String(Buffer.byteLength(overrides.postData)) };
    if (site !== undefined) headers = { ...(headers ?? request.headers), ...site };
    keepRedirectPolicy(record, overrides.method ?? request.method, routeHeaders, site);
    await this.connection.send('network.continueRequest', {
      request: request.id,
      ...(overrides.url === undefined ? {} : { url: overrides.url }),
      ...(overrides.method === undefined ? {} : { method: overrides.method }),
      ...(headers === undefined ? {} : { headers: wireHeaders(headers) }),
      ...(overrides.postData === undefined ? {} : { body: { type: 'string' as const, value: overrides.postData } }),
    });
  }

  /**
   * Answers a held request with a response the test wrote; a `path` body's
   * type follows its extension. As Playwright's fulfill: the status carries
   * its reason phrase, a cross-origin request gets CORS headers unless the
   * response sets its own, the body goes as the decoded bytes it is, framed
   * by its own length whatever `content-encoding` and `content-length` the
   * headers name (as `route.fetch`'s do, over a body it already decoded), and
   * it is kept on the record for a response wait to read, since a browser
   * keeps no body it did not load. A response that is a redirect starts the
   * request's next hop, which carries the configured headers of the origin
   * the request started at, as after a redirect from the network
   * (`keepRedirectPolicy`).
   */
  private async fulfill(request: InterceptedRequest, record: DecisionRecord, response: FulfillDecision): Promise<void> {
    const { 'content-encoding': _encoding, 'content-length': _length, ...given } = lowercaseNames(response.headers);
    const headers: Record<string, string> = { ...given };
    let body: Buffer;
    if (response.json !== undefined) {
      body = Buffer.from(JSON.stringify(response.json));
      headers['content-type'] ??= 'application/json';
    } else if (response.path !== undefined) {
      body = await readFile(response.path);
      const type = CONTENT_TYPES[path.extname(response.path).toLowerCase()];
      if (type !== undefined) headers['content-type'] ??= type;
    } else {
      body = Buffer.from(response.body ?? '');
    }
    if (response.contentType !== undefined) headers['content-type'] = response.contentType;
    const origin = request.headers['origin'];
    if (origin !== undefined && URL.canParse(request.url) && new URL(request.url).origin !== origin.trim() && headers['access-control-allow-origin'] === undefined) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
      headers['vary'] = 'Origin';
    }
    headers['content-length'] = String(body.length);
    record.fulfilledBody = body;
    keepRedirectPolicy(record, request.method, undefined, this.options.protectedApp.headersFor(request.url));
    await this.connection.send('network.provideResponse', {
      request: request.id,
      statusCode: response.status,
      reasonPhrase: STATUS_CODES[response.status] ?? 'Unknown',
      headers: wireHeaders(headers),
      body: { type: 'base64', value: body.toString('base64') },
    });
  }
}

/**
 * Keeps on `record` how the redirect hops of its request go on
 * (`redirectHeaders`), which carry it wherever they go: the route's header
 * `overrides`, the `method` the first hop goes on or is answered as, and the
 * configured headers `injected` for the origin the request starts at. A
 * request with neither headers keeps nothing, and its hops go on untouched.
 */
function keepRedirectPolicy(
  record: DecisionRecord,
  method: string,
  overrides: Readonly<Record<string, string>> | undefined,
  injected: Readonly<Record<string, string>> | undefined,
): void {
  if (overrides === undefined && injected === undefined) return;
  record.redirect = { ...(overrides === undefined ? {} : { overrides }), method, ...(injected === undefined ? {} : { injected }) };
}

/** Headers a route may not override, as Playwright's `isForbiddenHeader` names them: the browser's value stands. */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'connection',
  'content-length', 'cookie', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'via',
]);

/** The headers of a request body, which a redirect that turns the request into a GET drops. */
const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

/** Whether a route may not override header `name` (with `value`), Playwright's rule. */
function isForbiddenHeader(name: string, value: string): boolean {
  if (FORBIDDEN_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) return true;
  return ['x-http-method', 'x-http-method-override', 'x-method-override'].includes(name) && ['CONNECT', 'TRACE', 'TRACK'].includes(value.toUpperCase());
}

/**
 * A route's header overrides applied to the request's own headers, as
 * Playwright's `applyHeadersOverrides`: the browser's forbidden headers stay,
 * the route's others replace the rest. With `freshCookies` (Chromium, which
 * adds them itself) the cookie header is left out, so the browser sends the
 * cookies its store holds when the request goes, not the ones it held when it
 * was held.
 */
function applyHeaderOverrides(original: Readonly<Record<string, string>>, overrides: Readonly<Record<string, string>>, freshCookies: boolean): Record<string, string> {
  const kept = Object.entries(original).filter(([name, value]) => isForbiddenHeader(name, value) && !(freshCookies && name === 'cookie'));
  const allowed = Object.entries(overrides).filter(([name, value]) => !isForbiddenHeader(name, value));
  return Object.fromEntries([...allowed, ...kept]);
}

/** Whether a decision failed because the page already cancelled the request it decides: no failure, as Playwright sends such decisions "may fail". */
function cancelledRequest(cause: unknown): boolean {
  return cause instanceof BidiError && (cause.error === 'no such request' || /Invalid InterceptionId/i.test(cause.message));
}

/**
 * Why Firefox cannot continue a request to another URL: it rewrites the URL
 * with a transparent internal redirect that breaks the load. A fetch, XHR,
 * image, or script reaches the new URL, but the page's load of it fails with
 * an `AbortError` (https://bugzilla.mozilla.org/show_bug.cgi?id=2014825); a
 * navigation goes without the headers the continue sets, and one to another
 * site crashes the tab.
 */
function firefoxUrlRewrite(url: string): EngineError {
  return new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `route.continue({ url }) for ${url} is not supported on Firefox, whose URL rewrite fails the page's fetch of it (https://bugzilla.mozilla.org/show_bug.cgi?id=2014825), drops the headers of a navigation, and crashes the tab on one to another site; answer the request with route.fulfill, or run on chromium`,
    { retryable: false },
  );
}

/** Waits for a decision on a held request, taking one the page already cancelled as made. */
async function unlessCancelled(decision: Promise<unknown>): Promise<void> {
  try {
    await decision;
  } catch (cause) {
    if (!cancelledRequest(cause)) throw cause;
  }
}
