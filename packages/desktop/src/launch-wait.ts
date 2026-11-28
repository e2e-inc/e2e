import { EngineError, type OperationContext } from '@e2e-dev/core/engine';
import { DriverFailure } from './driver.ts';
import { LAUNCH_POLL_MS, sleep } from './launch-ownership.ts';
import { describeLastRead, handOffClause, type WindowsRead } from './launch-report.ts';
import type { ProjectedScreen } from './nodes.ts';

/** How long a launch waits for its process, and then for the app's window to become readable, before it reports why it did not. */
export const LAUNCH_READY_MS = 10_000;

/** The cause of a read of an app that quit since it launched. */
export const QUIT = new Error('the app quit');

/** What the launch wait asks of the surface that launched the app. */
export interface LaunchedApp {
  readonly app: string;
  /** Whether the app was launched in the foreground. */
  readonly foreground: boolean;
  /** The copies of the app that ran before the launch. */
  readonly runningBefore: readonly number[];
  /** One read of the app's windows, with `timeoutMs` shared by its calls. */
  read(timeoutMs: number): Promise<WindowsRead>;
  /** The screen of a read; throws the retryable `NODE_STALE` of one that found windows and could read none. */
  readable(read: WindowsRead): ProjectedScreen | undefined;
  /** Whether the launched process is gone, which the surface has then forgotten. */
  exited(): Promise<boolean>;
  screenLocked(): boolean | null;
}

/**
 * Waits until the launched app's window can be read: a window exists soon
 * after the launch, but its accessibility element can arrive a moment
 * later, and an observation then would show the agent an empty screen. A
 * window that stays unreadable for `LAUNCH_READY_MS` fails the open: every
 * later step would only time out on an empty screen. The last read gets as
 * long as the slowest finished read, within the operation's budget, so a
 * read that runs out of time was slow, not one the wait ended mid-read.
 * Any other failure of a read is reported as it is. An app in the
 * background is never brought forward: one that opens no window there (a
 * document-based app opens its first one only when it comes forward)
 * fails the open, and needs `--headed` or `physicalInput`.
 */
export async function windowReadable(operation: OperationContext, launched: LaunchedApp): Promise<void> {
  const { app } = launched;
  const operationMs = operation.timeoutMs;
  const budgetBound = operationMs < LAUNCH_READY_MS;
  const startedAt = Date.now();
  const deadline = startedAt + Math.min(operationMs, LAUNCH_READY_MS);
  // No read runs past the operation's own deadline: the extra time a last read gets comes from the operation's budget, never beyond it.
  const cap = startedAt + operationMs;
  // How long the slowest read that finished took: the time a read starting at the deadline still gets, as in core's `ReadWindow`.
  let slowestMs = 0;
  let sawWindow = false;
  // Whether a read finished and listed no window of the app: only that shows it opened none. A read that ran out of time saw nothing.
  let listedNone = false;
  let timedOut = false;
  // Whether the read that ran out of time gave no answer, so `last` is a read before it.
  let cutOff = false;
  // What the newest read that finished came to, for the error of a window that never became readable.
  let last: WindowsRead | DriverFailure | undefined;
  while (Date.now() < deadline) {
    if (operation.signal.aborted) throw new EngineError('CANCELLED', `opening ${app} was cancelled`, { retryable: false });
    let screen: ProjectedScreen | undefined;
    let current: WindowsRead | undefined;
    const readStartedAt = Date.now();
    // Each read may run until the wait's deadline plus the slowest finished read, capped by the operation's deadline, so a slow last read still finishes.
    const budgetMs = Math.max(1, Math.min(Math.max(0, cap - readStartedAt), deadline + slowestMs - readStartedAt));
    try {
      current = await launched.read(budgetMs);
      slowestMs = Math.max(slowestMs, Date.now() - readStartedAt);
      last = current;
      screen = launched.readable(current);
    } catch (cause) {
      const answered = cause instanceof EngineError && cause.cause instanceof DriverFailure ? cause.cause : undefined;
      if (current === undefined && answered !== undefined) last = answered;
      // The last read ran out of budget: the window never became readable in time.
      if (cause instanceof EngineError && cause.code === 'OPERATION_TIMEOUT') {
        // A read the operation's deadline left less than one poll tick, or the slowest finished read, and that gave no answer timed out because the wait did, not because the app stopped answering: the read before it stays the last one reported. A read granted a slowest read's time that still timed out was slower than every finished read.
        const waitEnded = current === undefined && answered === undefined && last !== undefined && budgetMs < Math.max(LAUNCH_POLL_MS, slowestMs);
        timedOut = !waitEnded;
        // A read the deadline cut off answered nothing, so the newest read that finished stays the one reported.
        cutOff = current === undefined && answered === undefined && !waitEnded;
        break;
      }
      // A window not readable yet, or one replaced while it was read, is what this wait looks at below; so is an app that quit.
      const stale = cause instanceof EngineError && cause.code === 'NODE_STALE' && cause.retryable;
      if (!(cause instanceof EngineError && (stale || cause.cause === QUIT))) throw cause;
      // A read that answered with a retryable failure finished too: its time counts toward the slowest read, as a resolved read's does.
      slowestMs = Math.max(slowestMs, Date.now() - readStartedAt);
      if (stale) sawWindow = true;
    }
    // A window whose root the app did not answer for is there but not readable yet, which is what this wait is for.
    if (screen !== undefined && !screen.rootUnread) return;
    if (screen !== undefined) sawWindow = true;
    else if (current !== undefined) listedNone = true;
    // An app that quit (or crashed) on its own never shows a window.
    if (await launched.exited()) {
      throw new EngineError('ENGINE_FAILURE', `${app} quit right after it launched, before it showed a window${handOffClause(': ', launched.runningBefore)}`, { retryable: false });
    }
    await sleep(Math.min(LAUNCH_POLL_MS, Math.max(deadline - Date.now(), 0)), operation.signal);
  }
  // The open's own budget ran out first: that is a timeout, not a window that cannot be read.
  if (budgetBound) throw new EngineError('OPERATION_TIMEOUT', `${app} launched, but the open ran out of time before its window could be read`, { retryable: false });
  // A locked screen hides every window from accessibility: neither read tells it from an app with no window, so macOS is asked.
  if (launched.screenLocked() === true) {
    throw new EngineError('ENGINE_FAILURE', `${app} launched, but the Mac's screen is locked, so no window can be read through accessibility; unlock it and run again`, { retryable: false });
  }
  if (!sawWindow && listedNone && !launched.foreground) {
    throw new EngineError(
      'ENGINE_FAILURE',
      `${app} launched in the background and opened no window. Some apps, such as document-based ones, show a window only once they come forward; run with --headed for them, or set desktop({ physicalInput: true })`,
      { retryable: false },
    );
  }
  // In the foreground there is no background to blame: the app listed no window at all.
  if (!sawWindow && listedNone) {
    throw new EngineError('ENGINE_FAILURE', `${app} launched, but listed no window within ${LAUNCH_READY_MS / 1000} s: it may open none (a menu-bar app) or take longer to show its first window`, { retryable: false });
  }
  throw new EngineError('ENGINE_FAILURE', `${app} launched, but its window cannot be read through accessibility${timedOut ? ' (a read ran out of time)' : ''}: ${describeLastRead(last, cutOff)}. The window may be off screen`, {
    retryable: false,
  });
}
