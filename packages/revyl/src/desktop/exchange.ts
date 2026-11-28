/**
 * The runner's half of the relay: engine connections to servers on a Revyl
 * Mac, carried by execs. Each connection is a session of the relay there.
 * One loop per computer and process sends every session's pending bytes in
 * one exec and hands each session the bytes that came back, again while a
 * server owes an answer, then rests until a session has something to send.
 * The protocol framing tells it when a server owes one: a request the client
 * sent and the server has not answered.
 */

import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import type { TransportConnection } from 'e2e/engine';
import type { RevylComputerClient } from './client.ts';
import { FrameReader } from './remote/frames.ts';
import { parseAnswer, type ExchangeAnswer, type ExchangeRequest, type SessionExit } from './remote/wire.ts';

/** Bytes of protocol input one exec carries at most: its stdin, as base64 inside JSON, stays under Revyl's 16,384-byte bound. */
const INPUT_BUDGET = 9_000;
/** Bytes of output one exec returns at most: as base64 inside JSON, under the 1 MiB Revyl keeps of its stdout. */
const OUTPUT_BUDGET = 700_000;
/** How long one exec waits on the Mac for a server's answer before the loop asks again. */
const WAIT_MS = 10_000;

/** Where the relay is on the Mac, and the program that runs it. */
export interface RelayCommand {
  readonly node: string;
  readonly script: string;
  readonly socket: string;
}

/** One engine connection, as the relay carries it. */
class Session {
  readonly id = randomUUID();
  /** Bytes from the server, for the client to read. */
  readonly fromServer = new PassThrough();
  /** Bytes from the client, not yet sent. */
  queued: Buffer[] = [];
  opened = false;
  closing = false;
  closeSent = false;
  exit: SessionExit | undefined;
  readonly #ended: Promise<void>;
  #end: () => void = () => {};
  /** Requests the client sent that the server has not answered. */
  readonly #owed = new Set<number | string>();
  readonly #fromClient = new FrameReader();
  readonly #fromServerFrames = new FrameReader();

  constructor(readonly env: Readonly<Record<string, string>>) {
    this.#ended = new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  get owed(): boolean {
    return this.#owed.size > 0;
  }

  get ended(): Promise<void> {
    return this.#ended;
  }

  send(chunk: Buffer): void {
    for (const { message } of this.#fromClient.push(chunk)) {
      if (message?.method !== undefined && message.id !== undefined && message.id !== null) this.#owed.add(message.id);
    }
    this.queued.push(chunk);
  }

  receive(chunk: Buffer): void {
    for (const { message } of this.#fromServerFrames.push(chunk)) {
      if (message?.method === undefined && message?.id !== undefined && message.id !== null) this.#owed.delete(message.id);
    }
    this.fromServer.write(chunk);
  }

  finish(exit: SessionExit): void {
    if (this.exit !== undefined) return;
    this.exit = exit;
    this.#owed.clear();
    this.fromServer.end();
    this.#end();
  }
}

/** The relay of one computer, in this process. */
export class ComputerRelay {
  readonly #sessions = new Set<Session>();
  #running = false;
  #more = false;

  constructor(
    readonly computerId: string,
    readonly client: RevylComputerClient,
    readonly command: RelayCommand,
  ) {}

  /** Opens a connection to a new server on the Mac, which gets `env` on top of the relay's environment. */
  open(env: Readonly<Record<string, string>>): TransportConnection {
    const session = new Session(env);
    this.#sessions.add(session);
    const output = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        if (session.exit === undefined) {
          session.send(chunk);
          this.#kick();
        }
        done();
      },
    });
    this.#kick();
    return {
      input: session.fromServer,
      output,
      diagnostics: () => describe(session.exit),
      // A close that runs out of time leaves the session to the loop, which still sends its close and lets go of it once the server ended.
      close: async (timeoutMs) => {
        session.closing = true;
        this.#kick();
        await Promise.race([session.ended, new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)).unref())]);
        if (session.exit !== undefined) this.#sessions.delete(session);
      },
    };
  }

  #kick(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop().finally(() => {
      this.#running = false;
      if ([...this.#sessions].some(needsExchange)) this.#kick();
    });
  }

  async #loop(): Promise<void> {
    for (;;) {
      const live = [...this.#sessions].filter((session) => session.exit === undefined);
      if (!this.#more && !live.some(needsExchange)) return;
      const request = this.#request(live);
      let answer: ExchangeAnswer;
      try {
        const result = await this.client.exec(
          this.computerId,
          [this.command.node, this.command.script, 'exchange', this.command.socket],
          { stdin: Buffer.from(JSON.stringify(request)), timeoutMs: request.wait + 30_000 },
          AbortSignal.timeout(request.wait + 120_000),
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.toString('utf8').trim() || `the relay exchange exited with code ${result.exitCode}`);
        answer = parseAnswer(result.stdout.toString('utf8'));
      } catch (cause) {
        // Nothing reaches these servers any more: each connection fails with the reason.
        const reason = `reaching the engine server on Revyl computer ${this.computerId} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        for (const session of live) {
          session.finish({ code: null, signal: null, stderr: reason });
          if (session.closing) this.#sessions.delete(session);
        }
        return;
      }
      for (const session of live) {
        const bytes = answer.output[session.id];
        if (bytes !== undefined) session.receive(Buffer.from(bytes, 'base64'));
        const exit = answer.exited[session.id];
        if (exit !== undefined) session.finish(exit);
        if (session.exit !== undefined && session.closing) this.#sessions.delete(session);
      }
      this.#more = answer.more;
    }
  }

  /** The next exchange: every session to open and close, as much queued input as one exec carries, and a wait only when a server owes an answer and nothing is left to send. */
  #request(live: readonly Session[]): ExchangeRequest {
    const open = live.filter((session) => !session.opened).map((session) => ({ id: session.id, env: session.env }));
    const input: Record<string, string> = {};
    let budget = INPUT_BUDGET;
    for (const session of live) {
      if (budget <= 0 || session.queued.length === 0) continue;
      const all = Buffer.concat(session.queued);
      const taken = all.subarray(0, budget);
      session.queued = taken.length < all.length ? [all.subarray(taken.length)] : [];
      budget -= taken.length;
      input[session.id] = taken.toString('base64');
    }
    const close = live.filter((session) => session.closing && !session.closeSent && session.queued.length === 0).map((session) => session.id);
    for (const session of live) {
      session.opened = true;
      if (close.includes(session.id)) session.closeSent = true;
    }
    const waiting = live.every((session) => session.queued.length === 0) && live.some((session) => session.owed || session.closeSent);
    return { sessions: live.map((session) => session.id), open, input, close, wait: waiting && !this.#more ? WAIT_MS : 0, budget: OUTPUT_BUDGET };
  }
}

/** Whether a session has something to send, or waits on its server. */
function needsExchange(session: Session): boolean {
  return session.exit === undefined && (!session.opened || session.queued.length > 0 || session.owed || (session.closing && !session.closeSent) || session.closeSent);
}

function describe(exit: SessionExit | undefined): string {
  if (exit === undefined) return '';
  const status = exit.code !== null ? `exited with code ${exit.code}` : exit.signal !== null ? `killed by ${exit.signal}` : '';
  return [status, exit.stderr === '' ? '' : `stderr:\n${exit.stderr}`].filter((part) => part !== '').join('; ');
}
