/**
 * Video of the app: the window the engine reads, recorded by the driver
 * through ScreenCaptureKit (`crates/e2e-desktop-napi/src/video.rs`), one MPEG-4 file per
 * window. A recording follows its window as it moves and shows nothing
 * that covers it, in the background too. When the screen the
 * engine reads moves to another window, or the app quits or relaunches, the
 * file of the window before ends and the next one starts, so `stopVideo`
 * answers one segment per window the attempt showed, in order. A recording
 * asked for before the app has a window starts with its first one. The
 * window is recorded as the app draws it: a secure field shows its bullets,
 * and nothing is masked.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { EngineError, type OperationContext, type VideoSegment } from '@e2e-dev/core/engine';
import { call, translate, type DesktopDriver, type Envelope } from './driver.ts';

/** How long a start or a stop of one file may take at most, whatever budget the operation has left. */
const VIDEO_CALL_MS = 10_000;
/** How long a recording whose start the budget cut off gets to be stopped, once the driver answers. */
const ORPHAN_STOP_MS = 2_000;

/** Darwin 24 is macOS 15, the first whose ScreenCaptureKit records to a file. */
const FIRST_DARWIN_WITH_VIDEO = 24;

/** One file being written. */
interface Segment {
  readonly id: number;
  readonly windowId: string;
  readonly relative: string;
  readonly startedAt: string;
}

/** The video of one attempt. */
export class WindowVideo {
  private wanted = false;
  private artifactsDir: string | undefined;
  private current: Segment | undefined;
  private segments: VideoSegment[] = [];
  private files = 0;
  /** The first file the video lost (a start `follow` could not make, or a stop that left no playable file): why a video that recorded nothing has no file. */
  private missed: unknown;
  /** The windows whose recording failed to start, which `follow` does not try again: a read polls every 100 ms. */
  private refused = new Set<string>();
  /** The start or stop running now, which the next one waits for. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly driver: () => DesktopDriver) {}

  /** Whether video was asked for and not stopped since. */
  get recording(): boolean {
    return this.wanted;
  }

