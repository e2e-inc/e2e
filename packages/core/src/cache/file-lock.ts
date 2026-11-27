/**
 * A lock around one test's recording files, held for a read or a
 * read-modify-write. One test's recordings on two targets can be written by
 * two workers at once (an iOS and an Android run of the same test), and
 * each writer rewrites the whole pair, so without it the second rename
 * would drop the first writer's recording.
 *
 * In one process the holders queue on a promise; across processes on a
 * file created with `wx`, holding a token only its holder knows. A lock
 * file older than `STALE_MS` was left by a writer that died holding it,
 * since no holder keeps it longer than a file read and two writes, and is
 * taken over (`takeOver`).
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { sleep } from '../internal/time.ts';

/**
 * How long a waiter retries before it gives up; the caller treats that as
 * an unavailable store. Longer than `STALE_MS`, so a lock a holder that
 * just died left behind is taken over, not waited on in vain.
 */
const WAIT_MS = 35_000;
/** Pause between attempts to take the lock file. */
const RETRY_MS = 20;
/** Age past which a lock file is a dead writer's. */
const STALE_MS = 30_000;

/** The tail of the queue of holders in this process, by lock path. */
const queues = new Map<string, Promise<void>>();

/**
 * The token in each lock file this process holds, by lock path: how a
 * holder tells its file from a successor's. Not the inode, which a
 * filesystem may hand the successor's new file as soon as the old one goes.
 */
const heldTokens = new Map<string, string>();

/**
 * What a lock file this module writes holds: one holder's random token, or
 * nothing when the holder died between creating the file and writing it.
 */
const LOCK_TOKEN = /^(?:[a-f0-9]{32})?$/u;

/** Whether a file's text is a lock this module wrote; anything else at a lock path is another tool's. */
export function isLockToken(text: string): boolean {
  return LOCK_TOKEN.test(text);
}

/** Runs `operation` holding the lock at `lockPath`, and releases it however `operation` ends. */
export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  queues.set(lockPath, tail);
  await previous;
  try {
    heldTokens.set(lockPath, await acquire(lockPath));
    try {
      return await operation();
    } finally {
      // A holder paused past `STALE_MS` lost the lock to a takeover: the file there now is its successor's.
      if (await holdsFileLock(lockPath)) await unlink(lockPath).catch(() => undefined);
      heldTokens.delete(lockPath);
    }
  } finally {
    release();
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

/**
 * Whether this process still holds the lock at `lockPath` it took, or took
 * none there: a holder that stalled past `STALE_MS` (a suspended machine, a
 * starved CPU) may have been taken over, and must not then publish what it
 * read before or remove its successor's lock.
 */
export async function holdsFileLock(lockPath: string): Promise<boolean> {
  const token = heldTokens.get(lockPath);
  if (token === undefined) return true;
  return readFile(lockPath, 'utf8').then((text) => text === token, () => false);
}

/** Creates a lock file holding a fresh token, returning the token; undefined when the file exists already. */
async function create(lockPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw cause;
  }
  const token = randomBytes(16).toString('hex');
  try {
    await handle.writeFile(token, 'utf8');
  } catch (cause) {
    await unlink(lockPath).catch(() => undefined);
    throw cause;
  } finally {
    await handle.close();
  }
  return token;
}

/** Takes the lock file, returning its token. */
async function acquire(lockPath: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const token = await create(lockPath);
    if (token !== undefined) return token;
    if (Date.now() > deadline) throw new Error(`the replay cache file is locked by another writer: ${lockPath}`);
    // A takeover that could not remove the file (another user's, say) is retried like a live lock: paced, and only until the deadline.
    if (await isStale(lockPath)) await takeOver(lockPath);
    await sleep(RETRY_MS);
  }
}

/**
 * Whether the file at `path` is a lock a dead holder left: a token, as
 * every lock this module takes holds (or the empty file of a holder that
 * died before writing it), older than `STALE_MS`. Any other file
 * is another tool's, whatever its age, and is never removed.
 */
async function isStale(path: string): Promise<boolean> {
  // The token first, then the age: a holder that lets go and a new one that takes the path in between leave a
  // fresh file, which reads as live. The other order could pair the old file's age with the new one's token.
  if (!(await readFile(path, 'utf8').then(isLockToken, () => false))) return false;
  const stats = await stat(path).catch(() => undefined);
  return stats !== undefined && Date.now() - stats.mtimeMs > STALE_MS;
}

/**
 * Removes a stale lock file. Two waiters can see the same stale file, and
 * deleting it by path would let the slower one delete the lock the faster
 * one has just taken, so both would hold it. Only the waiter holding a
 * second, short-lived lock (`<lock>.takeover`) may delete it, after looking
 * again: whoever takes that lock next sees the lock file gone or fresh.
 */
async function takeOver(lockPath: string): Promise<void> {
  const guard = `${lockPath}.takeover`;
  if ((await create(guard)) === undefined) {
    // Held only for a stat and an unlink, so an old one was left by a waiter that died there.
    if (await isStale(guard)) await unlink(guard).catch(() => undefined);
    return;
  }
  try {
    if (await isStale(lockPath)) await unlink(lockPath).catch(() => undefined);
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}
