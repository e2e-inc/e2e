/**
 * The driver's recording as the session drives it, over a scripted Firefox
 * peer, whose screencast is plain BiDi: nothing recorded and no tab sized
 * until a recording is asked for, a start on the tab shown then, one
 * segment per tab shown after it, a start its step gave up on stopped
 * again, a failed finish that still left a file kept, and a lost segment
 * reported once. And its policy on Chromium without a real browser: a
 * segment that cannot start never fails the tab that opened, `stop` reports
 * it once, and a recorder whose own start failed stays disarmed. The real
 * screencasts are covered by the lifecycle integration test on each browser.
 */

import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineError } from '@e2e-dev/core/engine';
import { BidiVideo, type RecordedTab, type VideoOptions } from '../../src/driver/video.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { FakeBidi, type Reply } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';

const VIEWPORT = { width: 320, height: 200 };

/** A tab the test shows to a recorder, counting how often its viewport is read. */
function recordedTab() {
  const state = { shown: undefined as string | undefined, viewport: VIEWPORT, sized: 0 };
  const tab: RecordedTab = {
    shown: () => state.shown,
    viewport: async () => {
      state.sized += 1;
      return state.viewport;
    },
  };
  return { state, tab };
}

/** Starts `video` with nothing giving up on it. */
function start(video: BidiVideo): Promise<void> {
  return video.start(new AbortController().signal);
}

/** How the scripted browser answers one screencast. */
interface ScreencastScript {
  /** Fails the start with this error. */
  readonly startError?: string;
  /** Answers the stop with this error after writing nothing, or after writing the attempt's file itself when `wroteTarget`. */
  readonly stopError?: string;
  readonly wroteTarget?: boolean;
}

