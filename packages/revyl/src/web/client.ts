/**
 * Revyl's HTTP API for one hosted web session: registering the start URL,
 * starting and stopping the session, and the device proxy that forwards
 * actions and reads to the session's browser. Every call carries the run's
 * API key and is bounded by its caller's budget.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { EngineError } from '@e2e-dev/core/engine';
import type { RevylCredentials } from '../credentials.ts';
import type { MaestroNode } from './tree.ts';

const DEFAULT_API_URL = 'https://backend.revyl.ai';
const APP_URL = 'https://app.revyl.ai';
/** Revyl's backend gives up on a proxied worker call after 26 s. */
const PROXY_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 60_000;
const READ_ATTEMPTS = 3;
const TERMINAL_STATUSES = new Set(['failed', 'completed', 'cancelled', 'timeout', 'stopping']);

export interface WebViewport {
  readonly width: number;
  readonly height: number;
}

export interface StartedSession {
  readonly sessionId: string;
  readonly workflowRunId: string;
  readonly viewerUrl: string;
}

/** The Maestro web geometry: `grid` is the CSS viewport, `pixels` the screenshot. */
export interface MaestroWebInfo {
  readonly width_pixels: number;
  readonly height_pixels: number;
  readonly width_grid: number;
  readonly height_grid: number;
}

export interface RuntimeTab {
  readonly tab_id: string;
  readonly active: boolean;
  readonly url_origin: string;
  readonly route_pattern: string;
  readonly url_path?: string | null;
}

interface ActionResponse {
  readonly success?: boolean;
  readonly error?: string | null;
  readonly execution_uncertain?: boolean;
  readonly input_dispatched?: boolean;
}

