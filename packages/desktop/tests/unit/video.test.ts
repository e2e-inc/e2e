import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { WindowVideo } from '../../src/video.ts';
import { failure, fakeDriver, type Answer, type FakeDriver } from '../helpers/fake-driver.ts';
import { attempt, cleanUp, initialized, launched, operation, scratch } from '../helpers/surface.ts';

// The suite runs on any OS, and the engine reads the Darwin version from `os.release()`: macOS 26 here, so video is supported.
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), release: () => '25.0.0' }));

afterEach(cleanUp);

/** The windows of the newest launched process: `w-mine`, focused, and `w-other`. */
const twoWindows = (fake: FakeDriver): Answer => ({
  ok: true,
  data: [
    { id: 'w-mine', title: 'Spike Form', pid: fake.pid, is_focused: true },
    { id: 'w-other', title: 'Other', pid: fake.pid },
  ],
});

/** A snapshot of whichever window was asked for, with one button. */
const snapshotOfAsked = (_fake: FakeDriver, args: readonly unknown[]): Answer => {
  const windowId = (args[0] as { windowId: string }).windowId;
  return { ok: true, data: { snapshot_id: 's', window: { id: windowId }, tree: { role: 'window', children: [{ role: 'button', name: 'Go', ref: `@${windowId}` }] } } };
};

/** A start that writes its file, as the fake's own does, for a scenario that scripts the starts after it. */
const recording = (fake: FakeDriver, args: readonly unknown[]): Answer => {
  const file = (args[0] as { path: string }).path;
  writeFileSync(file, 'mp4');
  fake.videos.set(1, file);
  return { ok: true, data: { id: 1, width: 840, height: 584 } };
};

/** The window each recording the fake started was asked for, in order. */
const recorded = (fake: FakeDriver) => fake.of('startVideo').map((call) => (call.args[0] as { windowId: string }).windowId);

