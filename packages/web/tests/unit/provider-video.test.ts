/** `ProviderVideo`: the attempt's video as the browser provider records it, through starts that outlive their budget and stops that fail. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderRecording } from '@e2e-dev/core/engine';
import { ProviderVideo } from '../../src/driver/provider-video.ts';
import type { LeaseRecording } from '../../src/provider.ts';
import { gate } from '../helpers/gate.ts';

describe('ProviderVideo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const artifactsDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-video-'));
    dirs.push(dir);
    return dir;
  };

  /** A recording named `name` whose stop writes `<name>.mp4`, failing the first `failures` stops. */
  const recording = (name: string, stopped: string[], failures = 0): LeaseRecording => {
    let left = failures;
    const provided: ProviderRecording = {
      startedAt: '2026-09-28T10:00:00.000Z',
      async stop({ dir }) {
        stopped.push(name);
        if (left-- > 0) throw new Error('recorder unreachable');
        writeFileSync(path.join(dir, `${name}.mp4`), 'mp4');
        return { file: `${name}.mp4` };
      },
    };
    return { recording: provided, provider: 'browser provider "cloud"', leaseId: 'lease-0' };
  };

  it('stops a start that landed after its budget ran out, and keeps the recording started after it', async () => {
    const stopped: string[] = [];
    const { held: landing, release: land } = gate<LeaseRecording>();
    const starts = [
      () => landing,
      async () => recording('second', stopped),
    ];
    const video = new ProviderVideo(async () => starts.shift()!(), artifactsDir(), new AbortController().signal);
    const timedOut = new AbortController();
    const first = video.start(timedOut.signal);
    timedOut.abort();
    await video.start(new AbortController().signal);
    land(recording('first', stopped));
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stopped).toEqual(['first']);
    expect((await video.stop(new AbortController().signal)).map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/second.mp4']);
  });

  it('stops a recording that started once the attempt had ended, and never keeps it', async () => {
    const stopped: string[] = [];
    const { held: landing, release: land } = gate<LeaseRecording>();
    const ended = new AbortController();
    const video = new ProviderVideo(() => landing, artifactsDir(), ended.signal);
    const starting = video.start(new AbortController().signal);
    ended.abort();
    land(recording('late', stopped));
    await expect(starting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stopped).toEqual(['late']);
    expect(await video.stop(new AbortController().signal)).toEqual([]);
  });

  it('keeps the handle of a recording whose stop failed at the attempt’s close, so a later stop still ends it', async () => {
    const stopped: string[] = [];
    const video = new ProviderVideo(async () => recording('clip', stopped, 1), artifactsDir(), new AbortController().signal);
    await video.start(new AbortController().signal);
    await video.close(1_000);
    expect(stopped).toEqual(['clip']);
    expect(await video.stop(new AbortController().signal)).toHaveLength(1);
    expect(stopped).toEqual(['clip', 'clip']);
  });
});
