/**
 * A scripted WebDriver BiDi peer for unit tests: answers each command with
 * the handler registered for its method, records every command sent, and
 * emits events on demand.
 */

import type { BrowsingContext, Network } from 'webdriver-bidi-protocol';
import { BidiConnection, type BidiEventName, type BidiEventParams, type BidiTransport } from '../../src/driver/connection.ts';

/** One event with its parameters, for a list that holds events of different kinds. */
export type FakeEvent = { [E in BidiEventName]: readonly [method: E, params: BidiEventParams<E>] }[BidiEventName];

/**
 * A browsing context's info, as `getTree` lists it and its events carry it:
 * a tab of user context `mine` at `about:blank`, opened by no other, unless
 * `fields` say otherwise. A frame names its `parent`.
 */
export function contextInfo(context: string, fields: Partial<BrowsingContext.Info> = {}): BrowsingContext.Info {
  return { context, userContext: 'mine', parent: null, url: 'about:blank', children: null, clientWindow: 'w', originalOpener: null, ...fields };
}

/** A navigation of tab `context` to `url`, as its events name it; `navigation` is its id. */
export function navigationInfo(context: string, url: string, navigation: string | null = 'n'): BrowsingContext.NavigationInfo {
  return { context, url, navigation, timestamp: 0 };
}

/** The timings of a request no test reads: every mark at zero. */
const NO_TIMINGS: Network.FetchTimingInfo = {
  timeOrigin: 0, requestTime: 0, redirectStart: 0, redirectEnd: 0, fetchStart: 0, dnsStart: 0, dnsEnd: 0,
  connectStart: 0, connectEnd: 0, tlsStart: 0, requestStart: 0, responseStart: 0, responseEnd: 0,
};

/** A request as the network events carry it: a `GET` of `url` with no headers, cookies, or body, unless `fields` say otherwise. */
export function requestData(request: string, url: string, fields: Partial<Network.RequestData> = {}): Network.RequestData {
  return { request, url, method: 'GET', headers: [], cookies: [], headersSize: 0, bodySize: 0, destination: '', initiatorType: null, timings: NO_TIMINGS, ...fields };
}

/** A response as the network events carry it: `status` from `url` with no headers or body, unless `fields` say otherwise. */
export function responseData(url: string, status: number, fields: Partial<Network.ResponseData> = {}): Network.ResponseData {
  return { url, protocol: 'http/1.1', status, statusText: '', fromCache: false, headers: [], mimeType: '', bytesReceived: 0, headersSize: 0, bodySize: 0, content: { size: 0 }, ...fields };
}

/** One command the driver sent. */
export interface SentCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** What a handler returns: a result, or an error response. */
export type Reply = { readonly result: unknown } | { readonly error: string; readonly message?: string };

export class FakeBidi {
  readonly sent: SentCommand[] = [];
  readonly connection: BidiConnection;
  private deliver: (message: string) => void = () => undefined;
  private closed: () => void = () => undefined;
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => Reply | Promise<Reply>>();

  constructor() {
    const transport: BidiTransport = {
      send: (raw) => {
        const command = JSON.parse(raw) as SentCommand;
        this.sent.push(command);
        void this.answer(command);
      },
      onMessage: (handler) => {
        this.deliver = handler;
      },
      onClose: (handler) => {
        this.closed = handler;
      },
      close: () => this.closed(),
    };
    this.connection = new BidiConnection(transport);
  }

  /** Answers every later `method` command with `reply`; a method with no handler answers an empty result. */
  on(method: string, reply: Reply | ((params: Record<string, unknown>) => Reply | Promise<Reply>)): this {
    this.handlers.set(method, typeof reply === 'function' ? reply : () => reply);
    return this;
  }

  /** Emits one event to the driver, with every parameter the protocol gives it: an event the browser never sends in that shape does not compile. */
  emit<E extends BidiEventName>(method: E, params: BidiEventParams<E>): void {
    this.deliver(JSON.stringify({ type: 'event', method, params }));
  }

  /** Emits one vendor event (`goog:cdp.*`), which the protocol's typings do not list. */
  emitExtension(method: `${string}:${string}`, params: Record<string, unknown>): void {
    this.deliver(JSON.stringify({ type: 'event', method, params }));
  }

  /** Emits `events` to the driver, in order. */
  emitAll(events: readonly FakeEvent[]): void {
    for (const [method, params] of events) this.deliver(JSON.stringify({ type: 'event', method, params }));
  }

  /** Drops the transport, as a browser that went away. */
  drop(): void {
    this.closed();
  }

  /** The commands of `method` sent so far, in order. */
  commands(method: string): SentCommand[] {
    return this.sent.filter((command) => command.method === method);
  }

  /** Replies to one command with its method's handler, or an empty result. */
  private async answer(command: SentCommand): Promise<void> {
    const handler = this.handlers.get(command.method);
    const reply = handler === undefined ? { result: {} } : await handler(command.params);
    const message = 'result' in reply
      ? { type: 'success', id: command.id, result: reply.result }
      : { type: 'error', id: command.id, error: reply.error, message: reply.message ?? '' };
    this.deliver(JSON.stringify(message));
  }
}

/** Resolves after pending microtasks and one macrotask, so queued sends and replies settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Has `fake` answer what an adoption asks beside the open contexts: each of `tabs` is a page target, the first the visible one, and no document takes a call. */
export function adoptable(fake: FakeBidi, ...tabs: string[]): FakeBidi {
  return fake
    .on('goog:cdp.sendCommand', { result: { result: { targetInfos: tabs.map((targetId) => ({ targetId, type: 'page' })) } } })
    .on('script.getRealms', { result: { realms: [] } })
    .on('script.callFunction', (params) => ({ result: { type: 'success', realm: 'r', result: { type: 'boolean', value: (params['target'] as { context: string }).context === tabs[0] } } }));
}
