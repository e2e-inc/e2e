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
import { EngineError } from '@e2e-dev/core/engine';

/** How often the delete of a directory just left is tried again, 100 ms longer apart each time. */
const RETRIES = 5;

/** Deletes a directory and what it holds, trying again `retries` times while a process holds a file in it. */
type Remove = (directory: string, retries: number) => Promise<void>;

const removeDirectory: Remove = (directory, retries) => rm(directory, { recursive: true, force: true, maxRetries: retries, retryDelay: 100 });

export class AppData {
  /** Directories whose delete failed, oldest first. */
  private readonly held: string[] = [];

  constructor(private readonly remove: Remove = removeDirectory) {}

  /** A new, empty directory only this user can read. */
  create(): string {
    return mkdtempSync(path.join(tmpdir(), 'e2e-electron-'));
  }

  /**
   * Deletes a directory the app is done with, and the ones before it that
   * could not be deleted then. Never fails: a directory still held is kept
   * for the next call.
   */
  async discard(directory: string): Promise<void> {
    await this.sweep(0);
    try {
      await this.remove(directory, RETRIES);
    } catch {
      this.held.push(directory);
    }
  }

  /** The worker's end, and the last chance: fails with the directories that are still there. */
  async close(): Promise<void> {
    const cause = await this.sweep(RETRIES);
    if (cause === undefined) return;
    throw new EngineError('ENGINE_FAILURE', `could not delete the app's data in ${this.held.join(', ')}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
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
