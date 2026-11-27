/**
 * The directories the app keeps its data in: one per attempt, and a new one
 * after `app.clearState()`. A directory is deleted once the app that wrote
 * it is gone, which on Windows can be later than the app's exit: a file a
 * process still holds open cannot be deleted there, and a quitting Electron
 * app's processes linger for seconds on a busy machine. Such a directory is
 * deleted with the next one, or at the worker's end.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Deadline, EngineError } from '@e2e-dev/core/engine';

/** How often the delete of a directory is tried again in one pass, 100 ms longer apart each time: 1.5 s in all. */
const RETRIES = 5;

/** What a delete fails with on Windows while a process holds a file of the directory open. */
const HELD: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** Deletes a directory and what it holds, trying again `retries` times while a process holds a file in it. */
type Remove = (directory: string, retries: number) => Promise<void>;

const removeDirectory: Remove = (directory, retries) => rm(directory, { recursive: true, force: true, maxRetries: retries, retryDelay: 100 });

export class AppData {
  /** Directories a process still held when their delete was tried, oldest first. */
  private readonly held: string[] = [];

  constructor(
    private readonly remove: Remove = removeDirectory,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** A new, empty directory only this user can read. */
  create(): string {
    return mkdtempSync(path.join(tmpdir(), 'e2e-electron-'));
  }

  /**
   * Deletes a directory the app is done with, and the ones before it that
   * were still held then. A directory a Windows process holds is kept for
   * the next call rather than failing this one; any other failure is the
   * caller's.
   */
  async discard(directory: string): Promise<void> {
    await this.sweep(0);
    try {
      await this.remove(directory, RETRIES);
    } catch (cause) {
      if (!this.isHeld(cause)) throw cause;
      this.held.push(directory);
    }
  }

  /**
   * The worker's end, and the last chance: tries the held directories until
   * `timeoutMs` is over, then fails with the ones that are still there.
   */
  async close(timeoutMs: number): Promise<void> {
    const deadline = new Deadline(timeoutMs);
    let cause = await this.sweep(RETRIES);
    while (cause !== undefined && !deadline.expired()) cause = await this.sweep(RETRIES);
    if (cause === undefined) return;
    throw new EngineError('ENGINE_FAILURE', `could not delete the app's data in ${this.held.join(', ')}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
  }

  private isHeld(cause: unknown): boolean {
    return this.platform === 'win32' && cause instanceof Error && 'code' in cause && typeof cause.code === 'string' && HELD.has(cause.code);
  }

  /** Tries the held directories again, and returns why the last one still there could not be deleted. */
  private async sweep(retries: number): Promise<unknown> {
    let failure: unknown;
    for (const directory of this.held.splice(0)) {
      try {
        await this.remove(directory, retries);
      } catch (cause) {
        this.held.push(directory);
        failure = cause;
      }
    }
    return failure;
  }
}