describe('desktop video', () => {
  it('is declared, so video: "on" and app.startRecording() reach the engine', () => {
    const engine = desktop();
    expect(engine.artifacts?.startVideo).toBeTypeOf('function');
    expect(engine.artifacts?.stopVideo).toBeTypeOf('function');
  });

  it("starts with the app's first window when asked before app.open(), and answers its file", async () => {
    const { surface, fake } = await initialized();
    const artifactsDir = await attempt(surface);
    await surface.startVideo(operation());
    expect(fake.of('startVideo')).toEqual([]);
    await surface.restart(operation());
    expect(recorded(fake)).toEqual(['w-mine']);
    const segments = await surface.stopVideo(operation());
    expect(segments).toEqual([{ path: path.join('video', 'window-001.mp4'), startedAt: expect.any(String) }]);
    expect(readFileSync(path.join(artifactsDir, 'video', 'window-001.mp4'), 'utf8')).toBe('mp4');
    expect(fake.videos.size).toBe(0);
  });

  it('ends the file before the app relaunches, and starts another on the new window', async () => {
    const { surface, fake } = await launched();
    await attempt(surface);
    await surface.startVideo(operation());
    await surface.restart(operation());
    // The first file ended while its window was still there, before the quit.
    const order = fake.calls.map((call) => call.method).filter((method) => method === 'stopVideo' || method === 'launch');
    expect(order).toEqual(['launch', 'stopVideo', 'launch']);
    expect((await surface.stopVideo(operation())).map((segment) => 'path' in segment && segment.path)).toEqual([path.join('video', 'window-001.mp4'), path.join('video', 'window-002.mp4')]);
  });

  it('follows the screen to another window, and records the same window once', async () => {
    const { surface, fake } = await launched({ listWindows: [twoWindows], snapshot: [snapshotOfAsked] });
    await attempt(surface);
    await surface.startVideo(operation());
    await surface.observe(operation(), undefined);
    expect(recorded(fake)).toEqual(['w-mine']);
    // Activating a window moves the video at once, with no read of the screen after it.
    await surface.activateWindow('w-other', operation());
    expect(recorded(fake)).toEqual(['w-mine', 'w-other']);
    await surface.observe(operation(), undefined);
    expect(recorded(fake)).toEqual(['w-mine', 'w-other']);
    expect(await surface.stopVideo(operation())).toHaveLength(2);
  });

  it('fails a start on a window it cannot record, and leaves a gap rather than fail a read', async () => {
    const refused = failure('WINDOW_NOT_FOUND', 'not_delivered', 'window w-mine is not one ScreenCaptureKit can record');
    const { surface, fake } = await launched({ listWindows: [twoWindows], snapshot: [snapshotOfAsked], startVideo: [refused, refused] });
    await attempt(surface);
    await expect(surface.startVideo(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // Asked before the app had a window, the start is the first window's, and a refusal then leaves no file.
    const { surface: deferred } = await initialized(fake);
    await attempt(deferred);
    await deferred.startVideo(operation());
    await deferred.restart(operation());
    await expect(deferred.observe(operation(), undefined)).resolves.toBeDefined();
    // With no file at all, the stop says why.
    await expect(deferred.stopVideo(operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringContaining('ScreenCaptureKit') });
  });

  it('refuses video without Screen Recording permission before it waits for a window', async () => {
    const { surface, fake } = await initialized();
    fake.screenRecording = false;
    await attempt(surface);
    await expect(surface.startVideo(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('Screen Recording') });
    expect(fake.of('startVideo')).toEqual([]);
  });

  it('drops a file whose stop failed, which no player opens, and says why when it was the only one', async () => {
    const broke = failure('ACTION_FAILED', 'not_delivered', 'the video could not be finished: the stream stopped');
    const { surface } = await launched({ stopVideo: [broke] });
    const artifactsDir = await attempt(surface);
    await surface.startVideo(operation());
    await expect(surface.stopVideo(operation())).rejects.toMatchObject({ message: expect.stringContaining('could not be finished') });
    expect(existsSync(path.join(artifactsDir, 'video', 'window-001.mp4'))).toBe(false);
  });

  it('drops the empty file of a window that closed before its first frame, and says why when it was the only one', async () => {
    const empty = (fake: FakeDriver, args: readonly unknown[]): Answer => {
      writeFileSync(fake.videos.get(args[0] as number)!, '');
      return { ok: true, data: { bytes: 0 } };
    };
    const { surface } = await launched({ stopVideo: [empty] });
    await attempt(surface);
    await surface.startVideo(operation());
    await expect(surface.stopVideo(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('got no frame') });
  });

  it("keeps the files of the windows it recorded when another window's start failed", async () => {
    const refused = failure('WINDOW_NOT_FOUND', 'not_delivered', 'window w-other is not one ScreenCaptureKit can record');
    const { surface, fake } = await launched({ listWindows: [twoWindows], snapshot: [snapshotOfAsked], startVideo: [recording, refused] });
    await attempt(surface);
    await surface.startVideo(operation());
    await surface.activateWindow('w-other', operation());
    // The window that cannot be recorded is not tried again on every read while the screen stays on it.
    await surface.observe(operation(), undefined);
    await surface.observe(operation(), undefined);
    expect(recorded(fake)).toEqual(['w-mine', 'w-other']);
    expect(await surface.stopVideo(operation())).toEqual([{ path: path.join('video', 'window-001.mp4'), startedAt: expect.any(String) }]);
  });

  it('stops a recording the attempt left running when it ends', async () => {
    const { surface, fake } = await launched();
    await attempt(surface);
    await surface.startVideo(operation());
    await surface.endAttempt({ signal: operation().signal, timeoutMs: 2_000 });
    expect(fake.of('stopVideo')).toHaveLength(1);
    expect(fake.videos.size).toBe(0);
  });

  it('stops the recording even when the operation that ends it was cancelled', async () => {
    const { surface, fake } = await launched();
    await attempt(surface);
    await surface.startVideo(operation());
    const cancelled = new AbortController();
    cancelled.abort();
    // The quit after it refuses a cancelled signal, as it should; the recording was stopped first.
    await expect(surface.endAttempt({ signal: cancelled.signal, timeoutMs: 2_000 })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.of('stopVideo')).toHaveLength(1);
    expect(fake.videos.size).toBe(0);
  });

  it('refuses video before macOS 15, whose ScreenCaptureKit records no file, asking the driver nothing', async () => {
    const fake = fakeDriver();
    const video = new WindowVideo(() => fake);
    await expect(video.begin(scratch(), 'w-mine', operation(), '23.6.0')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('macOS 15') });
    expect(fake.calls).toEqual([]);
    expect(video.recording).toBe(false);
  });
});