describe('BidiVideo', () => {
  let artifactsDir: string;
  let browserDir: string;
  let bidi: FakeBidi;
  /** Scripts keyed by the context a screencast records; a context with none records cleanly. */
  let scripts: Map<string, ScreencastScript>;
  /** The tab the recorders of a test are shown. */
  let shown: ReturnType<typeof recordedTab>;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-unit-'));
    browserDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-browser-'));
    scripts = new Map();
    shown = recordedTab();
    bidi = new FakeBidi()
      .on('browsingContext.startScreencast', (params) => {
        const context = params['context'] as string;
        const script = scripts.get(context) ?? {};
        if (script.startError !== undefined) return { error: 'unknown error', message: script.startError };
        return { result: { screencast: `cast-${context}` } };
      })
      .on('browsingContext.stopScreencast', (params): Reply => {
        const context = (params['screencast'] as string).replace(/^cast-/, '');
        const script = scripts.get(context) ?? {};
        if (script.stopError !== undefined) {
          if (script.wroteTarget === true) writeFileSync(path.join(artifactsDir, 'video', targetName(context)), 'webm');
          return { result: { error: script.stopError } };
        }
        const file = path.join(browserDir, `${context}.webm`);
        writeFileSync(file, 'webm');
        return { result: { path: file } };
      });
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(browserDir, { recursive: true, force: true });
  });

  /** The segment file name the test expects `context` to be recorded as, by the order the tests open contexts in. */
  function targetName(context: string): string {
    const index = Number(context.replace(/^tab-/, ''));
    return index === 1 ? 'video.webm' : `video-part${String(index)}.webm`;
  }

  const video = (options: VideoOptions = {}) => new BidiVideo(bidi.connection, BROWSER_TRAITS.firefox, artifactsDir, options, {}, shown.tab);
  /** Starts `recorder` while `context` is the tab shown. */
  const startOn = (recorder: BidiVideo, context: string): Promise<void> => {
    shown.state.shown = context;
    return start(recorder);
  };
  const started = () => bidi.commands('browsingContext.startScreencast').map((command) => command.params);
  const stops = () => bidi.commands('browsingContext.stopScreencast').length;
  const paths = (segments: readonly { path: string }[]) => segments.map((segment) => segment.path);

  it('records nothing and sizes no tab until a recording is asked for', async () => {
    const recorder = video();
    shown.state.shown = 'tab-1';
    await recorder.contextOpened('tab-1');
    await recorder.contextClosing();
    await recorder.contextClosed();
    expect(await recorder.stop()).toEqual([]);
    await recorder.close();
    expect(shown.state.sized).toBe(0);
    expect(bidi.sent).toEqual([]);
  });

  it('starts on the tab shown, then records one segment per tab shown after it, in order, each at its viewport and with its start instant', async () => {
    const recorder = video();
    await startOn(recorder, 'tab-1');
    // A restart ends the segment before its tab closes, then opens another tab: the next segment.
    await recorder.contextClosing();
    expect(stops()).toBe(1);
    shown.state.viewport = { width: 390, height: 600 };
    await recorder.contextOpened('tab-2');
    expect(started()).toEqual([
      { context: 'tab-1', mimeType: 'video/webm', video: { ...VIEWPORT, frameRate: 25 } },
      { context: 'tab-2', mimeType: 'video/webm', video: { width: 390, height: 600, frameRate: 25 } },
    ]);
    const segments = await recorder.stop();
    expect(paths(segments)).toEqual(['video/video.webm', 'video/video-part2.webm']);
    for (const segment of segments) {
      expect(Number.isNaN(Date.parse(segment.startedAt))).toBe(false);
      expect(existsSync(path.join(artifactsDir, segment.path))).toBe(true);
    }
    expect(stops()).toBe(2);
    expect(existsSync(path.join(browserDir, 'tab-1.webm'))).toBe(false);
  });

  it('only arms while no tab is shown, without sizing one, and the first tab shown starts the first segment', async () => {
    const recorder = video();
    await start(recorder);
    expect(shown.state.sized).toBe(0);
    expect(started()).toEqual([]);
    await recorder.contextOpened('tab-1');
    expect(started().map((params) => params['context'])).toEqual(['tab-1']);
    await recorder.close();
  });

  it('stops a start that finished after its step gave up, and records no tab shown after it', async () => {
    const recorder = video();
    shown.state.shown = 'tab-1';
    const gaveUp = new AbortController();
    gaveUp.abort();
    await expect(recorder.start(gaveUp.signal)).rejects.toThrow();
    expect(stops()).toBe(1);
    await recorder.contextOpened('tab-2');
    expect(started().map((params) => params['context'])).toEqual(['tab-1']);
  });

  it('records at the configured size without reading the viewport', async () => {
    const recorder = video({ size: { width: 640, height: 400 } });
    await startOn(recorder, 'tab-1');
    expect(started()[0]).toMatchObject({ video: { width: 640, height: 400 } });
    expect(shown.state.sized).toBe(0);
    await recorder.stop();
  });

  it('starts again after a stop on the same tab, and the second stop hands over only the new segment', async () => {
    const recorder = video();
    await startOn(recorder, 'tab-1');
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
    // Disarmed between recordings: a tab opened now starts nothing and is not sized.
    await recorder.contextOpened('tab-9');
    expect(started()).toHaveLength(1);
    expect(shown.state.sized).toBe(1);
    await startOn(recorder, 'tab-2');
    expect(paths(await recorder.stop())).toEqual(['video/video-part2.webm']);
  });

  it('reports a tab whose viewport cannot be read as a lost segment, never to the step that showed it', async () => {
    const recorder = new BidiVideo(bidi.connection, BROWSER_TRAITS.firefox, artifactsDir, {}, {}, {
      shown: () => undefined,
      viewport: async () => {
        throw new Error('the window has no size');
      },
    });
    await start(recorder);
    await expect(recorder.contextOpened('tab-1')).resolves.toBeUndefined();
    expect(started()).toEqual([]);
    await expect(recorder.stop()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('the window has no size') });
    await expect(recorder.stop()).resolves.toEqual([]);
  });

  it('keeps a segment whose finish failed but whose file exists', async () => {
    scripts.set('tab-1', { stopError: 'encoder stalled', wroteTarget: true });
    const recorder = video();
    await startOn(recorder, 'tab-1');
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
  });

  it('reports a segment whose finish failed and left no file, once', async () => {
    scripts.set('tab-1', { stopError: 'screencast stop failed' });
    const recorder = video();
    await startOn(recorder, 'tab-1');
    const caught = await recorder.stop().then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('video/video.webm') });
    expect((caught as Error).message).toContain('screencast stop failed');
    // Reported, then forgotten: the next stop has nothing to say.
    expect(await recorder.stop()).toEqual([]);
    expect(existsSync(path.join(artifactsDir, 'video', 'video.webm'))).toBe(false);
  });

  it('hands the segments that finalized to the stop after one that reported a lost segment', async () => {
    scripts.set('tab-2', { stopError: 'screencast stop failed' });
    const recorder = video();
    await startOn(recorder, 'tab-1');
    await recorder.contextOpened('tab-2');
    await expect(recorder.stop()).rejects.toThrow('video/video-part2.webm');
    // A host that retries the stop gets what did finalize, so nothing on disk goes unreported.
    expect(paths(await recorder.stop())).toEqual(['video/video.webm']);
  });

  it('stays disarmed when the first segment cannot start, so a later tab does not record', async () => {
    scripts.set('tab-1', { startError: 'screencast unavailable' });
    const recorder = video();
    await expect(startOn(recorder, 'tab-1')).rejects.toThrow('screencast unavailable');
    await recorder.contextOpened('tab-2');
    expect(started()).toHaveLength(1);
    expect(await recorder.stop()).toEqual([]);
    expect(stops()).toBe(0);
  });

  it('ends at once a segment whose start outlived the stop', async () => {
    const { held, release } = gate();
    bidi.on('browsingContext.startScreencast', async () => {
      await held;
      return { result: { screencast: 'cast-tab-1' } };
    });
    const recorder = video();
    const arming = startOn(recorder, 'tab-1');
    const stopping = recorder.stop();
    release();
    await arming;
    // The start finished after the stop began, so its segment ended at once and the stop hands it over.
    expect(paths(await stopping)).toEqual(['video/video.webm']);
    expect(stops()).toBe(1);
    await recorder.contextOpened('tab-2');
    expect(started()).toHaveLength(1);
  });

});

