/**
 * Revyl's HTTP API for the devices `revyl()` leases: the catalog of models
 * and OS versions a device can start on, and the screen recording of a
 * running device through its session's device proxy. Every call carries the
 * run's API key and is bounded by its caller's signal.
 */

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { RevylCredentials } from './credentials.ts';
import { DEFAULT_API_URL } from './web/client.ts';

/** Revyl's backend gives up on a proxied worker call after 30 s. */
const REQUEST_TIMEOUT_MS = 35_000;
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
    const listed = fields(fields(fields(await json(await this.#request('GET', '/api/v1/execution/device-targets', undefined, signal), 'device-targets')).platforms)[platform]);
    const models = Array.isArray(listed.available_models) ? listed.available_models.filter((model): model is string => typeof model === 'string') : [];
    const runtimes = Object.fromEntries(
      Object.entries(fields(listed.compatible_runtimes)).map(([model, versions]) => [model, Array.isArray(versions) ? versions.filter((version): version is string => typeof version === 'string') : []]),
    );
    return { models, runtimes };
  }

  /**
   * Starts the worker's screen recording of session `sessionId`'s device.
   * The worker keeps one recording per session, and caps it at 3 minutes and
   * 40 MiB.
   */
  async startRecording(sessionId: string, signal: AbortSignal): Promise<DeviceRecording> {
    const session = await json(await this.#request('GET', `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, undefined, signal), 'device session');
    const workflowRunId = session.workflow_run_id;
    if (typeof workflowRunId !== 'string' || workflowRunId === '') throw new Error(`Revyl reports no running device for session ${sessionId}`);
    const started = action(await json(await this.#request('POST', `${proxy(workflowRunId)}/start_screen_recording`, {}, signal), 'start_screen_recording'), 'start_screen_recording');
    if (typeof started.recording_id !== 'string' || started.recording_id === '') throw new Error('Revyl started a recording without naming it');
    return { workflowRunId, recordingId: started.recording_id };
  }

  /**
   * Stops a recording and writes the MP4 the worker answers with to `file`.
   * Sent once: the worker hands the video back only to the call that stops it.
   */
  async stopRecording({ workflowRunId, recordingId }: DeviceRecording, file: string, signal: AbortSignal): Promise<void> {
    const response = await this.#request('POST', `${proxy(workflowRunId)}/stop_screen_recording`, { recording_id: recordingId }, signal);
    if (response.ok && response.headers.get('content-type')?.startsWith('video/') === true) {
      await writeFile(file, new Uint8Array(await response.arrayBuffer()), { signal });
      return;
    }
    action(await json(response, 'stop_screen_recording'), 'stop_screen_recording');
    throw new Error('Revyl stopped the recording without returning a video');
  }

  #request(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.#apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  }
}

/** The device proxy path of a session's worker, by the session's workflow run. */
function proxy(workflowRunId: string): string {
  return `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}`;
}

/** A response's JSON object; a failed status or any other body throws, naming `what`. */
async function json(response: Response, what: string): Promise<Readonly<Record<string, unknown>>> {
  const text = await response.text();
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
