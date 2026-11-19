/**
 * Fixes for five faults of the chromium-bidi mapper (still present in 159.0.8147) and one of
 * Chrome's, applied to the CDP stream the mapper reads and the commands it sends.
 *
 * Redirect pauses: Chrome sends a redirect hop's `Fetch.requestPaused` and
 * its `Network.requestWillBeSent` in either order, and the mapper handles a
 * pause that comes first only for a request's first hop: a later hop's early
 * pause lands on the previous hop, which already reported
 * `network.beforeRequestSent`, so the mapper continues the hop untouched and
 * never reports it, and a route's header overrides never reach the redirect.
 * A redirect hop's pause names the pause of the hop before it
 * (`redirectedRequestId`), and each such pause is held until its hop is
 * sent. A request that never sends `Network.requestWillBeSent` is never held.
 *
 * Restarted loads: Chrome pauses a hop again, under a new Fetch id and with
 * no new `Network.requestWillBeSent`, when the renderer starts the hop's
 * load over. Blink does so for a web font: it asks the HTTP cache alone
 * first, and on a miss loads the font again from the network. The mapper
 * continues the second pause with no overrides, so what the first pause was
 * continued with (a route's headers, the configured headers, a rewritten
 * URL) never reaches the server. Such a pause names no
 * `redirectedRequestId`: it is never held, and the mapper's continue of it
 * is sent with what the mapper continued the hop's first pause with.
 *
 * Early response ExtraInfo: Chrome sends `Network.responseReceivedExtraInfo`
 * out of band, so the next hop's can arrive before the redirect's
 * `Network.requestWillBeSent`, and the mapper gives the redirect hop that
 * response (a 302 reported as the 200 it led to, under the first URL). A hop
 * gets one such event, so a second one before the next hop is held until that
 * hop is sent, or until the request's own response or end.
 *
 * Site icons: the mapper drops every event of a request whose URL ends in
 * `/favicon.ico` (`NetworkRequest#isIgnoredEvent`), yet still blocks it when
 * an intercept covers it, so the request would stay paused with no driver
 * ever told. Its pauses are answered here, as the mapper answers a request no
 * intercept blocks, and never reach the mapper.
 *
 * Worker requests: a dedicated worker has no Fetch domain, so Chrome pauses
 * its requests on the session of the page that owns it, and announces them
 * (`Network.requestWillBeSent`) on the worker's own, in either order: on
 * Chrome 157 a POST of 64 KB or more was paused first every time, one of
 * 1 KB now and then. The mapper keeps a request on the target whose session
 * sent its latest event, and asks that target's subscriptions and
 * intercepts whether the request is held; a worker's target is under none
 * that names a user context or a tab. So a request paused first sits on the
 * worker's target once the mapper has both events: the mapper expects no
 * intercept and waits for the request's ExtraInfo, which Chrome sends once
 * the request is continued, and neither reports the request nor continues
 * it. A pause the mapper has yet to answer when a worker's session first
 * announces its request is handed to the mapper again, after the
 * announcement: the request is back on the page's target with both events,
 * and is reported from there.
 *
 * Request bodies: Chrome answers `Network.getRequestPostData` from the
 * renderer, which leaves a form's file read from disk out of the body
 * without a word, and has no answer for a body that is one such file. The
 * pause carries the body as the browser will send it (`postDataEntries`,
 * one entry without bytes for each part it cannot report: a file on disk, a
 * stream). From a request's pause at the request stage until the mapper
 * answers it (continues, fulfills, or fails it), the command is answered
 * here from the pause, and never reaches the browser: the bytes of every
 * entry, `NO_POST_DATA` for a request without a body, as Chrome answers,
 * and `UNREPORTED_POST_DATA` when an entry has no bytes. The body is kept no
 * longer than that.
 *
 * Sessions: Chrome reports one request on more than one CDP session. A
 * dedicated worker's fetch is announced on the worker's session, where its
 * response and its end come too, and paused on the page's, where its
 * ExtraInfo comes too; a worker's script is announced and paused on the
 * page's session and ends on the worker's; a frame's document that commits
 * in another process is paused on the session of the process the frame
 * leaves and ends on that of the process it joins. Request ids are unique
 * across the browser (a renderer's are its process id and a count, a
 * document's is its loader's token), so a request is kept once, by its id,
 * whatever session reports it: a worker's redirect pause waits on the
 * page's session for the hop the worker's session announces, and the end of
 * a load on any session releases the request. A Fetch id is kept with the
 * session that paused under it, where the mapper answers it. A session that
 * detaches takes what it paused with it, and a request no other session
 * reported; the pauses another session holds for a hop it was to announce
 * go to the mapper, since no session is left to announce the hop.
 */

