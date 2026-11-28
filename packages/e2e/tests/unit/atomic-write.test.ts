/** Replacing files that must agree: all of them, or on an error none. */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFilesAtomic } from '@e2e-dev/core/lib/internal/atomic-write';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-atomic-write-'));
  tempDirs.push(directory);
  return directory;
}

describe('writeFilesAtomic', () => {
  it('replaces every file', async () => {
    const directory = await makeDir();
    await writeFile(path.join(directory, 'a.yml'), 'old a', 'utf8');
    await writeFilesAtomic([
      { path: path.join(directory, 'a.yml'), content: 'new a' },
      { path: path.join(directory, 'a.lock.json'), content: 'new lock' },
    ]);
    expect(await readFile(path.join(directory, 'a.yml'), 'utf8')).toBe('new a');
    expect(await readFile(path.join(directory, 'a.lock.json'), 'utf8')).toBe('new lock');
    expect((await readdir(directory)).toSorted()).toEqual(['a.lock.json', 'a.yml']);
  });

  it('replaces nothing when asked not to once the temporaries are written', async () => {
    const directory = await makeDir();
    await writeFile(path.join(directory, 'a.yml'), 'old a', 'utf8');
    const written = await writeFilesAtomic(
      [
        { path: path.join(directory, 'a.yml'), content: 'new a' },
        { path: path.join(directory, 'a.lock.json'), content: 'new lock' },
      ],
      { beforeReplace: async () => false },
    );
    expect(written).toBe(false);
    expect(await readFile(path.join(directory, 'a.yml'), 'utf8')).toBe('old a');
    expect(await readdir(directory)).toEqual(['a.yml']);
  });

  it('puts back the files it replaced when a later one fails', async () => {
    const directory = await makeDir();
    await writeFile(path.join(directory, 'a.yml'), 'old a', 'utf8');
    // Dated an hour back: a file written again since is newer, whatever inode it gets.
    const old = new Date(Date.now() - 3_600_000);
    await utimes(path.join(directory, 'a.yml'), old, old);
    // A non-empty directory where the second file goes: it fails once the first file is already replaced.
    await mkdir(path.join(directory, 'a.lock.json', 'inside'), { recursive: true });
    await expect(
      writeFilesAtomic([
        { path: path.join(directory, 'a.yml'), content: 'new a' },
        { path: path.join(directory, 'a.lock.json'), content: 'new lock' },
      ]),
    ).rejects.toThrow();
    expect(await readFile(path.join(directory, 'a.yml'), 'utf8')).toBe('old a');
    // Written again since: it was replaced, then its content put back.
    expect((await stat(path.join(directory, 'a.yml'))).mtimeMs).toBeGreaterThan(old.getTime() + 60_000);
    expect((await readdir(directory)).toSorted()).toEqual(['a.lock.json', 'a.yml']);
  });

  it('removes a file it created when a later one fails', async () => {
    const directory = await makeDir();
    await mkdir(path.join(directory, 'a.lock.json', 'inside'), { recursive: true });
    await expect(
      writeFilesAtomic([
        { path: path.join(directory, 'a.yml'), content: 'new a' },
        { path: path.join(directory, 'a.lock.json'), content: 'new lock' },
      ]),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['a.lock.json']);
  });
});