  /**
   * `startVideo`: from now on the window the engine reads is recorded,
   * starting with `windowId`, the one it reads now. With no window yet, the
   * first one the app shows starts the recording. A window that cannot be
   * recorded fails the start.
   */
  async begin(artifactsDir: string, windowId: string | undefined, operation: OperationContext, darwin = release()): Promise<void> {
    // Refused at once, not at the first window, which would leave a run that asked for video with none and no word why.
    if (Number.parseInt(darwin, 10) < FIRST_DARWIN_WITH_VIDEO) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'video of a desktop app needs macOS 15 or later, where ScreenCaptureKit records a window to a file', { retryable: false });
    }
    if (this.wanted) throw new EngineError('INVALID_STATE', 'a video is already recording', { retryable: false });
    // Refused at once for the same reason: the first window's start comes later, in `follow`, which never fails a read.
    if (!this.driver().status().screenRecording) {
      throw new EngineError(
        'ENGINE_FAILURE',
        'video of a desktop app needs Screen Recording permission: allow the app that starts e2e in System Settings > Privacy & Security > Screen Recording, then run again',
        { retryable: false },
      );
    }
    this.wanted = true;
    this.artifactsDir = artifactsDir;
    this.segments = [];
    this.missed = undefined;
    this.refused = new Set();
    try {
      await this.serially(() => this.switchTo(windowId, operation));
    } catch (cause) {
      this.wanted = false;
      throw cause;
    }
  }

  /**
   * Records `windowId` from now on: the file of another window ends, and a
   * new one starts. Undefined ends the current file with nothing after it,
   * as before the app quits. Nothing happens while no video was asked for,
   * and a window that cannot be recorded leaves a gap, never a failure of
   * the read or launch that called it: it is not tried again for the rest
   * of the video, even after the screen leaves it and comes back. The first
   * such failure is kept for `end`.
   */
  async follow(windowId: string | undefined, operation: OperationContext): Promise<void> {
    const target = windowId !== undefined && this.refused.has(windowId) ? undefined : windowId;
    if (!this.wanted || target === this.current?.windowId) return;
    await this.serially(() => this.switchTo(target, operation)).catch((cause: unknown) => {
      if (target !== undefined) this.refused.add(target);
      this.missed ??= cause;
    });
  }

  /**
   * `stopVideo`: ends the current file and answers every file of the
   * attempt, in order. A video that recorded no file, because a start
   * failed or a stop left no playable file, fails with that error, so the
   * run says why.
   */
  async end(operation: OperationContext): Promise<readonly VideoSegment[]> {
    if (!this.wanted) return [];
    this.wanted = false;
    await this.serially(() => this.switchTo(undefined, operation));
    const segments = this.segments;
    const missed = this.missed;
    this.segments = [];
    this.missed = undefined;
    if (segments.length === 0 && missed !== undefined) throw missed;
    return segments;
  }

  /** Stops a recording still running when the attempt ends without `stopVideo`, and keeps nothing of it. */
  async abandon(operation: OperationContext): Promise<void> {
    this.wanted = false;
    this.missed = undefined;
    await this.serially(() => this.switchTo(undefined, operation)).catch(() => undefined);
    this.segments = [];
  }

  private serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async switchTo(windowId: string | undefined, operation: OperationContext): Promise<void> {
    if (this.current !== undefined && this.current.windowId === windowId) return;
    await this.finish(operation);
    if (windowId !== undefined && this.wanted) await this.start(windowId, operation);
  }

  private async start(windowId: string, operation: OperationContext): Promise<void> {
    const directory = this.artifactsDir;
    if (directory === undefined) return;
    this.files += 1;
    const relative = path.join('video', `window-${String(this.files).padStart(3, '0')}.mp4`);
    const absolute = path.join(directory, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const driver = this.driver();
    let started: Promise<Envelope<{ readonly id: number }>> | undefined;
    const label = 'start the video';
    const answer = await call(() => (started = driver.startVideo({ windowId, path: absolute, timeoutMs: Math.min(operation.timeoutMs, VIDEO_CALL_MS) })), {
      label,
      input: false,
      signal: operation.signal,
      timeoutMs: Math.min(operation.timeoutMs, VIDEO_CALL_MS),
      // A start the budget cut off may still come up: it is stopped once the driver answers, so no recording outlives it.
      onCutOff: () => void started?.then((late) => (late.ok ? driver.stopVideo(late.data.id, ORPHAN_STOP_MS) : undefined), () => undefined),
    }).catch((cause: unknown) => {
      throw translate(cause, label, false);
    });
    this.current = { id: answer.id, windowId, relative, startedAt: new Date().toISOString() };
  }

  /**
   * Ends the current file and keeps it when the driver finished it. A stop that failed (the recording broke off, or
   * did not finish in time) leaves a file with no index, which no player opens, and a window that closed before its
   * first frame leaves none: either is dropped, and the first such loss kept for `end`.
   */
  private async finish(operation: OperationContext): Promise<void> {
    const segment = this.current;
    if (segment === undefined || this.artifactsDir === undefined) return;
    this.current = undefined;
    const absolute = path.join(this.artifactsDir, segment.relative);
    // The stop is bounded: a file the driver did not finish in time is judged by what it holds. It goes even when the
    // operation was cancelled, as cleanup: `call` sends nothing on an aborted signal, and the recording would outlive
    // the one handle that could stop it.
    const timeoutMs = Math.max(Math.min(operation.timeoutMs, VIDEO_CALL_MS), ORPHAN_STOP_MS);
    const label = 'stop the video';
    const stopped = await call(() => this.driver().stopVideo(segment.id, timeoutMs), { label, input: false, signal: new AbortController().signal, timeoutMs }).then(
      () => undefined,
      (cause: unknown) => translate(cause, label, false),
    );
    const written = stopped === undefined && (await stat(absolute).then((file) => file.size > 0, () => false));
    if (written) {
      this.segments.push({ path: segment.relative, startedAt: segment.startedAt });
      return;
    }
    await rm(absolute, { force: true });
    this.missed ??= stopped ?? new EngineError('ENGINE_FAILURE', `the recording of window ${segment.windowId} got no frame before it stopped`, { retryable: false });
  }
}
