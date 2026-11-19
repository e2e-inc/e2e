/**
 * The attempt's video as its browser provider records it: one recording of
 * the browser for the whole attempt, whichever pages open and close in it,
 * ended by `stopProviderRecording` into the attempt's one segment, a file in
 * its `video` directory or a link.
 */

import { stopProviderRecording, type VideoSegment } from '@e2e-dev/core/engine';
import type { LeaseRecording } from '../provider.ts';
import { abortError } from '../errors.ts';
import type { AttemptVideo } from './attempt-video.ts';

/** How long a recording that started after its attempt gave up gets to stop. */
const LATE_STOP_MS = 10_000;

export class ProviderVideo implements AttemptVideo {
  readonly closeStep = 'provider video';
  private started: LeaseRecording | undefined;
  /** The stop in flight, shared: a close that retries while a timed-out stop is still running waits for it instead of stopping twice. */
  private stopping: Promise<readonly VideoSegment[]> | undefined;

  constructor(
    private readonly record: (signal: AbortSignal) => Promise<LeaseRecording>,
    private readonly artifactsDir: string,
    /** Aborts when the attempt closes, after which no recording is kept. */
    private readonly lifetime: AbortSignal,
  ) {}

  /**
   * Starts the provider's recording. One that arrives once `signal` aborted
   * (a start that outlived its budget) or the attempt ended is stopped at
   * once and never kept, and never replaces the handle of a recording
   * started after it.
   */
  async start(signal: AbortSignal): Promise<void> {
    const wanted = AbortSignal.any([signal, this.lifetime]);
    const started = await this.record(wanted);
    if (!wanted.aborted) {
      this.started = started;
      return;
    }
    await this.stopLease(started, AbortSignal.timeout(LATE_STOP_MS)).catch(() => undefined);
    throw abortError(wanted, 'video');
  }

  /** Nothing: the provider records the browser, whichever tab the attempt shows. */
  async contextOpened(): Promise<void> {}

  /** Nothing: the recording goes on when a tab closes. */
  async contextClosing(): Promise<void> {}

  /** Nothing: the recording goes on when a tab closed. */
  async contextClosed(): Promise<void> {}

  /**
   * Stops the recording as the attempt's one segment; nothing when none was
   * started. A stop that failed keeps the recording, so the attempt's close
   * tries once more instead of leaving it running on a browser later
   * attempts share.
   */
  stop(signal: AbortSignal): Promise<readonly VideoSegment[]> {
    const started = this.started;
    if (started === undefined) return Promise.resolve([]);
    this.stopping ??= this.stopLease(started, signal).then(
      (segment) => {
        if (this.started === started) this.started = undefined;
        return [segment];
      },
    ).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /**
   * Stops, within `budgetMs`, a recording the attempt never collected, best
   * effort: the attempt keeps nothing of it. A stop that fails keeps the
   * handle, so the recording is never marked stopped while it may still run.
   */
  async close(budgetMs: number): Promise<void> {
    await this.stop(AbortSignal.timeout(budgetMs)).catch(() => undefined);
  }

  /** Ends one of the provider's recordings as a segment of the attempt. */
  private stopLease(started: LeaseRecording, signal: AbortSignal): Promise<VideoSegment> {
    return stopProviderRecording(started.recording, {
      artifactsDir: this.artifactsDir,
      provider: started.provider,
      leaseId: started.leaseId,
      signal,
    });
  }
}
