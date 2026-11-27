import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppData } from '../../src/app-data.ts';

/** A delete that fails for the directories in `held`, as Windows does while a process has a file open in one. */
function removal(held: Set<string>): { readonly calls: string[]; readonly remove: (directory: string, retries: number) => Promise<void> } {
  const calls: string[] = [];
  return {
    calls,
    remove: (directory, retries) => {
      calls.push(`${directory}:${retries}`);
      return held.has(directory) ? Promise.reject(Object.assign(new Error(`EPERM, Permission denied: '${directory}'`), { code: 'EPERM' })) : Promise.resolve();
    },
  };
}

describe('app data', () => {
  it('makes a directory only this user can read, and deletes it', async () => {
    const data = new AppData();
    const directory = data.create();
    const { mode } = statSync(directory);
    // Windows has no mode bits: the temp directory's own access list keeps it private.
    if (process.platform !== 'win32') expect(mode & 0o777).toBe(0o700);
    await data.discard(directory);
    expect(existsSync(directory)).toBe(false);
    await data.close(1000);
  });

  it('keeps a directory a Windows process still holds, without failing, and deletes it with the next one', async () => {
    const held = new Set(['first']);
    const { calls, remove } = removal(held);
    const data = new AppData(remove, 'win32');
    await data.discard('first');
    // Still held: tried once more, with no waiting, before the next directory.
    await data.discard('second');
    held.clear();
    await data.discard('third');
    expect(calls).toEqual(['first:5', 'first:0', 'second:5', 'first:0', 'third:5']);
    await data.close(1000);
    expect(calls).toHaveLength(5);
  });

  it('fails the attempt for a delete that no waiting fixes: another platform, or another error', async () => {
    const { remove } = removal(new Set(['locked']));
    await expect(new AppData(remove, 'linux').discard('locked')).rejects.toMatchObject({ code: 'EPERM' });
    const denied = new AppData(() => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })), 'win32');
    await expect(denied.discard('locked')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('tries until the worker\'s cleanup budget is over, then fails with the directories still there', async () => {
    const held = new Set(['slow', 'stuck']);
    const { calls, remove } = removal(held);
    const data = new AppData(async (directory, retries) => {
      // The app lets go of the first directory while the worker's end is waiting, some passes in.
      if (calls.length >= 6) held.delete('slow');
      await remove(directory, retries);
    }, 'win32');
    await data.discard('slow');
    await data.discard('stuck');
    await expect(data.close(50)).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/could not delete the app's data in stuck: EPERM/) });
    // Deleted on a later pass, and not tried again after it.
    expect(calls.lastIndexOf('slow:5')).toBeGreaterThan(5);
    expect(calls.at(-1)).toBe('stuck:5');
  });
});
