/**
 * `revyl()` against a stubbed `@e2e-dev/mobile/lease` and a stubbed Revyl
 * API: the options it refuses, the device catalog it checks, the selectors,
 * credentials, and plugin home it leases with, and the worker's recording
 * it records an attempt with. The lease lifecycle is `@e2e-dev/mobile`'s,
 * tested there.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import type { AgentDeviceLeaseOptions, AgentDeviceLeaseRequest } from '@e2e-dev/mobile/lease';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revyl, type RevylOptions } from '../../src/index.ts';

const mocks = vi.hoisted(() => ({
  version: vi.fn(),
  install: vi.fn(async (_home: string) => {}),
  leases: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock('@e2e-dev/mobile/lease', () => ({
  agentDevicePlugin: () => ({ assertVersion: mocks.version, prepareHome: mocks.install }),
  agentDeviceLeases: (options: AgentDeviceLeaseOptions) => {
    mocks.leases(options);
    return { acquire: mocks.acquire, release: mocks.release };
  },
}));

// The session id the plugin starts a lease's device under; the plugin ships no types.
const { revylSessionIdForLease } = (await import(import.meta.resolve('@agent-device/revyl'))) as { revylSessionIdForLease: (leaseId: string) => string };

const ROOT = '/project';
const env = { REVYL_API_KEY: 'revyl-key', PATH: '/bin' };
const options: RevylOptions = { app: 'https://builds.example.com/app.apk', device: 'Pixel 7' };

const CATALOG = {
  platforms: {
    android: { available_models: ['Pixel 7', 'Pixel Tablet'], compatible_runtimes: { 'Pixel 7': ['Android 14'], 'Pixel Tablet': ['Android 14'] } },
    ios: { available_models: ['iPhone 17 Pro Max', 'iPhone 16'], compatible_runtimes: { 'iPhone 17 Pro Max': ['iOS 27.0', 'iOS 26.5'], 'iPhone 16': ['iOS 27.0'] } },
  },
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

let calls: Call[] = [];
let routes: Record<string, (call: Call) => Response> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  routes = { 'GET /api/v1/execution/device-targets': () => json(CATALOG) };
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = { method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(call);
    const pathname = new URL(url).pathname;
    const route = Object.entries(routes).find(([key]) => `${call.method} ${pathname}`.startsWith(key));
    if (route === undefined) throw new Error(`no route for ${call.method} ${pathname}`);
    return route[1](call);
  });
  let leases = 0;
  mocks.acquire.mockImplementation(async (_request: DeviceRequest, { selectors }: AgentDeviceLeaseRequest): Promise<DeviceLease> => ({ id: `lease-${++leases}`, client: { ...selectors } }));
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    agentDeviceVersion: '0.21.37',
    projectRoot: ROOT,
    env,
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, log: () => undefined };

const leased = (call = 0) => mocks.acquire.mock.calls[call]![1] as AgentDeviceLeaseRequest;

describe('revyl()', () => {
  it("is a device provider named revyl that leases through agent-device's revyl plugin", () => {
    const provider = revyl(options);
    expect(provider.name).toBe('revyl');
    expect(mocks.leases).toHaveBeenCalledWith({ provider: 'revyl', label: 'Revyl' });
  });

  it("checks the plugin against the engine's agent-device before anything starts", async () => {
    mocks.version.mockImplementationOnce(() => {
      throw new Error('@agent-device/revyl 0.21.37 is installed, but @e2e-dev/mobile runs agent-device 0.21.42. Install matching versions.');
    });
    await expect(revyl(options).acquire(request({ agentDeviceVersion: '0.21.42' }))).rejects.toThrow(/Install matching versions/);
    expect(mocks.version).toHaveBeenCalledWith('0.21.42');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("leases with the device and app selectors, the run's API key, the plugin in the daemon's home, and a summary", async () => {
    const provider = revyl(options);
    const req = request();
    const lease = await provider.acquire(req);
    expect(mocks.acquire).toHaveBeenCalledWith(req, expect.anything());
    expect(leased()).toEqual({
      env: { REVYL_API_KEY: 'revyl-key' },
      summary: 'Pixel 7, android; Revyl device started',
      prepareHome: mocks.install,
      selectors: { device: 'Pixel 7', providerApp: 'https://builds.example.com/app.apk' },
      installAppPath: true,
    });
    await provider.release(lease, context);
    expect(mocks.release).toHaveBeenCalledWith(lease, context);
  });

  it('leases an iOS device with its OS version, and passes a REVYL_API_URL override to the daemon', async () => {
    await revyl({ app: 'https://builds.example.com/App.zip', device: 'iPhone 17 Pro Max', osVersion: 'iOS 27.0' }).acquire(
      request({ platform: 'ios', env: { ...env, REVYL_API_URL: ' https://backend-staging.revyl.ai ' } }),
    );
    expect(leased()).toMatchObject({
      env: { REVYL_API_KEY: 'revyl-key', REVYL_API_URL: 'https://backend-staging.revyl.ai' },
      summary: 'iPhone 17 Pro Max, iOS 27.0; Revyl device started',
      selectors: { device: 'iPhone 17 Pro Max', providerApp: 'https://builds.example.com/App.zip', providerOsVersion: 'iOS 27.0' },
    });
  });

  it.each([{}, { REVYL_API_KEY: '  ' }])("leases nothing without REVYL_API_KEY in the run's environment (%j)", async (runEnv) => {
    await expect(revyl(options).acquire(request({ env: runEnv }))).rejects.toThrow('REVYL_API_KEY is not set; set it to a Revyl API key in the environment `e2e run` starts in');
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("refuses the target's app.appPath beside `app`, since Revyl installs `app`", async () => {
    await expect(revyl(options).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }))).rejects.toThrow("Revyl installs the app from `app`; leave the target's `app.appPath` out, or leave `app` out to install that build instead");
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("without `app`, starts the device with no app and has the lease install the target's app.appPath", async () => {
    await revyl({ device: 'Pixel 7' }).acquire(request({ appPath: join(ROOT, 'build', 'app.apk') }));
    expect(leased().selectors).toEqual({ device: 'Pixel 7' });
    expect(leased().installAppPath).toBe(true);
  });

  it('rejects an option it does not take with INVALID_CONFIG, naming the nearest one', () => {
    expect(() => revyl({ ...options, osVerison: '14' } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('osVersion') }));
    expect(() => revyl({ ...options, deviceType: 'real' } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('requires `device` with INVALID_CONFIG', () => {
    expect(() => revyl({ ...options, device: ' ' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'revyl: `device` is required, as a non-empty string' }));
    const { device: _, ...rest } = options;
    expect(() => revyl(rest as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it.each([' ', 14, null])('refuses an empty or non-string `osVersion` with INVALID_CONFIG (%j)', (osVersion) => {
    expect(() => revyl({ ...options, osVersion } as unknown as RevylOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'revyl: `osVersion` must be a non-empty string' }));
  });

  it.each(['build/app.apk', '/builds/app.apk', 'http://builds.example.com/app.apk', 'https://user:pass@builds.example.com/app.apk', 'lt://APP123', ' ', 14])(
    'refuses an app Revyl cannot download over https (%s)',
    (app) => {
      expect(() => revyl({ ...options, app } as unknown as RevylOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: 'revyl: `app` must be an https URL, without credentials, that Revyl can download the build from' }),
      );
    },
  );
  describe('device check', () => {
    it("refuses a model Revyl does not list for the platform, naming the ones it does, before a device is allocated", async () => {
      await expect(revyl({ ...options, device: 'iPhone 16 Pro Max' }).acquire(request({ platform: 'ios' }))).rejects.toThrow(
        'Revyl has no ios device "iPhone 16 Pro Max"; set `device` to one of: iPhone 17 Pro Max, iPhone 16',
      );
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://backend.revyl.ai/api/v1/execution/device-targets' });
      expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer revyl-key' });
    });

    it('refuses an OS version Revyl does not run the model on, naming the ones it does', async () => {
      await expect(revyl({ ...options, device: 'iPhone 16', osVersion: 'iOS 18.5' }).acquire(request({ platform: 'ios' }))).rejects.toThrow(
        'Revyl runs "iPhone 16" on iOS 27.0, not "iOS 18.5"; set `osVersion` to one of those, or leave it out for Revyl\'s default',
      );
      expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it("asks the run's REVYL_API_URL, and leaves the check to the allocation when Revyl does not answer it", async () => {
      routes['GET /api/v1/execution/device-targets'] = () => json({ detail: 'down' }, 503);
      await revyl(options).acquire(request({ env: { ...env, REVYL_API_URL: 'https://backend-staging.revyl.ai' } }));
      expect(calls[0]!.url).toBe('https://backend-staging.revyl.ai/api/v1/execution/device-targets');
      expect(mocks.acquire).toHaveBeenCalledTimes(1);
    });
  });

  describe('record', () => {
    const lease: DeviceLease = { id: 'lease-1' };
    const sessionId = revylSessionIdForLease('lease-1');
    const recordContext = { runId: 'run-1', targetName: 'android', attemptId: 'attempt-1', env, signal: new AbortController().signal };
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'revyl-record-'));
      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = () => json({ session_id: sessionId, workflow_run_id: 'run-9', status: 'running' });
      routes['POST /api/v1/execution/device-proxy/run-9/start_screen_recording'] = () => json({ success: true, recording_id: 'rec-1' });
      routes['POST /api/v1/execution/device-proxy/run-9/stop_screen_recording'] = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("records with the worker's screen recording of the session the plugin started for the lease, and writes the MP4 it stops with", async () => {
      let lookedUp = 0;
      const running = routes[`GET /api/v1/execution/device-sessions/${sessionId}`]!;
      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = (call) => {
        lookedUp = Date.now();
        return running(call);
      };
      const recording = await revyl(options).record!(lease, recordContext);
      // Timed from the start request, not from before the session lookup.
      expect(Date.parse(recording.startedAt)).toBeGreaterThanOrEqual(lookedUp);
      expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        `GET /api/v1/execution/device-sessions/${sessionId}`,
        'POST /api/v1/execution/device-proxy/run-9/start_screen_recording',
      ]);

      await expect(recording.stop({ dir, signal: new AbortController().signal })).resolves.toEqual({ file: 'recording.mp4' });
      expect(calls.at(-1)!.body).toEqual({ recording_id: 'rec-1' });
      expect(readFileSync(join(dir, 'recording.mp4'))).toEqual(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    });

    const stops = () => calls.filter((call) => call.url.endsWith('/stop_screen_recording'));
    const video = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } });
    const answers = (...responses: (() => Response)[]) => {
      routes['POST /api/v1/execution/device-proxy/run-9/stop_screen_recording'] = () => responses.shift()!();
    };

    it('stops once after a stop that wrote the video: a stop the engine repeats reuses it', async () => {
      const recording = await revyl(options).record!(lease, recordContext);
      const stop = { dir, signal: new AbortController().signal };
      await expect(recording.stop(stop)).resolves.toEqual({ file: 'recording.mp4' });
      await expect(recording.stop(stop)).resolves.toEqual({ file: 'recording.mp4' });
      expect(stops()).toHaveLength(1);
    });

    it('stops with a 5 minute bound, since the worker finalizes and streams the whole video in the answer', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const recording = await revyl(options).record!(lease, recordContext);
      timeout.mockClear();
      await recording.stop({ dir, signal: new AbortController().signal });
      expect(timeout.mock.calls).toEqual([[300_000]]);
      timeout.mockRestore();
    });

    it('asks the stop again after a dropped connection, a gateway error, and a worker that kept the recording, and writes the video the next answer carries', async () => {
      answers(
        () => {
          throw new TypeError('fetch failed');
        },
        () => json({ detail: 'gateway timeout' }, 504),
        () => json({ success: false, error: 'Screen recording finalize failed; recording retained; retry stop_screen_recording' }),
        video,
      );
      const recording = await revyl(options).record!(lease, recordContext);
      await expect(recording.stop({ dir, signal: new AbortController().signal })).rejects.toThrow('recording retained');
      expect(stops()).toHaveLength(3);
      await expect(recording.stop({ dir, signal: new AbortController().signal })).resolves.toEqual({ file: 'recording.mp4' });
      expect(stops()).toHaveLength(4);
      expect(stops().map((call) => call.body)).toEqual(Array.from({ length: 4 }, () => ({ recording_id: 'rec-1' })));
      expect(readFileSync(join(dir, 'recording.mp4'))).toEqual(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    });

    it('sends a stop again on the next call after one whose signal aborted', async () => {
      const recording = await revyl(options).record!(lease, recordContext);
      await expect(recording.stop({ dir, signal: AbortSignal.abort() })).rejects.toThrow();
      await expect(recording.stop({ dir, signal: new AbortController().signal })).resolves.toEqual({ file: 'recording.mp4' });
      expect(readFileSync(join(dir, 'recording.mp4'))).toEqual(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    });

    it('asks the stop again after a download that breaks partway, leaving only the whole video', async () => {
      answers(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
                controller.error(new TypeError('terminated'));
              },
            }),
            { headers: { 'content-type': 'video/mp4' } },
          ),
        video,
      );
      const recording = await revyl(options).record!(lease, recordContext);
      await expect(recording.stop({ dir, signal: new AbortController().signal })).resolves.toEqual({ file: 'recording.mp4' });
      expect(stops()).toHaveLength(2);
      expect(readFileSync(join(dir, 'recording.mp4'))).toEqual(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
    });

    it('fails a stop for good, without asking again, once the worker no longer holds the recording', async () => {
      answers(() => json({ success: false, error: 'No active screen recording has this recording_id' }));
      const recording = await revyl(options).record!(lease, recordContext);
      await expect(recording.stop({ dir, signal: new AbortController().signal })).rejects.toThrow(
        'Revyl no longer holds recording rec-1, so it has no video to return: No active screen recording has this recording_id',
      );
      expect(stops()).toHaveLength(1);
      expect(existsSync(join(dir, 'recording.mp4'))).toBe(false);
    });

    it('looks the session up again after a gateway error, and starts recording once', async () => {
      const running = routes[`GET /api/v1/execution/device-sessions/${sessionId}`]!;
      let lookups = 0;
      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = (call) => (++lookups === 1 ? json({ detail: 'bad gateway' }, 502) : running(call));
      await revyl(options).record!(lease, recordContext);
      expect(lookups).toBe(2);
      expect(calls.filter((call) => call.url.endsWith('/start_screen_recording'))).toHaveLength(1);
    });

    it('fails the start when the lease has no running device, and a refused start or stop with the reason the worker gives', async () => {
      // An ended session, even one that still names its workflow run, and one with no workflow run at all.
      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = () => json({ session_id: sessionId, workflow_run_id: 'run-9', status: 'completed' });
      await expect(revyl(options).record!(lease, recordContext)).rejects.toThrow(`Revyl reports no running device for session ${sessionId}`);
      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = () => json({ session_id: sessionId, status: 'running' });
      await expect(revyl(options).record!(lease, recordContext)).rejects.toThrow(`Revyl reports no running device for session ${sessionId}`);
      expect(calls.filter((call) => call.url.endsWith('/start_screen_recording'))).toEqual([]);

      routes[`GET /api/v1/execution/device-sessions/${sessionId}`] = () => json({ session_id: sessionId, workflow_run_id: 'run-9' });
      routes['POST /api/v1/execution/device-proxy/run-9/start_screen_recording'] = () => json({ success: false, error: 'already recording' });
      await expect(revyl(options).record!(lease, recordContext)).rejects.toThrow('Revyl refused start_screen_recording: already recording');

      routes['POST /api/v1/execution/device-proxy/run-9/start_screen_recording'] = () => json({ success: true, recording_id: 'rec-1' });
      routes['POST /api/v1/execution/device-proxy/run-9/stop_screen_recording'] = () => json({ success: false, error: 'no such recording' });
      const recording = await revyl(options).record!(lease, recordContext);
      await expect(recording.stop({ dir, signal: new AbortController().signal })).rejects.toThrow('Revyl refused stop_screen_recording: no such recording');
      expect(calls.filter((call) => call.url.endsWith('/stop_screen_recording'))).toHaveLength(1);
    });
  });
});