/** Chrome's own failure of `Network.getRequestPostData` for a request without a body. */
export const NO_POST_DATA = 'No post data available for the request';

/** The failure of `Network.getRequestPostData` for a paused request whose body has a part Chrome reports no bytes of. */
export const UNREPORTED_POST_DATA = 'A part of the post data has no bytes';

/** One part of a paused request's body, as `Fetch.requestPaused` lists it: its bytes in base64, or none Chrome reports. */
interface PostDataEntry {
  readonly bytes?: string;
}

/** A request-stage pause the mapper was handed and has yet to continue, fulfill, or fail. */
interface UnansweredPause {
  /** Its Fetch id, and the session it came on. */
  readonly id: string;
  readonly session: string;
  /** The body it reported, part by part, as one part without bytes when it listed none; undefined for a request without one. */
  readonly posted: readonly PostDataEntry[] | undefined;
  /** The pause as Chrome sent it, while no session has announced its request: a worker's announcement hands it to the mapper again. */
  early?: string;
}

/** A redirect pause held for its hop, and the session it came on. */
interface HeldPause {
  readonly session: string;
  readonly message: string;
}

/** What the fixups keep of one request, whatever sessions report it, from its first event until its load ends on one of them, or every session that reported it detached. */
interface RequestHops {
  /** The sessions that reported an event of it and are still attached. */
  readonly sessions: Set<string>;
  /** The session whose `Network.requestWillBeSent` announced its latest hop, while that session is attached. */
  announcer?: string;
  /** How many redirect hops were announced, and how many of their pauses were handed on. */
  redirects: number;
  redirectPauses: number;
  /** The redirect pauses waiting for their hop. */
  held: HeldPause[];
  /** The response ExtraInfo events the hop in flight got, and the next hops' held behind them. */
  infos: number;
  heldInfos: string[];
  /** The Fetch ids the hop in flight was paused under, oldest first: more than one once its load restarted. */
  pauses: string[];
  /** What the mapper continued the first of `pauses` with, beside the id. */
  overrides?: Record<string, unknown>;
  /** The latest of `pauses`, until the mapper answers it. */
  unanswered?: UnansweredPause;
}

/** What the fixups read of a CDP message. */
interface CdpMessage {
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: {
    readonly requestId?: string;
    readonly networkId?: string;
    readonly redirectedRequestId?: string;
    readonly sessionId?: string;
    readonly targetInfo?: { readonly type?: string };
    readonly responseStatusCode?: number;
    readonly responseErrorReason?: string;
    readonly request?: { readonly url?: string; readonly hasPostData?: boolean; readonly postDataEntries?: readonly PostDataEntry[] };
    readonly redirectResponse?: unknown;
  };
}

/** The mapper's CDP connection with the fixups applied, in both directions. */
export interface CdpFixups {
  /** Takes a message from the browser, and hands the mapper what it may read of it. */
  readonly receive: (message: string) => void;
  /** Takes a command of the mapper's, and sends the browser what it should get of it. */
  readonly send: (message: string) => void;
}