/** One HTTP failure from Revyl, with the path's ids masked. */
export class RevylHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Revyl ${path} answered ${status}: ${detail}`);
    this.name = 'RevylHttpError';
  }
}

export class RevylWebClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #userAgent: string;

  constructor(credentials: RevylCredentials, version: string) {
    this.#apiUrl = (credentials.apiUrl ?? DEFAULT_API_URL).replace(/[/]+$/, '');
    this.#apiKey = credentials.apiKey;
    // Revyl's edge refuses requests without a client user agent.
    this.#userAgent = `e2e-revyl-web/${version}`;
  }

  async registerUrlBuild(appId: string, url: string, signal: AbortSignal): Promise<string> {
    const build = await this.#json<{ id?: unknown }>('POST', `/api/v1/apps/${encodeURIComponent(appId)}/builds/external`, { url }, signal, CONTROL_TIMEOUT_MS);
    if (typeof build.id !== 'string') throw new Error('Revyl did not return a build id for the start URL');
    return build.id;
  }

  /** Starts a session and waits until its browser takes actions. A failed start leaves the session to the caller, which stops it at dispose. */
  async startSession(
    request: { sessionId: string; appId: string; buildId: string; viewport: WebViewport; idleTimeoutSeconds: number },
    signal: AbortSignal,
  ): Promise<StartedSession> {
    // The caller picks the id and stops that session at dispose, so a start
    // that fails at any point, a timeout after Revyl accepted it included,
    // leaves no session running.
    const { sessionId } = request;

    const started = await this.#json<{ session_id?: unknown; workflow_run_id?: unknown; error?: unknown }>(
      'POST',
      '/api/v1/execution/start_device',
      {
        platform: 'web',
        app_id: request.appId,
        build_id: request.buildId,
        session_id: sessionId,
        idle_timeout_seconds: request.idleTimeoutSeconds,
        web: { viewport: request.viewport },
      },
      signal,
      CONTROL_TIMEOUT_MS,
    );
    if (typeof started.workflow_run_id !== 'string' || started.session_id !== sessionId) {
      throw new Error(`Revyl refused the web session: ${typeof started.error === 'string' ? started.error : 'no session in the response'}`);
    }
    const workflowRunId = await this.#waitUntilRunning(sessionId, signal);
    return { sessionId, workflowRunId, viewerUrl: `${APP_URL}/sessions/${sessionId}` };
  }

  /** Stops a session. A stop is idempotent, so it is sent again after a gateway error or a dropped connection. */
  async stopSession(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.#read(signal, () => this.#json('POST', `/api/v1/execution/device/sessions/${encodeURIComponent(sessionId)}/stop`, undefined, signal, CONTROL_TIMEOUT_MS));
  }

  hierarchy(workflowRunId: string, signal: AbortSignal): Promise<MaestroNode> {
    return this.#read(signal, () => this.#json('GET', this.#proxy(workflowRunId, 'maestro_web_hierarchy'), undefined, signal, PROXY_TIMEOUT_MS));
  }

  async query(workflowRunId: string, css: string, signal: AbortSignal): Promise<readonly MaestroNode[]> {
    const result = await this.#read(signal, () => this.#json<{ nodes: MaestroNode[] }>('POST', this.#proxy(workflowRunId, 'maestro_web_query'), { css }, signal, PROXY_TIMEOUT_MS));
    return result.nodes;
  }

  info(workflowRunId: string, signal: AbortSignal): Promise<MaestroWebInfo> {
    return this.#read(signal, () => this.#json('GET', this.#proxy(workflowRunId, 'maestro_web_info'), undefined, signal, PROXY_TIMEOUT_MS));
  }

  tabs(workflowRunId: string, signal: AbortSignal): Promise<readonly RuntimeTab[]> {
    return this.#read(signal, () => this.#json('GET', this.#proxy(workflowRunId, 'tabs'), undefined, signal, PROXY_TIMEOUT_MS));
  }

  screenshot(workflowRunId: string, signal: AbortSignal): Promise<Uint8Array> {
    return this.#read(signal, async () => {
      const response = await this.#fetch('GET', this.#proxy(workflowRunId, 'screenshot'), undefined, signal, PROXY_TIMEOUT_MS);
      return new Uint8Array(await response.arrayBuffer());
    });
  }

  /**
   * Sends one mutating action. A transport failure, a 5xx, a deadline that
   * ends it in flight, an empty answer, or an answer that says input was
   * dispatched is `ACTION_MAY_HAVE_COMMITTED`, so the runner never repeats it
   * blindly. For a `sensitive` action (a secret fill) no message carries
   * Revyl's own words and no error keeps the response as its cause, since
   * Revyl may echo the request back.
   */
  async act(workflowRunId: string, action: string, body: object | undefined, signal: AbortSignal, sensitive = false): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const said = (text: string): string => (sensitive ? 'details withheld from a sensitive fill' : text);
    const options = (cause?: unknown): { retryable: false; cause?: unknown } => ({ retryable: false, ...(sensitive || cause === undefined ? {} : { cause }) });
    let result: ActionResponse | undefined;
    try {
      result = await this.#beforeDispatch(signal, () => this.#json<ActionResponse | undefined>('POST', this.#proxy(workflowRunId, action), body ?? {}, signal, PROXY_TIMEOUT_MS));
    } catch (error) {
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        if (!(reason instanceof EngineError && reason.code === 'OPERATION_TIMEOUT')) throw reason;
        throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `Revyl ${action} was still running at the deadline; the page may have received it`, options(reason));
      }
      if (error instanceof RevylHttpError && [401, 403, 404, 409, 429].includes(error.status)) {
        // The key, the session, or the worker's hold on it is gone (a revoked
        // key, an ended or stopping session, a crashed worker), or Revyl kept
        // limiting the rate past the retries. The page did nothing wrong, and
        // the worker needs a new session, which a test failure would not give it.
        throw new EngineError('ENGINE_FAILURE', `Revyl refused ${action} for the session: ${said(error.detail)}`, options(error));
      }
      if (error instanceof RevylHttpError && error.status < 500) throw new EngineError('NOT_ACTIONABLE', `Revyl ${action}: ${said(error.detail)}`, options(error));
      const reason = error instanceof Error ? error.message : String(error);
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `Revyl ${action} failed in transit; the page may have received it (${said(reason)})`, options(error));
    }
    if (result === undefined || typeof result !== 'object') {
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `Revyl ${action} answered with no result; the page may have received it`, options());
    }
    if (result.success === true && result.execution_uncertain !== true) return;
    if (result.execution_uncertain === true || result.input_dispatched === true) {
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `Revyl ${action} did not confirm it finished (${said(result.error ?? 'uncertain')})`, options());
    }
    throw new EngineError('NOT_ACTIONABLE', `Revyl ${action} failed: ${said(result.error ?? 'no reason given')}`, options());
  }

  async #waitUntilRunning(sessionId: string, signal: AbortSignal): Promise<string> {
    const started = Date.now();
    for (;;) {
      const detail = await this.#read(signal, () =>
        this.#json<{ status?: unknown; workflow_run_id?: unknown; viewer_kind?: unknown; error_message?: unknown }>(
          'GET',
          `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`,
          undefined,
          signal,
          CONTROL_TIMEOUT_MS,
        ),
      );
      if (typeof detail.status === 'string' && TERMINAL_STATUSES.has(detail.status)) {
        const reason = typeof detail.error_message === 'string' ? detail.error_message : detail.status;
        throw new Error(`Revyl web session ${sessionId} ended before it was ready: ${reason}`);
      }
      if (detail.status === 'running' && typeof detail.workflow_run_id === 'string' && detail.viewer_kind === 'whep') {
        return detail.workflow_run_id;
      }
      await sleep(Date.now() - started < 60_000 ? 500 : 2_000, signal);
    }
  }

  /**
   * Runs a read that changes nothing on the page, again after a rate limit, a
   * gateway error, or a dropped connection: Revyl's proxy answers 429 and 502
   * to 504 without reaching the worker, and a read is safe to repeat.
   */
  async #read<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        const transient = error instanceof RevylHttpError ? error.status === 429 || (error.status >= 502 && error.status <= 504) : error instanceof TypeError;
        if (!transient || signal.aborted || attempt >= READ_ATTEMPTS) throw error;
      }
      await sleep(500 * attempt, signal);
    }
  }

  /**
   * Sends an action again when Revyl's proxy refused it before forwarding it
   * to the worker: it answers 429 when rate limited and 503 while it looks
   * the worker up, and an action it never forwarded never ran.
   */
  async #beforeDispatch<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        const unsent =
          error instanceof RevylHttpError && (error.status === 429 || (error.status === 503 && /worker (lookup|registration) is unavailable/i.test(error.detail)));
        if (!unsent || signal.aborted || attempt >= READ_ATTEMPTS) throw error;
      }
      await sleep(500 * attempt, signal);
    }
  }

  #proxy(workflowRunId: string, action: string): string {
    return `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}/${action}`;
  }

  async #json<T>(method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<T> {
    const response = await this.#fetch(method, path, body, signal, timeoutMs);
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  async #fetch(method: string, path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Response> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': this.#userAgent,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
      throw new RevylHttpError(response.status, path.replace(/[0-9a-f-]{36}/g, ':id'), errorDetail(await response.text()));
    }
    return response;
  }
}

/** The `detail` of a FastAPI error, or the start of the body. */
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'detail' in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      return typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300);
    }
  } catch {
    // An edge error page, not JSON.
  }
  if (/^\s*</.test(body)) return 'an HTML error page from Revyl\'s edge';
  return body.slice(0, 300).trim();
}

/** Waits `ms`, ending early with the signal's own reason when it aborts. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error;
  });
}
