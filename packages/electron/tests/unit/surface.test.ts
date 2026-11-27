import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { EngineAttemptContext } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { AppData } from '../../src/app-data.ts';
import { resolveOptions } from '../../src/options.ts';
import { ElectronSurface } from '../../src/surface.ts';

const cleanup = { signal: new AbortController().signal, timeoutMs: 50 };
const attempt = {} as unknown as EngineAttemptContext;

describe('an attempt\'s app data', () => {
  it('ends the attempt though a Windows process still holds its data, and deletes it once the process lets go', async () => {
    let held = true;
    const directories: string[] = [];
    const data = new AppData(async (directory, retries) => {
      directories.push(directory);
      if (held) throw Object.assign(new Error(`EPERM, Permission denied: '${directory}'`), { code: 'EPERM' });
      await rm(directory, { recursive: true, force: true, maxRetries: retries });
    }, 'win32');
    const surface = new ElectronSurface(resolveOptions({}), data);
    await surface.startAttempt(attempt);
    await surface.endAttempt(cleanup);
    const [first] = directories;
    expect(first !== undefined && existsSync(first)).toBe(true);
    // The next attempt has a directory of its own, and its end deletes both.
    held = false;
    await surface.startAttempt(attempt);
    await surface.endAttempt(cleanup);
    expect(new Set(directories).size).toBe(2);
    expect(directories.some((directory) => existsSync(directory))).toBe(false);
    await surface.dispose(cleanup);
  });

  it('fails the worker\'s end with the data nothing could delete', async () => {
    const stuck: string[] = [];
    const data = new AppData((directory) => {
      stuck.push(directory);
      return Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    }, 'win32');
    const surface = new ElectronSurface(resolveOptions({}), data);
    await surface.startAttempt(attempt);
    const failure: unknown = await surface.dispose(cleanup).then(() => undefined, (error: unknown) => error);
    const [directory] = stuck;
    expect(directory).toBeDefined();
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining(directory ?? '') });
    await rm(directory ?? '', { recursive: true, force: true });
  });
});