const WATCHED = [
  '"Network.requestWillBeSent"',
  '"Network.responseReceivedExtraInfo"',
  '"Network.responseReceived"',
  '"Fetch.requestPaused"',
  '"Fetch.authRequired"',
  '"Network.loadingFinished"',
  '"Network.loadingFailed"',
  '"Target.attachedToTarget"',
  '"Target.detachedFromTarget"',
];

/** The ids of the fixups' own CDP commands, far above any the mapper numbers up from 0, so no answer reaches a command of its. */
const FIRST_COMMAND_ID = 2_000_000_000;

/** A CDP message from the browser; only optional fields are read. */
function parse(message: string): CdpMessage {
  // oxlint-disable-next-line e2e/no-unchecked-json -- a CDP message from the browser; only optional fields are read
  return JSON.parse(message) as CdpMessage;
}

/** A CDP command the mapper sends. */
interface CdpCommand {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A CDP command of the mapper's, whole, so it can be sent on with other parameters, or answered. */
function parseCommand(message: string): CdpCommand {
  // oxlint-disable-next-line e2e/no-unchecked-json -- the mapper's own serialized command; only optional fields are read
  return JSON.parse(message) as CdpCommand;
}

/** The commands of the mapper's that answer a request-stage pause. */
const ANSWERS = ['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest'];

/** The commands of the mapper's the fixups read: the answers of a pause, of which a continue may change, and the one they answer themselves. */
const SENT = [...ANSWERS, 'Network.getRequestPostData'].map((method) => `"${method}"`);

/**
 * What `Network.getRequestPostData` answers for a request paused with the
 * body `posted`: its bytes, the failure Chrome answers a request without a
 * body with, or the failure that tells a part has no bytes.
 */
function postDataAnswer(posted: readonly PostDataEntry[] | undefined): { readonly result: { readonly postData: string; readonly base64Encoded: true } } | { readonly error: { readonly code: number; readonly message: string } } {
  if (posted === undefined) return { error: { code: -32000, message: NO_POST_DATA } };
  const parts = posted.flatMap((entry) => (entry.bytes === undefined ? [] : [Buffer.from(entry.bytes, 'base64')]));
  if (parts.length < posted.length) return { error: { code: -32000, message: UNREPORTED_POST_DATA } };
  return { result: { postData: Buffer.concat(parts).toString('base64'), base64Encoded: true } };
}

/** Whether the mapper ignores every event of the request `message` pauses, its own rule. */
function isSiteIcon(message: CdpMessage): boolean {
  return message.params?.request?.url?.endsWith('/favicon.ico') === true;
}

/**
 * The mapper's CDP connection with the fixups on it. `receive` takes each
 * message of the browser's and hands the mapper's handler (`deliver`) what
 * it may read: a redirect hop's request-stage `Fetch.requestPaused` after
 * the hop's `Network.requestWillBeSent`, a response ExtraInfo with its own
 * hop, a worker's pause once more after the announcement that came behind
 * it, and none of a site icon's pauses, which are answered on `write`, the
 * mapper's CDP socket. `send` takes each command of the mapper's and writes
 * it, its continue of a restarted load with what the load's first pause was
 * continued with; its `Network.getRequestPostData` for a request whose pause
 * it has yet to answer is answered from the pause instead. A request is
 * forgotten once its load ends on any session, or every session that
 * reported it detached. Every other message passes through in order,
 * unparsed unless it names one of the events or commands the fixups depend
 * on.
 */
export function cdpFixups(deliver: (message: string) => void, write: (message: string) => void): CdpFixups {
  const requests = new Map<string, RequestHops>();
  /** The request each pause handed on belongs to, by the session the pause came on, then by its Fetch id. */
  const byPause = new Map<string, Map<string, RequestHops>>();
  /** The sessions of dedicated workers, whose requests are paused on another session. */
  const workers = new Set<string>();
  let nextId = FIRST_COMMAND_ID;
  const command = (sessionId: string, method: string, params: Record<string, unknown>): void => {
    write(JSON.stringify({ id: nextId++, method, params, ...(sessionId === '' ? {} : { sessionId }) }));
  };
  const hopsOf = (session: string, request: string): RequestHops => {
    let hops = requests.get(request);
    if (hops === undefined) requests.set(request, (hops = { sessions: new Set(), redirects: 0, redirectPauses: 0, held: [], infos: 0, heldInfos: [], pauses: [] }));
    hops.sessions.add(session);
    return hops;
  };
  /** Drops the Fetch ids the hop in flight of `hops` was paused under. */
  const unpause = (hops: RequestHops): void => {
    for (const pauses of byPause.values()) for (const id of hops.pauses) if (pauses.get(id) === hops) pauses.delete(id);
    hops.pauses.length = 0;
  };
  /**
   * Hands a request-stage pause on: to the mapper, or for a site icon,
   * straight back to the browser. One the mapper gets is kept by its Fetch
   * id for the mapper's answer of it, with the body it reports until then:
   * a redirect hop's starts the hop in flight, any other joins the pauses
   * that hop already has. One handed on before any session announced its
   * request is kept whole until one does.
   */
  const pause = (message: string, parsed: CdpMessage = parse(message)): void => {
    const { sessionId = '', params } = parsed;
    const hops = params?.networkId === undefined ? undefined : hopsOf(sessionId, params.networkId);
    const redirect = params?.redirectedRequestId !== undefined;
    if (hops !== undefined && redirect) hops.redirectPauses++;
    if (isSiteIcon(parsed) && params?.requestId !== undefined) {
      command(sessionId, 'Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    if (hops !== undefined && params?.requestId !== undefined) {
      if (redirect) {
        unpause(hops);
        delete hops.overrides;
      }
      let pauses = byPause.get(sessionId);
      if (pauses === undefined) byPause.set(sessionId, (pauses = new Map()));
      hops.pauses.push(params.requestId);
      pauses.set(params.requestId, hops);
      hops.unanswered = {
        id: params.requestId,
        session: sessionId,
        posted: params.request?.hasPostData === true ? (params.request.postDataEntries ?? [{}]) : undefined,
        ...(hops.announcer === undefined ? { early: message } : {}),
      };
    }
    deliver(message);
  };
  /**
   * Forgets request `id`, its load having ended on one of the sessions that
   * report it; the pauses still held for a hop of it go to the mapper first.
   */
  const forget = (id: string): void => {
    const hops = requests.get(id);
    if (hops === undefined) return;
    for (const held of hops.held.splice(0)) pause(held.message);
    unpause(hops);
    requests.delete(id);
  };
  /**
   * Session `session` announced a hop of request `id`, a redirect's when
   * `redirected`. A pause of the request the mapper got before any
   * announcement and has yet to answer is handed to it again when the
   * session is a worker's: the announcement moved the request to the
   * worker's target, where the mapper holds nothing. A redirect starts the
   * next hop: the response ExtraInfo and the pause held for it follow.
   */
  const announce = (session: string, id: string, redirected: boolean): void => {
    const hops = hopsOf(session, id);
    const early = hops.unanswered?.early;
    if (hops.unanswered !== undefined) delete hops.unanswered.early;
    hops.announcer = session;
    if (early !== undefined && workers.has(session)) deliver(early);
    if (!redirected) return;
    hops.infos = 0;
    const info = hops.heldInfos.shift();
    if (info !== undefined) {
      hops.infos++;
      deliver(info);
    }
    hops.redirects++;
    const held = hops.held.shift();
    if (held !== undefined) pause(held.message);
  };
  /**
   * Session `session` detached. What it paused can be answered no more, and
   * a request it alone reported has no end left to come, so both are
   * forgotten. A request it announced and another session reports too gets
   * no further hop announced: the pauses that session holds for one go to
   * the mapper.
   */
  const detach = (session: string): void => {
    workers.delete(session);
    byPause.delete(session);
    for (const [id, hops] of requests) {
      if (!hops.sessions.delete(session)) continue;
      if (hops.sessions.size === 0) {
        requests.delete(id);
        continue;
      }
      hops.held = hops.held.filter((held) => held.session !== session);
      if (hops.unanswered?.session === session) delete hops.unanswered;
      if (hops.announcer !== session) continue;
      delete hops.announcer;
      for (const held of hops.held.splice(0)) pause(held.message);
    }
  };
  const receive = (message: string): void => {
    if (!WATCHED.some((method) => message.includes(method))) {
      deliver(message);
      return;
    }
    const parsed = parse(message);
    const { method, sessionId = '', params } = parsed;
    if (method === 'Fetch.authRequired' && isSiteIcon(parsed) && params?.requestId !== undefined) {
      command(sessionId, 'Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: { response: 'Default' } });
      return;
    }
    if (method === 'Fetch.requestPaused' && params?.responseStatusCode === undefined && params?.responseErrorReason === undefined) {
      const hops = params?.networkId === undefined ? undefined : hopsOf(sessionId, params.networkId);
      if (hops !== undefined && params?.redirectedRequestId !== undefined && hops.announcer !== undefined && hops.redirectPauses >= hops.redirects) {
        hops.held.push({ session: sessionId, message });
        return;
      }
      pause(message, parsed);
      return;
    }
    if (method === 'Network.responseReceivedExtraInfo' && params?.requestId !== undefined) {
      const hops = hopsOf(sessionId, params.requestId);
      if (hops.infos > 0) {
        hops.heldInfos.push(message);
        return;
      }
      hops.infos++;
      deliver(message);
      return;
    }
    const ended = (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && params?.requestId !== undefined ? params.requestId : undefined;
    const answered = method === 'Network.responseReceived' ? params?.requestId : ended;
    if (answered !== undefined) for (const info of requests.get(answered)?.heldInfos.splice(0) ?? []) deliver(info);
    deliver(message);
    if (method === 'Network.requestWillBeSent' && params?.requestId !== undefined) {
      announce(sessionId, params.requestId, params.redirectResponse !== undefined);
    } else if (ended !== undefined) {
      forget(ended);
    } else if (method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'worker' && params.sessionId !== undefined) {
      workers.add(params.sessionId);
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId !== undefined) {
      detach(params.sessionId);
    }
  };
  const send = (message: string): void => {
    if (!SENT.some((method) => message.includes(method))) {
      write(message);
      return;
    }
    const parsed = parseCommand(message);
    const session = parsed.sessionId ?? '';
    const named = parsed.params?.['requestId'];
    if (parsed.method === 'Network.getRequestPostData' && typeof named === 'string') {
      const paused = requests.get(named)?.unanswered;
      if (paused?.session !== session) write(message);
      else deliver(JSON.stringify({ id: parsed.id, ...postDataAnswer(paused.posted), ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }) }));
      return;
    }
    const pauseId = parsed.method !== undefined && ANSWERS.includes(parsed.method) && typeof named === 'string' ? named : undefined;
    const hops = pauseId === undefined ? undefined : byPause.get(session)?.get(pauseId);
    if (hops === undefined) {
      write(message);
      return;
    }
    if (hops.unanswered?.id === pauseId) delete hops.unanswered;
    if (parsed.method !== 'Fetch.continueRequest') {
      write(message);
      return;
    }
    if (hops.pauses[0] === pauseId) {
      const { requestId: _requestId, ...overrides } = parsed.params ?? {};
      hops.overrides = overrides;
      write(message);
      return;
    }
    write(JSON.stringify({ ...parsed, params: { ...hops.overrides, ...parsed.params } }));
  };
  return { receive, send };
}
