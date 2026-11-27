import type { DriverFailure, RawWindow } from './driver.ts';

/**
 * What the reads of a launch wait saw, for the error of an app whose window
 * never became readable: the newest window list, and the newest failure the
 * driver answered with.
 */
export class LaunchReads {
  private listed: number | undefined;
  private unreadable = 0;
  private rootless = 0;
  private system = 0;
  private failure: DriverFailure | undefined;

  /** A window list the driver answered with: what the reads before it saw no longer holds. */
  windows(windows: readonly RawWindow[]): void {
    this.listed = windows.length;
    this.unreadable = windows.filter((window) => window.accessible === false).length;
    this.system = windows.filter((window) => window.system === true).length;
    this.rootless = 0;
    this.failure = undefined;
  }

  /** A window of the newest list that accessibility has no element for. */
  unread(failure: DriverFailure): void {
    this.unreadable += 1;
    this.failure = failure;
  }

  /** A window of the newest list that was read, but whose root element did not answer. */
  rootUnread(): void {
    this.rootless += 1;
  }

  /** A list, or a read of a window, the driver failed. */
  failed(failure: DriverFailure): void {
    this.failure = failure;
  }

  /** One clause for the error message: what was listed, what could not be read, and the newest failure. */
  summary(): string {
    const failed = this.failure === undefined ? '' : `; the last read failed with ${this.failure.code} (${this.failure.message.replace(/\.$/, '')})`;
    if (this.listed === undefined) return `no read listed its windows${failed}`;
    const rootless = this.rootless === 0 ? '' : `, ${this.rootless} whose root element did not answer`;
    const system = this.system === 0 ? '' : `, ${this.system} a system dialog`;
    return `the last read listed ${this.listed} ${this.listed === 1 ? 'window' : 'windows'}, ${this.unreadable} unreadable${rootless}${system}${failed}`;
  }
}

/** The copies a launch found running that still run, from the `running_before` the driver answers with. */
export function stillRunning(before: unknown, alive: (pid: number) => boolean): readonly number[] {
  return Array.isArray(before) ? before.filter((pid): pid is number => typeof pid === 'number' && alive(pid)) : [];
}

/**
 * What a copy that ran before the launch may explain, and what to do about it; empty when none was running. Only
 * the app knows whether it runs one copy at a time, so that stays a condition: the copy may be one another run launched.
 */
export function handOff(copies: readonly number[]): string {
  if (copies.length === 0) return '';
  const processes = `${copies.length === 1 ? 'process' : 'processes'} ${copies.join(', ')}`;
  return `a copy of it was already running (${processes}), and an app that runs one copy at a time hands the launch to that copy and exits. If this app does, quit the running copy first: the engine drives only a copy it launched`;
}
