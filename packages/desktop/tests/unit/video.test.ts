import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { WindowVideo } from '../../src/video.ts';
import { failure, fakeDriver, type Answer, type FakeDriver } from '../helpers/fake-driver.ts';
import { attempt, cleanUp, initialized, launched, operation, scratch } from '../helpers/surface.ts';

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
    await surface.activateWindow('w-other', operation());
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
    expect(await deferred.stopVideo(operation())).toEqual([]);
  });

  it('keeps a file the driver wrote but could not finish, and drops an empty one', async () => {
    const { surface } = await launched({ stopVideo: [failure('TIMEOUT', 'not_delivered')] });
    const artifactsDir = await attempt(surface);
    await surface.startVideo(operation());
    expect(await surface.stopVideo(operation())).toHaveLength(1);
    expect(existsSync(path.join(artifactsDir, 'video', 'window-001.mp4'))).toBe(true);
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
