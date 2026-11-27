import type { DriverFailure, RawWindow } from './driver.ts';
import { alive } from './launch-ownership.ts';
import type { ProjectedScreen } from './nodes.ts';

/** What one read of the app's windows came to: the windows it listed, and what reading them gave. */
export interface WindowsRead {
  readonly windows: readonly RawWindow[];
  /** How many of the listed windows the read was asked for. */
  readonly candidates: number;
  /** The failure of each window accessibility had no element for. */
  readonly failures: readonly DriverFailure[];
  /** The first window that could be read; undefined when none could, or none was asked for. */
  readonly screen?: ProjectedScreen;
}

/**
 * One clause, for the error of an app whose window never became readable,
 * on the last read of the launch wait: what it listed and could not read,
 * or the failure of a read that listed nothing. Undefined is a wait none of
 * whose reads finished.
 */
export function describeLastRead(read: WindowsRead | DriverFailure | undefined): string {
  if (read === undefined) return 'no read listed its windows';
  const failed = (failure: DriverFailure): string => `the last read failed with ${failure.code} (${failure.message.replace(/\.$/, '')})`;
  if (read instanceof Error) return failed(read);
  const listed = read.windows.length;
  const unreadable = read.windows.filter((window) => window.accessible === false).length + read.failures.length;
  const rootless = read.screen?.rootUnread === true ? ', 1 whose root element did not answer' : '';
  const system = read.windows.filter((window) => window.system === true).length;
  const failure = read.failures.at(-1);
  return `the last read listed ${listed} ${listed === 1 ? 'window' : 'windows'}, ${unreadable} unreadable${rootless}${system === 0 ? '' : `, ${system} a system dialog`}${failure === undefined ? '' : `; ${failed(failure)}`}`;
}

/**
 * What a copy that ran before the launch may explain, and what to do about
 * it, after `lead`; empty when none of `before` still runs. Only the app
 * knows whether it runs one copy at a time, so that stays a condition: the
 * copy may be one another run launched.
 */
export function handOffClause(lead: string, before: readonly number[]): string {
  const copies = before.filter(alive);
  if (copies.length === 0) return '';
  const processes = `${copies.length === 1 ? 'process' : 'processes'} ${copies.join(', ')}`;
  return `${lead}a copy of it was already running (${processes}), and an app that runs one copy at a time hands the launch to that copy and exits. If this app does, quit the running copy first: the engine drives only a copy it launched`;
}
