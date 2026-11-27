/**
 * How `desktop.useWindow()` picks a window: what its argument names, and the
 * wait for a title, which a window still opening does not have listed yet.
 */

import { types } from 'node:util';
import { describePattern, EngineError, matchesText, toTextPattern, type OperationContext, type TextMatch, type TextPattern } from '@e2e-dev/core/engine';
import { withDeadline } from './deadline.ts';
import { sleep } from './launch-ownership.ts';

/** How often the wait for a title lists the windows again. */
const WINDOW_POLL_MS = 100;

/** One window of the app under test, as `desktop.windows()` lists it. */
export interface DesktopWindow {
  /** The window server's id of the window, valid while the window stays open. */
  readonly id: string;
  readonly title: string;
  readonly focused: boolean;
}

/** What `desktop.useWindow()` takes: a title, matched as `screen` matches text, or a window `desktop.windows()` listed. */
export type WindowArgument = TextMatch | Pick<DesktopWindow, 'id'>;

/** What `desktop.useWindow()` picks a window by: the id `desktop.windows()` gave, or its title. */
export type WindowChoice = { readonly id: string } | { readonly title: TextPattern };

type Budget = Pick<OperationContext, 'signal' | 'timeoutMs'>;

/** What picking a window reads of the app. */
export interface WindowSource {
  /** The app's name, as a message says it. */
  readonly app: string;
  /** Whether the engine has an app open. */
  opened(): boolean;
  /** The app's windows now. `strict` refuses an app that quit, and a list that failed while it runs is a retryable `NODE_STALE`, not an app with no window. */
  list(operation: Budget, strict: boolean): Promise<readonly DesktopWindow[]>;
  /** Whether the Mac's screen is locked, which lists none of the app's windows. */
  locked(): boolean;
}

/** What the argument names; undefined when it is neither a title nor a listed window. */
export function windowChoice(window: unknown): WindowChoice | undefined {
  if (typeof window === 'string' || types.isRegExp(window)) return { title: toTextPattern(window) };
  if (typeof window === 'object' && window !== null && 'id' in window && typeof window.id === 'string') return { id: window.id };
  return undefined;
}

/** A choice as a step label shows it: the title, and nothing for an id. */
export function choiceLabel(choice: WindowChoice | undefined): string {
  return choice !== undefined && 'title' in choice ? describePattern(choice.title) : '';
}

function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

/** The id of the window a choice names: an id must be listed now, a title is waited for within the operation's budget. */
export async function chosenWindow(choice: WindowChoice, operation: Budget, source: WindowSource): Promise<string> {
  if ('title' in choice) return titledWindow(choice.title, operation, source);
  const windows = await source.list(operation, false);
  if (windows.some((window) => window.id === choice.id)) return choice.id;
  throw notActionable(`the app has no window with the id ${choice.id}; desktop.windows() lists the ones it has, and desktop.useWindow('Title') picks one by its title`);
}

/** The id of the one window with the title, listed again until it shows or the budget is spent. */
async function titledWindow(title: TextPattern, operation: Budget, source: WindowSource): Promise<string> {
  const text = describePattern(title);
  const waitMs = operation.timeoutMs;
  const budget = withDeadline(operation);
  let windows: readonly DesktopWindow[] = [];
  for (;;) {
    if (budget.signal.aborted) throw new EngineError('CANCELLED', `the wait for a window titled ${text} was cancelled`, { retryable: false });
    if (!source.opened()) throw new EngineError('INVALID_STATE', `desktop.useWindow(${text}) needs the app open; open it with app.open()`, { retryable: false });
    // The list after the budget is spent reads nothing, and still says an app that quit during the last pause did.
    const spent = budget.timeoutMs <= 0;
    try {
      windows = await source.list(budget, true);
    } catch (cause) {
      // A list cut off by the deadline ends the wait, and one the app was too busy to answer is asked for again: neither says more than the last list did.
      if (!(cause instanceof EngineError && (cause.code === 'OPERATION_TIMEOUT' || (cause.code === 'NODE_STALE' && cause.retryable)))) throw cause;
    }
    const matches = windows.filter((window) => matchesText(window.title, title));
    const [match] = matches;
    if (matches.length > 1) {
      const named = matches.map((window) => `${JSON.stringify(window.title)} (id ${window.id})`).join(', ');
      throw notActionable(`${matches.length} windows of ${source.app} are titled ${text}: ${named}; pass the one meant from desktop.windows()`);
    }
    if (match !== undefined) return match.id;
    if (spent) break;
    await sleep(Math.min(WINDOW_POLL_MS, budget.timeoutMs), budget.signal);
  }
  // A locked screen lists none of the app's windows, which must not read as an app with none open.
  if (windows.length === 0 && source.locked()) {
    throw notActionable(`the Mac's screen is locked, so no window of ${source.app} can be listed to find the one titled ${text}; unlock it and run again`);
  }
  const has = windows.length === 0 ? 'it has no open window' : `its windows are ${windows.map((window) => JSON.stringify(window.title)).join(', ')}`;
  throw notActionable(`${source.app} showed no window titled ${text} within ${waitMs} ms; ${has}`);
}
