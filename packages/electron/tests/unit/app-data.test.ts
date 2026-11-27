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
  it('makes a private directory and deletes it', async () => {
    const data = new AppData();
    const directory = data.create();
    expect(statSync(directory).isDirectory()).toBe(true);
    await data.discard(directory);
    expect(existsSync(directory)).toBe(false);
    await data.close();
  });

  it('keeps a directory a process still holds, without failing, and deletes it with the next one', async () => {
    const held = new Set(['first']);
    const { calls, remove } = removal(held);
    const data = new AppData(remove);
    await data.discard('first');
    // Still held: tried once more, with no waiting, before the next directory.
    await data.discard('second');
    held.clear();
    await data.discard('third');
    expect(calls).toEqual(['first:5', 'first:0', 'second:5', 'first:0', 'third:5']);
    await data.close();
    expect(calls).toHaveLength(5);
  });

  it('fails at the worker\'s end with the directories it could never delete', async () => {
    const { calls, remove } = removal(new Set(['stuck']));
    const data = new AppData(remove);
    await data.discard('stuck');
    await expect(data.close()).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/could not delete the app's data in stuck: EPERM/) });
    expect(calls).toEqual(['stuck:5', 'stuck:5']);
  });
});
