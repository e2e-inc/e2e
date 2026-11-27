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
    this.wanted = true;
    this.artifactsDir = artifactsDir;
    this.segments = [];
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
   * the read or launch that called it.
   */
  async follow(windowId: string | undefined, operation: OperationContext): Promise<void> {
    if (!this.wanted || windowId === this.current?.windowId) return;
    await this.serially(() => this.switchTo(windowId, operation)).catch(() => undefined);
  }

  /** `stopVideo`: ends the current file and answers every file of the attempt, in order. */
  async end(operation: OperationContext): Promise<readonly VideoSegment[]> {
    if (!this.wanted) return [];
    this.wanted = false;
    await this.serially(() => this.switchTo(undefined, operation));
    const segments = this.segments;
    this.segments = [];
    return segments;
  }

  /** Stops a recording still running when the attempt ends without `stopVideo`, and keeps nothing of it. */
  async abandon(operation: OperationContext): Promise<void> {
    this.wanted = false;
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

  /** Ends the current file and keeps it when the driver wrote one, even one it could not finish cleanly. */
  private async finish(operation: OperationContext): Promise<void> {
    const segment = this.current;
    if (segment === undefined || this.artifactsDir === undefined) return;
    this.current = undefined;
    const absolute = path.join(this.artifactsDir, segment.relative);
    // The stop is bounded: a file the driver did not finish in time is judged by what it holds. It goes even when the
    // operation was cancelled, as cleanup: `call` sends nothing on an aborted signal, and the recording would outlive
    // the one handle that could stop it.
    const timeoutMs = Math.max(Math.min(operation.timeoutMs, VIDEO_CALL_MS), ORPHAN_STOP_MS);
    await call(() => this.driver().stopVideo(segment.id, timeoutMs), { label: 'stop the video', input: false, signal: new AbortController().signal, timeoutMs }).catch(() => undefined);
    const written = await stat(absolute).then((file) => file.size > 0, () => false);
    if (written) this.segments.push({ path: segment.relative, startedAt: segment.startedAt });
    else await rm(absolute, { force: true });
  }
}
