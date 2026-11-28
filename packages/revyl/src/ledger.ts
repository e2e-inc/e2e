/**
 * The Revyl sessions and computers a run holds open, one marker file per
 * session under the system temp directory. Revyl sessions carry no tags to
 * find a run's by, but the runner and its workers share one machine: a
 * process writes a marker before it starts a session and removes it once the
 * session is stopped, so the markers left at the end of the run name the
 * sessions of workers that died, and a run's leftover directory names the
 * computers of a runner that died.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A session id as a file name: the UUID the provider picks, never anything that could leave the run's directory. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

/** The run's markers for one target: a path built from ids, never trusted as one. */
function dirFor(runId: string, targetName: string): string {
  const run = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  const target = createHash('sha256').update(targetName).digest('hex').slice(0, 16);
  return path.join(tmpdir(), 'e2e-revyl', run, target);
}

/** The marker of one session; an id the provider would not pick is refused rather than written. */
function markerFor(runId: string, targetName: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not one the provider picks`);
  return path.join(dirFor(runId, targetName), sessionId);
}

/** Whether a filesystem error says the path does not exist. */
function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/**
 * Records that the run is starting `sessionId` for `targetName`, before it
 * asks Revyl for the session. Rejects when the marker cannot be written, so
 * the caller starts no session the sweep could not find.
 */
export async function remember(runId: string, targetName: string, sessionId: string): Promise<void> {
  const marker = markerFor(runId, targetName, sessionId);
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, '', { mode: 0o600 });
}

/** The runs that hold markers, by their directory names: the run id with anything but letters, digits, `_`, and `-` replaced by `_`. */
export async function runs(): Promise<string[]> {
  const entries = await readdir(path.join(tmpdir(), 'e2e-revyl'), { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });
  return entries.flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
}

/** Records that `sessionId` was stopped; called only after Revyl confirmed it. */
export async function forget(runId: string, targetName: string, sessionId: string): Promise<void> {
  await rm(markerFor(runId, targetName, sessionId), { force: true });
}

/** The sessions the run started for `targetName` and never recorded as stopped. Rejects on any read error but a missing directory. */
export async function remembered(runId: string, targetName: string): Promise<string[]> {
  const entries = await readdir(dirFor(runId, targetName), { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });
  return entries.flatMap((entry) => (entry.isFile() && SESSION_ID.test(entry.name) ? [entry.name] : []));
}

/** Removes the target's directory and then the run's, each only once empty, so a marker kept for a failed stop survives. */
export async function prune(runId: string, targetName: string): Promise<void> {
  const dir = dirFor(runId, targetName);
  for (const empty of [dir, path.dirname(dir)]) {
    await rmdir(empty).catch((cause: unknown) => {
      if (isMissing(cause) || (cause instanceof Error && 'code' in cause && (cause.code === 'ENOTEMPTY' || cause.code === 'EEXIST'))) return;
      throw cause;
    });
  }
}
