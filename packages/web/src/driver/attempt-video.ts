/**
 * The attempt's video as the session and the engine's `artifacts` drive it,
 * whoever records it: the driver, one segment per tab the attempt shows
 * (`BidiVideo`), or the browser's provider, one recording of the browser
 * (`ProviderVideo`). An attempt has exactly one, chosen when it starts.
 */

import type { VideoSegment } from '@e2e-dev/core/engine';

/** The attempt's video, whoever records it. */
export interface AttemptVideo {
  /** What the attempt's close calls ending the recording, in the error of an end that hangs. */
  readonly closeStep: string;
  /** Starts recording. A start that finishes after `signal` aborted is stopped again, so no recording outlives the step that gave up on it. */
  start(signal: AbortSignal): Promise<void>;
  /** Finishes the recording and returns its segments. */
  stop(signal: AbortSignal): Promise<readonly VideoSegment[]>;
  /** The attempt shows `context`: a tab it opened, or the one it returned to. */
  contextOpened(context: string): Promise<void>;
  /** The shown tab is about to close. */
  contextClosing(): Promise<void>;
  /** The shown tab closed on its own. */
  contextClosed(): Promise<void>;
  /** Ends a recording the attempt's close found running; an end that leaves this machine gets `budgetMs`. */
  close(budgetMs: number): Promise<void>;
}
