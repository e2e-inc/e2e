/**
 * A provider that records its browsers, without a real browser: the attempt's
 * video is the provider's recording instead of the screencast, for one
 * attempt at a time, and the recording is stopped on every path.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRecordContext, ProviderRecording } from '@e2e-dev/core/engine';
import { connectCdp } from '../../src/browser-connection.ts';
import { web } from '../../src/index.ts';
import { LeasedBrowsers, type BrowserLease, type BrowserProvider } from '../../src/provider.ts';
import { attempt, cleanup, fakeBrowser, initInfo, operation, prepared, provider } from '../helpers/browser-provider.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  connectCdp: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(connectCdp).mockReset();
  vi.mocked(connectCdp).mockImplementation(async ({ endpoint }) => fakeBrowser(`context-${endpoint}`).browser);
});

describe('recording', () => {
  /** A provider that records: `stop` writes `replay.mp4`, or whatever name it is told to report. */
  function recordingProvider(options: { failStart?: boolean; report?: string } = {}) {
    const cloud = provider();
    const recorded: { lease: BrowserLease; context: ProviderRecordContext }[] = [];
    const stopped: string[] = [];
    const impl: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context): Promise<ProviderRecording> {
        recorded.push({ lease, context });
        if (options.failStart === true) throw new Error('recordings unavailable');
        return {
          startedAt: '2026-09-28T10:00:00.000Z',
          async stop({ dir }) {
            stopped.push(lease.id);
            writeFileSync(path.join(dir, 'replay.mp4'), 'mp4');
            return options.report === undefined ? { file: 'replay.mp4' } : { file: options.report };
          },
        };
      },
    };
    return { impl, recorded, stopped };
  }

  const artifactDirs: string[] = [];
  afterEach(() => {
    for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A worker holding slot 0's lease, attempt `a1` started in a fresh artifact directory, removed after the test. */
  async function recordingWorker(impl: BrowserProvider) {
    const { env } = await prepared(impl, 1);
    const worker = web({ browser: impl });
    await worker.init!(initInfo(0, env));
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-recording-'));
    artifactDirs.push(artifactsDir);
    await worker.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return { worker, artifactsDir };
  }

  it('rejects a record that is not a function', () => {
    expect(() => web({ browser: { ...provider().impl, record: 'yes' } as unknown as BrowserProvider })).toThrow(/record that is not a function/);
  });

  it('records the attempt through the provider instead of the screencast, as one segment in the attempt directory', async () => {
    const cloud = recordingProvider();
    const { worker, artifactsDir } = await recordingWorker(cloud.impl);
    await worker.artifacts!.startVideo!(operation());
    expect(cloud.recorded.map(({ lease, context }) => [lease.id, context.attemptId, context.runId, context.targetName])).toEqual([['lease-0', 'a1', 'run-1', 'web']]);
    const segments = await worker.artifacts!.stopVideo!(operation());
    expect(segments).toEqual([{ path: 'video/replay.mp4', startedAt: '2026-09-28T10:00:00.000Z' }]);
    expect(readFileSync(path.join(artifactsDir, 'video', 'replay.mp4'), 'utf8')).toBe('mp4');
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
    await worker.endAttempt!(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose!(cleanup());
  });

  it('turns a recording the provider keeps into a link segment, with nothing written locally', async () => {
    const cloud = provider();
    const linking: BrowserProvider = {
      ...cloud.impl,
      async record(): Promise<ProviderRecording> {
        return { startedAt: '2026-09-28T10:00:00.000Z', stop: async () => ({ url: 'https://recordings.example/r1.mp4', mediaType: 'video/mp4' }) };
      },
    };
    const { worker, artifactsDir } = await recordingWorker(linking);
    await worker.artifacts!.startVideo!(operation());
    expect(await worker.artifacts!.stopVideo!(operation())).toEqual([
      { url: 'https://recordings.example/r1.mp4', mediaType: 'video/mp4', startedAt: '2026-09-28T10:00:00.000Z' },
    ]);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
    await worker.dispose!(cleanup());
  });

  it('records the screencast when the provider does not record', async () => {
    const { worker, artifactsDir } = await recordingWorker(provider().impl);
    await worker.artifacts!.startVideo!(operation());
    const segments = await worker.artifacts!.stopVideo!(operation());
    expect(segments.map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/video.webm']);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(true);
    await worker.dispose!(cleanup());
  });

  it('records the browser for one attempt at a time: an attempt beside it records its own pages, and the next one has the provider again', async () => {
    const cloud = recordingProvider();
    const { worker } = await recordingWorker(cloud.impl);
    /** Starts `attemptId` beside the open attempts, records it, and returns the files its video is. */
    const videoOf = async (attemptId: string): Promise<string[]> => {
      const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-recording-'));
      artifactDirs.push(artifactsDir);
      await worker.startAttempt!({ ...attempt(attemptId), artifactsDir });
      await worker.artifacts!.startVideo!({ ...operation(), attemptId });
      const segments = await worker.artifacts!.stopVideo!({ ...operation(), attemptId });
      return segments.map((segment) => ('path' in segment ? segment.path : segment.url));
    };
    // The recording is `a1`'s from its start, whether or not it records.
    expect(await videoOf('actor')).toEqual(['video/video.webm']);
    expect(cloud.recorded).toEqual([]);
    await worker.endAttempt!({ ...cleanup(), attemptId: 'a1' });
    expect(await videoOf('a2')).toEqual(['video/replay.mp4']);
    expect(cloud.recorded.map(({ context }) => context.attemptId)).toEqual(['a2']);
    // The actor ending leaves the recording with `a2`.
    await worker.endAttempt!({ ...cleanup(), attemptId: 'actor' });
    expect(await videoOf('a3')).toEqual(['video/video.webm']);
    expect(cloud.recorded).toHaveLength(1);
    await worker.dispose!(cleanup());
  });

  it('stops a recording the attempt never collected when the attempt ends', async () => {
    const cloud = recordingProvider();
    const { worker } = await recordingWorker(cloud.impl);
    await worker.artifacts!.startVideo!(operation());
    await worker.endAttempt!(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose!(cleanup());
  });

  it('stops a recording that started after the attempt ended, and keeps nothing of it', async () => {
    const cloud = recordingProvider();
    let resume!: () => void;
    const record = cloud.impl.record!.bind(cloud.impl);
    const late: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context) {
        await new Promise<void>((resolve) => { resume = resolve; });
        return record(lease, context);
      },
    };
    const { worker } = await recordingWorker(late);
    const starting = worker.artifacts!.startVideo!(operation());
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    await worker.endAttempt!(cleanup());
    resume();
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose!(cleanup());
  });

  it('reports a recording that failed to start once the attempt was cancelled as CANCELLED, not a provider failure', async () => {
    const cancelling: BrowserProvider = {
      ...provider().impl,
      async record() {
        throw new Error('aborted by the signal');
      },
    };
    const { env } = await prepared(cancelling, 1);
    const leases = new LeasedBrowsers(cancelling);
    leases.init(initInfo(0, env));
    const controller = new AbortController();
    controller.abort();
    await expect(leases.recorder('a1')!(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(leases.recorder('a1')!(new AbortController().signal)).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('refuses, at the start and named, a recording without a start time and a stop', async () => {
    const malformed = await recordingWorker({ ...provider().impl, record: async () => undefined as unknown as ProviderRecording });
    await expect(malformed.worker.artifacts!.startVideo!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" returned a recording of browser lease-0 without a start time and a stop()'),
    });
    await malformed.worker.dispose!(cleanup());
  });

  it('shares a stop that timed out and is still in flight, so ending the attempt never stops a recording twice', async () => {
    let stops = 0;
    let finish!: () => void;
    const slow: BrowserProvider = {
      ...provider().impl,
      async record(): Promise<ProviderRecording> {
        return {
          startedAt: '2026-09-28T10:00:00.000Z',
          async stop({ dir }) {
            stops += 1;
            await new Promise<void>((resolve) => { finish = resolve; });
            writeFileSync(path.join(dir, 'replay.mp4'), 'mp4');
            return { file: 'replay.mp4' };
          },
        };
      },
    };
    const { worker } = await recordingWorker(slow);
    await worker.artifacts!.startVideo!(operation());
    // The runner's cleanup budget runs out while the provider is still stopping; the close then waits for that same stop.
    const budget = new AbortController();
    const collecting = worker.artifacts!.stopVideo!({ ...operation(), signal: budget.signal });
    await vi.waitFor(() => expect(stops).toBe(1));
    budget.abort();
    await expect(collecting).rejects.toMatchObject({ code: 'CANCELLED' });
    const ending = worker.endAttempt!(cleanup());
    finish();
    await ending;
    expect(stops).toBe(1);
    await worker.dispose!(cleanup());
  });

  it('keeps a recording whose stop failed, so ending the attempt stops it once more', async () => {
    const cloud = recordingProvider();
    let failures = 1;
    const record = cloud.impl.record!.bind(cloud.impl);
    const flaky: BrowserProvider = {
      ...cloud.impl,
      async record(lease, context) {
        const recording = await record(lease, context);
        return {
          startedAt: recording.startedAt,
          async stop(stopContext) {
            if (failures-- > 0) throw new Error('download interrupted');
            return recording.stop(stopContext);
          },
        };
      },
    };
    const { worker } = await recordingWorker(flaky);
    await worker.artifacts!.startVideo!(operation());
    await expect(worker.artifacts!.stopVideo!(operation())).rejects.toThrow('download interrupted');
    await worker.endAttempt!(cleanup());
    expect(cloud.stopped).toEqual(['lease-0']);
    await worker.dispose!(cleanup());
  });

  it('names the provider when a recording cannot start, and refuses a stop that names no file it wrote', async () => {
    const failing = await recordingWorker(recordingProvider({ failStart: true }).impl);
    await expect(failing.worker.artifacts!.startVideo!(operation())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('browser provider "toy-cloud" could not start recording browser lease-0: recordings unavailable'),
    });
    await failing.worker.dispose!(cleanup());
    for (const report of ['../escape.mp4', 'missing.mp4']) {
      const { worker } = await recordingWorker(recordingProvider({ report }).impl);
      await worker.artifacts!.startVideo!(operation());
      await expect(worker.artifacts!.stopVideo!(operation())).rejects.toMatchObject({
        code: 'ENGINE_FAILURE',
        message: expect.stringContaining('browser provider "toy-cloud" recording lease lease-0 finished without naming a file it wrote'),
      });
      await worker.dispose!(cleanup());
    }
  });
});
