/**
 * Revyl's HTTP API for computers: creating a Mac, starting and stopping one,
 * and the operations that run on it, an `exec` or a file write. Every call
 * carries the run's API key and is bounded by its caller's signal.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { RevylCredentials } from '../credentials.ts';

const DEFAULT_API_URL = 'https://backend.revyl.ai';
const CONTROL_TIMEOUT_MS = 60_000;
/** A stop saves a persistent computer's disk first, which Revyl allows five minutes and ten seconds. */
const STOP_TIMEOUT_MS = 310_000;
const ATTEMPTS = 3;
// Revyl's edge refuses requests without a client user agent.
const USER_AGENT = `e2e-revyl/${(createRequire(import.meta.url)('../../package.json') as { version: string }).version}`;

/** States a computer never leaves for `active` again under the same run. */
const ENDED = new Set(['failed', 'stopped', 'stopping', 'owner_lost', 'closing']);
/** How long a computer gets to become active after a create or start. */
const ACTIVE_TIMEOUT_MS = 600_000;

/** What an `exec` printed and how it ended. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface ExecOptions {
  /** Bytes on the program's stdin; with `argv`, at most 16,384 bytes. */
  readonly stdin?: Buffer | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs: number;
}

/** One HTTP failure from Revyl, with the path's ids masked. */
class RevylHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Revyl ${path} answered ${status}: ${detail}`);
    this.name = 'RevylHttpError';
  }
}

export class RevylComputerClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;

  /** Refuses an API URL that would carry the key in the clear: `https`, or plain `http` to this machine only, as Revyl's own plugin allows. */
  constructor(credentials: RevylCredentials) {
    const apiUrl = (credentials.apiUrl ?? DEFAULT_API_URL).replace(/[/]+$/, '');
    let url: URL;
    try {
      url = new URL(apiUrl);
    } catch {
      throw new Error('REVYL_API_URL is not a URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('REVYL_API_URL must use https; plain http is allowed only to localhost');
    }
    this.#apiUrl = apiUrl;
    this.#apiKey = credentials.apiKey;
  }

  /** Creates a Mac under the id the caller picked, deleted when it stops; Revyl stops it after `lifetimeSeconds` at the latest. */
  async create(id: string, lifetimeSeconds: number, signal: AbortSignal): Promise<void> {
    await this.#retry(signal, () => this.#json('POST', '/api/v1/computer-runs', { computer_session_id: id, os: 'macos', persistent: false, timeout_seconds: lifetimeSeconds }, signal));
  }

  /** Starts a stopped persistent computer again, from its saved disk. */
  async start(id: string, lifetimeSeconds: number, signal: AbortSignal): Promise<void> {
    await this.#retry(signal, () => this.#json('POST', `/api/v1/computer-runs/${encodeURIComponent(id)}/start`, { timeout_seconds: lifetimeSeconds }, signal));
  }

  /** The computer's state as Revyl reports it: `starting`, `active`, `stopped`, and so on. */
  async state(id: string, signal: AbortSignal): Promise<string> {
    const { state } = await this.#report(id, signal);
    if (state === undefined) throw new Error(`Revyl reports no state for computer ${id}`);
    return state;
  }

  /** Waits until the computer runs; one that failed or stopped instead, or is not active within 10 minutes, fails with Revyl's reason or its last state. */
  async waitUntilActive(id: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + ACTIVE_TIMEOUT_MS;
    for (;;) {
      const { state, failureReason } = await this.#report(id, signal);
      if (state === 'active') return;
      if (state !== undefined && ENDED.has(state)) throw new Error(`Revyl computer ${id} is ${state}${failureReason === undefined ? '' : `: ${failureReason}`}`);
      if (Date.now() >= deadline) throw new Error(`Revyl computer ${id} was not active within ${ACTIVE_TIMEOUT_MS / 60_000} minutes; its last state was ${state ?? 'not reported'}`);
      await sleep(2_000, signal);
    }
  }

  /**
   * The computer's state, and the reason its latest run failed. A persistent
   * computer's state is its own, `running` read as `active`: the run report
   * beside it describes its latest run, which stays `failed` or `stopped`
   * after the computer stopped.
   */
  async #report(id: string, signal: AbortSignal): Promise<{ readonly state: string | undefined; readonly failureReason: string | undefined }> {
    const report = fields(await this.#retry(signal, () => this.#json('GET', `/api/v1/computer-runs/${encodeURIComponent(id)}`, undefined, signal)));
    const persistent = fields(report.persistent).state;
    const state = typeof persistent === 'string' ? (persistent === 'running' ? 'active' : persistent) : report.state;
    return { state: typeof state === 'string' ? state : undefined, failureReason: typeof report.failure_reason === 'string' ? report.failure_reason : undefined };
  }

  /**
   * Stops the computer, again after a gateway error or a dropped connection
   * since a stop is idempotent. One Revyl no longer has (404) or already
   * stopped (409) counts as stopped.
   */
  async stop(id: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#retry(signal, () => this.#json('POST', `/api/v1/computer-runs/${encodeURIComponent(id)}/stop`, undefined, signal, STOP_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof RevylHttpError && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }

  /** Runs `argv` on the computer, as its `computer` user, and resolves with its exit code and output whatever the code. */
  async exec(id: string, argv: readonly string[], options: ExecOptions, signal: AbortSignal): Promise<ExecResult> {
    const command = {
      kind: 'exec',
      argv_b64: argv.map(base64),
      timeout_ms: options.timeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin.toString('base64') }),
      ...(options.env === undefined ? {} : { env_b64: Object.fromEntries(Object.entries(options.env).map(([name, value]) => [name, base64(value)])) }),
    };
    const execution = await this.#operation(id, command, options.timeoutMs, signal);
    const result = fields(execution.result);
    if (typeof result.exit_code !== 'number' || (execution.outcome !== 'succeeded' && execution.error_code !== 'exec_nonzero')) {
      throw new Error(`${argv[0] ?? 'exec'} on Revyl computer ${id} ended ${String(execution.outcome)}${typeof execution.error_code === 'string' ? ` (${execution.error_code})` : ''}`);
    }
    return { exitCode: result.exit_code, stdout: decode(result.stdout), stderr: decode(result.stderr) };
  }

  /** Writes a file of at most 64 KiB, its path relative to the computer's workspace. */
  async writeFile(id: string, file: string, data: Buffer, signal: AbortSignal): Promise<void> {
    const execution = await this.#operation(id, { kind: 'file_write', path_b64: base64(file), data: data.toString('base64') }, 60_000, signal);
    if (execution.outcome !== 'succeeded') {
      throw new Error(`writing ${file} on Revyl computer ${id} ended ${String(execution.outcome)}${typeof execution.error_code === 'string' ? ` (${execution.error_code})` : ''}`);
    }
  }

  /**
   * Submits an operation and reads its result. The request id makes the
   * submit idempotent, so a submit that met a gateway error or a dropped
   * connection is sent again under the same id and runs once.
   */
  async #operation(id: string, command: object, timeoutMs: number, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    const requestId = randomUUID();
    const path = `/api/v1/computer-runs/${encodeURIComponent(id)}/operations`;
    let answer = fields(await this.#retry(signal, () => this.#json('POST', path, { computer_session_id: id, request_id: requestId, command }, signal, CONTROL_TIMEOUT_MS, { Prefer: 'respond-async' })));
    const operationId = typeof answer.operation_id === 'string' ? answer.operation_id : operationIdFor(id, requestId);
    const deadline = Date.now() + timeoutMs + CONTROL_TIMEOUT_MS;
    for (let polls = 0; answer.execution === undefined || answer.evidence === 'pending'; polls += 1) {
      if (Date.now() > deadline) throw new Error(`Revyl computer ${id} did not finish an operation within ${timeoutMs} ms`);
      await sleep(polls < 20 ? 150 : 500, signal);
      answer = fields(await this.#retry(signal, () => this.#json('GET', `${path}/${operationId}`, undefined, signal).catch((error: unknown) => {
        // The operation is recorded a moment after a 202; until then it reads as not found.
        if (error instanceof RevylHttpError && error.status === 404 && polls < 20) return {};
        throw error;
      })));
    }
    return fields(answer.execution);
  }

  /** Runs a call again after a rate limit, a gateway error, or a dropped connection, none of which reached Revyl. */
  async #retry<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const transient = error instanceof RevylHttpError ? error.status === 429 || (error.status >= 502 && error.status <= 504) : error instanceof TypeError;
        if (!transient || signal.aborted || attempt >= ATTEMPTS) throw error;
      }
      await sleep(500 * attempt, signal);
    }
  }

  async #json(method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs = CONTROL_TIMEOUT_MS, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': USER_AGENT,
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) throw new RevylHttpError(response.status, path.replace(/[0-9a-f-]{36}/g, ':id'), errorDetail(text));
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }
}

/** The operation id Revyl derives from a request id: a version 5 UUID of the request id in the computer's namespace. */
function operationIdFor(computerId: string, requestId: string): string {
  const hash = createHash('sha1').update(Buffer.from(computerId.replaceAll('-', ''), 'hex')).update(requestId).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Text as the padded URL-safe base64 Revyl takes for command text, so the edge never reads it as a shell line. */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
}

function decode(value: unknown): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0);
}

/** A JSON object's fields, or none for any other answer. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The `detail` or `message` of an API error, or the start of the body. */
function errorDetail(body: string): string {
  try {
    const parsed = fields(JSON.parse(body));
    const detail = parsed.detail ?? parsed.message;
    if (detail !== undefined) return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300);
  } catch {
    // An edge error page, not JSON.
  }
  if (/^\s*</.test(body)) return "an HTML error page from Revyl's edge";
  return body.slice(0, 300).trim();
}

/** Waits `ms`, ending early with the signal's own reason when it aborts. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error;
  });
}
