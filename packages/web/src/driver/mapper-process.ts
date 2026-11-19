/**
 * The `chromium-bidi` mapper in a process of its own: loads the mapper, reads
 * the CDP WebSocket URL and its handshake headers as its first stdin line (so it can boot while the
 * browser starts), connects, and speaks BiDi over stdio, one JSON message per
 * line. The BiDi driver spawns it, as chromedriver hosts the same
 * mapper, so a fault inside the mapper (its tab auto-attach leaves a CDP
 * rejection unhandled when a tab closes mid-attach) stays in this process
 * instead of failing the test worker. It exits when stdin closes or the CDP
 * connection drops.
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { WebSocket } from 'ws';
import { browserSocket, textOf } from './browser-socket.ts';
import { cdpFixups } from './cdp-fixups.ts';

/**
 * The rejection the mapper leaves unhandled when a tab closes while its
 * auto-attach is in flight: `CdpTargetManager` sends `Target.setAutoAttach`
 * for a tab target in a `void` async call with no catch, and the closed
 * session rejects it with chromium-bidi's `CloseError`. Nothing waits on that
 * call, so the attempt it belonged to has ended anyway.
 */
function isCloseRace(reason: unknown): boolean {
  return reason instanceof Error && reason.constructor.name === 'CloseError' && reason.message.startsWith('Target.setAutoAttach ');
}

/**
 * `DisposableStack`, which the mapper constructs and Node 22 lacks (it ships
 * from Node 24): a stack of cleanups run in reverse on `dispose`, once. Only
 * what the explicit resource management proposal defines for the sync stack,
 * installed only where the runtime has none.
 */
