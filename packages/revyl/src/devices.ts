/**
 * Revyl's HTTP API for the devices `revyl()` leases: the catalog of models
 * and OS versions a device can start on, and the screen recording of a
 * running device through its session's device proxy. Every call carries the
 * run's API key and is bounded by its caller's signal.
 */

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReadableStream } from 'node:stream/web';
import type { RevylCredentials } from './credentials.ts';
import { DEFAULT_API_URL } from './web/client.ts';

/** Revyl's backend gives up on a proxied worker call after 30 s. */
const REQUEST_TIMEOUT_MS = 35_000;
/** A stop finalizes and streams the whole MP4, which Revyl's own CLI allows 5 minutes for. */
const STOP_TIMEOUT_MS = 300_000;
const READ_ATTEMPTS = 3;
const STOP_ATTEMPTS = 3;
/** Session states Revyl never brings back to a running device. */
const ENDED_STATUSES = new Set(['failed', 'completed', 'cancelled', 'timeout', 'stopping']);
// Revyl's edge refuses requests without a client user agent.
const USER_AGENT = `e2e-revyl/${(createRequire(import.meta.url)('../package.json') as { version: string }).version}`;

/** The models Revyl starts for one platform, and the OS versions each runs. */
export interface DeviceCatalog {
  readonly models: readonly string[];
  readonly runtimes: Readonly<Record<string, readonly string[]>>;
}

/** A screen recording the session's worker is making, as `startRecording` started it. */
export interface DeviceRecording {
  readonly workflowRunId: string;
  readonly recordingId: string;
  /** When the start was asked for, as an ISO timestamp: the recording's first frame is at or just after it. */
  readonly startedAt: string;
}

export class RevylDeviceClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;

  constructor(credentials: RevylCredentials) {
    this.#apiUrl = (credentials.apiUrl ?? DEFAULT_API_URL).replace(/[/]+$/, '');
    this.#apiKey = credentials.apiKey;
  }

  /** The models Revyl lists for `platform`, and the OS versions each one runs. */
  async catalog(platform: string, signal: AbortSignal): Promise<DeviceCatalog> {
    const listed = fields(fields(fields(await this.#read('/api/v1/execution/device-targets', 'device-targets', signal)).platforms)[platform]);
    const models = Array.isArray(listed.available_models) ? listed.available_models.filter((model): model is string => typeof model === 'string') : [];
    const runtimes = Object.fromEntries(
      Object.entries(fields(listed.compatible_runtimes)).map(([model, versions]) => [model, Array.isArray(versions) ? versions.filter((version): version is string => typeof version === 'string') : []]),
    );
    return { models, runtimes };
  }

  /**
   * Starts the worker's screen recording of session `sessionId`'s device.
   * The worker keeps one recording per session, and stops it at 3 minutes or
   * at its size cap.
   */
  async startRecording(sessionId: string, signal: AbortSignal): Promise<DeviceRecording> {
    const session = await this.#read(`/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, 'device session', signal);
    const workflowRunId = session.workflow_run_id;
    if (typeof workflowRunId !== 'string' || workflowRunId === '' || (typeof session.status === 'string' && ENDED_STATUSES.has(session.status))) {
      throw new Error(`Revyl reports no running device for session ${sessionId}`);
    }
    const startedAt = new Date().toISOString();
    const started = action(await json(await this.#request('POST', `${proxy(workflowRunId)}/start_screen_recording`, {}, signal), 'start_screen_recording'), 'start_screen_recording');
    if (typeof started.recording_id !== 'string' || started.recording_id === '') throw new Error('Revyl started a recording without naming it');
    return { workflowRunId, recordingId: started.recording_id, startedAt };
  }

  /**
   * Stops a recording and streams the MP4 the worker answers with to `file`.
   * A stop is asked again after a dropped connection, a gateway error, a
   * broken download, or a worker that kept the recording to be stopped
   * again: the worker answers a repeated stop of the same recording with the
   * same video while the session lasts. A recording the worker no longer
   * holds fails for good.
   */
  async stopRecording(recording: DeviceRecording, file: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const failure = await this.#stop(recording, file, signal);
      if (failure === undefined) return;
      if (signal.aborted || attempt >= STOP_ATTEMPTS) throw failure;
      await delay(500 * attempt, undefined, { signal });
    }
  }

  /** One stop: nothing once the video is in `file`, the error of a failure another stop can get past, and a throw for any other. */
  async #stop({ workflowRunId, recordingId }: DeviceRecording, file: string, signal: AbortSignal): Promise<Error | undefined> {
    let response: Response;
    try {
      response = await this.#request('POST', `${proxy(workflowRunId)}/stop_screen_recording`, { recording_id: recordingId }, signal, STOP_TIMEOUT_MS);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (response.ok && response.body !== null && response.headers.get('content-type')?.startsWith('video/') === true) {
      try {
        await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(file), { signal });
        return undefined;
      } catch (error) {
        await rm(file, { force: true });
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    if (response.status === 429 || (response.status >= 502 && response.status <= 504)) {
      const text = await response.text().catch(() => '');
      return new Error(`Revyl stop_screen_recording answered ${response.status}: ${text.slice(0, 300).trim()}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const body = parse(response, text, 'stop_screen_recording');
    if (body.success !== false) throw new Error('Revyl stopped the recording without returning a video');
    const reason = typeof body.error === 'string' ? body.error : 'no reason given';
    if (reason.includes('recording retained')) return new Error(`Revyl refused stop_screen_recording: ${reason}`);
    if (reason.includes('No active screen recording')) {
      throw new Error(`Revyl no longer holds recording ${recordingId}, so it has no video to return: ${reason}`);
    }
    throw new Error(`Revyl refused stop_screen_recording: ${reason}`);
  }

  /** A GET's JSON object, asked again after a rate limit, a gateway error, or a connection dropped before or during the answer, none of which change anything. */
  async #read(path: string, what: string, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    const dropped = (attempt: number) => (error: unknown) => {
      if (!(error instanceof TypeError) || signal.aborted || attempt >= READ_ATTEMPTS) throw error;
      return undefined;
    };
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.#request('GET', path, undefined, signal).catch(dropped(attempt));
      const transient = response === undefined || response.status === 429 || (response.status >= 502 && response.status <= 504);
      if (response !== undefined && (!transient || attempt >= READ_ATTEMPTS)) {
        const text = await response.text().catch(dropped(attempt));
        if (text !== undefined) return parse(response, text, what);
      }
      await delay(500 * attempt, undefined, { signal });
    }
  }

  #request(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    return fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  }
}

/** The device proxy path of a session's worker, by the session's workflow run. */
function proxy(workflowRunId: string): string {
  return `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}`;
}

/** A response's JSON object; a failed status or any other body throws, naming `what`. */
async function json(response: Response, what: string): Promise<Readonly<Record<string, unknown>>> {
  return parse(response, await response.text(), what);
}

/** The JSON object in `text`, the body `response` answered with; a failed status or any other body throws, naming `what`. */
function parse(response: Response, text: string, what: string): Readonly<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Revyl ${what} answered ${response.status}: ${text.slice(0, 300).trim()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`Revyl ${what} answered with no JSON object`);
  return parsed as Record<string, unknown>;
}

/** A worker action's body; the worker reports a refusal inside a 200. */
function action(body: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  if (body.success === false) throw new Error(`Revyl refused ${name}: ${typeof body.error === 'string' ? body.error : 'no reason given'}`);
  return body;
}

/** A JSON object's fields, or none for any other value. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
