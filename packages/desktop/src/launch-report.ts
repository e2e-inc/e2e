import type { DriverFailure, RawWindow } from './driver.ts';

/**
 * What the reads of a launch wait saw, for the error of an app whose window
 * never became readable: the newest window list, and the newest failure the
 * driver answered with.
 */
export class LaunchReads {
  private listed: number | undefined;
  private unreadable = 0;
  private system = 0;
  private failure: DriverFailure | undefined;

  /** A window list the driver answered with. */
  windows(windows: readonly RawWindow[]): void {
    this.listed = windows.length;
    this.unreadable = windows.filter((window) => window.accessible === false).length;
    this.system = windows.filter((window) => window.system === true).length;
  }

  /** A window of the newest list whose read failed. */
  unread(failure: DriverFailure): void {
    this.unreadable += 1;
    this.failure = failure;
  }

  /** A window list that failed. */
  unlisted(failure: DriverFailure): void {
    this.failure = failure;
  }

  /** One clause for the error message: what was listed, what could not be read, and the newest failure. */
  summary(): string {
    const failed = this.failure === undefined ? '' : `; the last read failed with ${this.failure.code} (${this.failure.message.replace(/\.$/, '')})`;
    if (this.listed === undefined) return `no read listed its windows${failed}`;
    const system = this.system === 0 ? '' : `, ${this.system} a system dialog`;
    return `the last read listed ${this.listed} ${this.listed === 1 ? 'window' : 'windows'}, ${this.unreadable} unreadable${system}${failed}`;
  }
}

/** The copies a launch found running that still run, from the `running_before` the driver answers with. */
export function stillRunning(before: unknown, alive: (pid: number) => boolean): readonly number[] {
  return Array.isArray(before) ? before.filter((pid): pid is number => typeof pid === 'number' && alive(pid)) : [];
}

/** Why a launch beside a running copy can leave no process to drive, and what to do about it; empty when none was running. */
export function handOff(copies: readonly number[]): string {
  if (copies.length === 0) return '';
  const processes = `${copies.length === 1 ? 'process' : 'processes'} ${copies.join(', ')}`;
  return `a copy of it was already running (${processes}), and an app that runs one copy at a time hands the launch to that copy and exits. The engine drives only a copy it launched, so quit the running one first`;
}
