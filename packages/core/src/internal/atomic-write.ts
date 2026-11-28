/**
 * Atomic file replacement: the content goes to a sibling temporary file,
 * which is then renamed over the target, so a crash or a concurrent writer
 * cannot leave a torn file behind. The temporary name carries random bytes
 * rather than the pid and the clock: two writers racing on one path in the
 * same millisecond would otherwise pick the same name, and the first rename
 * would pull the file out from under the second.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export interface AtomicWriteOptions {
  /** Mode for a file created by the write; the platform default when absent. */
  readonly mode?: number;
}

function temporaryPath(filePath: string): string {
  return `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
}

/** Writes `content` to `filePath` atomically; a failed write leaves no temporary file behind. */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporary = temporaryPath(filePath);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: options.mode });
    await rename(temporary, filePath);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/**
 * Replaces several files together: every content goes to its temporary file
 * first, then each is renamed over its target in order. A failure leaves the
 * targets as they were, putting back the previous content of any already
 * replaced (or removing it when it did not exist), so files that must agree
 * are never left half-written by an error; only a crash between two renames
 * can still part them.
 */
export async function writeFilesAtomic(
  files: readonly { readonly path: string; readonly content: string }[],
  options: AtomicWriteOptions & {
    /** Asked once every temporary is written, just before the first rename: false replaces nothing. */
    readonly beforeReplace?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const temporaries = files.map((file) => temporaryPath(file.path));
  try {
    for (const [index, file] of files.entries()) {
      await writeFile(temporaries[index]!, file.content, { encoding: 'utf8', mode: options.mode });
    }
    if (options.beforeReplace !== undefined && !(await options.beforeReplace())) return false;
    // Each file's previous content, read just before it is replaced: what a failure puts back.
    const previous: (Buffer | undefined)[] = [];
    for (const [index, file] of files.entries()) {
      try {
        previous.push(await readFile(file.path).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return undefined;
          throw cause;
        }));
        await rename(temporaries[index]!, file.path);
      } catch (cause) {
        for (const [replaced, earlier] of files.slice(0, index).entries()) {
          const content = previous[replaced];
          await (content === undefined ? unlink(earlier.path) : writeFileAtomic(earlier.path, content, options)).catch(() => undefined);
        }
        throw cause;
      }
    }
    return true;
  } finally {
    // A renamed temporary is gone already; the rest are what a failure left.
    await Promise.all(temporaries.map((temporary) => unlink(temporary).catch(() => undefined)));
  }
}

/** The synchronous twin, for a store that is read and written from synchronous code. */
export function writeFileAtomicSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
  const temporary = temporaryPath(filePath);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: options.mode });
    renameSync(temporary, filePath);
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw cause;
  }
}