function installDisposableStack(): void {
  if ('DisposableStack' in globalThis) return;
  const dispose = Symbol.dispose ?? Symbol.for('Symbol.dispose');
  class DisposableStackPolyfill {
    #disposed = false;
    #cleanups: (() => void)[] = [];

    get disposed(): boolean {
      return this.#disposed;
    }

    #open(): void {
      if (this.#disposed) throw new ReferenceError('DisposableStack already disposed');
    }

    use<T>(value: T): T {
      this.#open();
      if (value !== null && value !== undefined) {
        const method = (value as Record<symbol, unknown>)[dispose];
        if (typeof method !== 'function') throw new TypeError('value is not disposable');
        this.#cleanups.push(() => method.call(value));
      }
      return value;
    }

    adopt<T>(value: T, onDispose: (value: T) => void): T {
      this.#open();
      this.#cleanups.push(() => onDispose(value));
      return value;
    }

    defer(onDispose: () => void): void {
      this.#open();
      this.#cleanups.push(onDispose);
    }

    move(): DisposableStackPolyfill {
      this.#open();
      const moved = new DisposableStackPolyfill();
      moved.#cleanups = this.#cleanups;
      this.#cleanups = [];
      this.#disposed = true;
      return moved;
    }

    dispose(): void {
      if (this.#disposed) return;
      this.#disposed = true;
      const errors: unknown[] = [];
      for (const cleanup of this.#cleanups.toReversed()) {
        try {
          cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      this.#cleanups = [];
      if (errors.length > 0) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'DisposableStack cleanups failed');
    }

    [Symbol.dispose](): void {
      this.dispose();
    }
  }
  Object.defineProperty(globalThis, 'DisposableStack', { value: DisposableStackPolyfill, writable: true, configurable: true });
}

/**
 * Hands the browser's messages to `deliver` one task apiece, in order, and
 * runs `closed` after the last. The mapper is written for a tab, where each
 * CDP message arrives in a task of its own and what a message starts (its
 * promise reactions) runs before the next; `ws` emits every message of one
 * network read in a row.
 */
function inTasks(socket: WebSocket, deliver: (message: string) => void, closed: () => void): void {
  /** What has yet to be handed on, oldest first; null is the close. */
  const waiting: (string | null)[] = [];
  const next = (): void => {
    const message = waiting.shift();
    if (message === undefined) return;
    if (waiting.length > 0) setImmediate(next);
    if (message === null) closed();
    else deliver(message);
  };
  const queue = (item: string | null): void => {
    if (waiting.push(item) === 1) setImmediate(next);
  };
  socket.on('message', (data) => queue(textOf(data)));
  socket.on('close', () => queue(null));
}

/** First line on stdout once the mapper serves, so the parent knows when to send. */
export const MAPPER_READY = '{"e2e":"ready"}';

/** The first stdin line, as JSON: the browser's CDP WebSocket URL, and the headers its upgrade needs. */
export interface MapperTarget {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** Loads the mapper (here, so the driver importing `MAPPER_READY` never does), then serves the CDP target the first stdin line names until the parent or the browser goes away. */
async function serve(): Promise<void> {
  installDisposableStack();
  process.on('unhandledRejection', (reason) => {
    if (isCloseRace(reason)) return;
    process.stderr.write(`chromium-bidi: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
    process.exit(1);
  });
  const loading = Promise.all([
    import('chromium-bidi/out/Default/gen/src/bidiMapper/BidiMapper.js'),
    import('chromium-bidi/out/Default/gen/src/cdp/CdpConnection.js'),
  ]);
  const lines = createInterface({ input: process.stdin });
  const queued: string[] = [];
  let toMapper: ((command: never) => void) | undefined;
  let cdpTarget: ((target: MapperTarget) => void) | undefined;
  const named = new Promise<MapperTarget>((resolve) => (cdpTarget = resolve));
  lines.on('line', (line) => {
    if (cdpTarget !== undefined) {
      // oxlint-disable-next-line e2e/no-unchecked-json -- the parent's own serialized target
      cdpTarget(JSON.parse(line) as MapperTarget);
      cdpTarget = undefined;
      return;
    }
    if (toMapper === undefined) queued.push(line);
    // oxlint-disable-next-line e2e/no-unchecked-json -- the parent's own serialized commands
    else toMapper(JSON.parse(line) as never);
  });
  lines.on('close', () => process.exit(0));
  const [[{ BidiServer }, { MapperCdpConnection }], { url, headers }] = await Promise.all([loading, named]);
  const socket = browserSocket(url, headers);
  await new Promise<void>((resolve, reject) => {
    const refused = (): void => reject(new Error(`CDP WebSocket ${headers === undefined ? url : new URL(url).origin} failed to open`));
    socket.once('error', refused);
    socket.once('open', () => {
      socket.off('error', refused);
      resolve();
    });
  });
  socket.on('error', (cause) => {
    process.stderr.write(`chromium-bidi: the CDP connection failed: ${cause.message}\n`);
    process.exit(1);
  });
  let readCdp: (message: string) => void = () => undefined;
  const fixed = cdpFixups((message) => readCdp(message), (message) => socket.send(message));
  inTasks(socket, (message) => fixed.receive(message), () => process.exit(0));
  const cdpConnection = new MapperCdpConnection({
    setOnMessage: (handler) => {
      readCdp = (message) => void handler(message);
    },
    sendMessage: (message) => fixed.send(message),
    close: () => socket.close(),
  });
  const browserClient = await cdpConnection.createBrowserSession();
  let deliver: (command: never) => void = () => undefined;
  await BidiServer.createAndStart(
    {
      setOnMessage: (handler) => {
        deliver = (command) => void handler(command);
      },
      sendMessage: (message) => {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      },
      close: () => undefined,
    },
    cdpConnection,
    browserClient,
    '',
  );
  toMapper = deliver;
  // oxlint-disable-next-line e2e/no-unchecked-json -- the parent's own serialized commands
  for (const line of queued.splice(0)) deliver(JSON.parse(line) as never);
  process.stdout.write(`${MAPPER_READY}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve().catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  });
}