describe('a segment that cannot start', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-video-test-'));
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** A Chromium recorder of `tab` on `fake` whose CDP session never opens, with an ffmpeg that is never reached. */
  function unstartable(fake: FakeBidi, tab: RecordedTab): BidiVideo {
    fake.on('goog:cdp.getSession', { error: 'unknown error', message: 'no CDP session for this tab' });
    return new BidiVideo(fake.connection, BROWSER_TRAITS.chromium, artifactsDir, {}, { E2E_FFMPEG_PATH: process.execPath }, tab);
  }

  it('lets a tab open when its segment cannot start, and reports the lost segment from stop once', async () => {
    const video = unstartable(new FakeBidi(), recordedTab().tab);
    await start(video);
    await expect(video.contextOpened('tab')).resolves.toBeUndefined();
    await expect(video.stop()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('no CDP session for this tab') });
    await expect(video.stop()).resolves.toEqual([]);
  });

  it('stays disarmed after its own start failed, so later tabs start no segment', async () => {
    const fake = new FakeBidi();
    const shown = recordedTab();
    shown.state.shown = 'tab';
    const video = unstartable(fake, shown.tab);
    await expect(start(video)).rejects.toThrow('no CDP session for this tab');
    const tried = fake.commands('goog:cdp.getSession').length;
    await video.contextOpened('tab-2');
    expect(fake.commands('goog:cdp.getSession')).toHaveLength(tried);
    await expect(video.stop()).resolves.toEqual([]);
  });

  it('records and arms nothing when a stop lands while its start still looks for ffmpeg', async () => {
    const fake = new FakeBidi();
    const shown = recordedTab();
    shown.state.shown = 'tab';
    const video = unstartable(fake, shown.tab);
    const starting = start(video);
    await expect(video.stop()).resolves.toEqual([]);
    await expect(starting).resolves.toBeUndefined();
    await video.contextOpened('tab-2');
    expect(fake.commands('goog:cdp.getSession')).toHaveLength(0);
  });
});
