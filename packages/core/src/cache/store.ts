/**
 * Trace entry storage.
 *
 * The file store keeps one test's recordings in one reviewable YAML file
 * under `.e2e/cache/`, named for the test, beside a generated lock file
 * holding the keys (`recording-file.ts`, `recording-name.ts`). A read opens
 * the files of the test the step belongs to and finds the entry by its key;
 * a write rewrites the pair with the entry in its step's place, under a
 * lock, through temporary files and atomic renames. Reads fail closed: a
 * test's pair that is oversized or does not read is invalid for every step
 * of the test, never a repair, and a write or an eviction that would drop a
 * recording it cannot read leaves the pair alone.
 *
 * A step holds one recording per target. A write for a step and target
 * that already has one replaces it, under whatever key: a recording made
 * under a key the runner no longer derives would never replay again, and
 * one file per step keeps the review to what replays.
 *
 * The interface exists so a remote store, the cloud's shared cache, can
 * replace the filesystem without the harness noticing.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { writeFileAtomic, writeFilesAtomic } from '../internal/atomic-write.ts';
import { errorMessage } from '../internal/errors.ts';
import { canonicalJson, timestamp } from '../internal/ids.ts';
import { bound } from '../internal/text.ts';
import { holdsFileLock, withFileLock } from './file-lock.ts';
import {
  lockWithout,
  parseLockAlone,
  parseRecordingFile,
  recordingNamesTest,
  renderRecordingFile,
  stepIdentity,
  writtenByStore,
  type ParsedRecordingFile,
  type StoredRecording,
} from './recording-file.ts';
import { collisionName, RECORDING_NAME, recordingName } from './recording-name.ts';
import { MAX_TRACE_END_WAIT_MS, MAX_TRACE_TEST_ID_CHARS, type ActionTrace, type TraceEntry, type TraceProvenance } from './trace.ts';

/** Hard wire ceiling on one stored file, on both the read and the write path. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;

const KEY_HASH = /^[a-f0-9]{64}$/u;

/** One file of a pair as read: its whole text, or its first bytes and why the rest was not read. */
interface CappedFile {
  readonly bytes: number;
  readonly text?: string;
  readonly head?: string;
  readonly problem?: string;
}

/** The suffix a colliding test's name carries after its base name (`collisionName`). */
const COLLISION_SUFFIX = /--[a-f0-9]{12}$/u;

/** How much of a file over the size cap is read to tell whose it is (`writtenByStore`). */
const HEAD_BYTES = 4_096;

/** The reviewed file's extension. */
export const RECORDING_EXTENSION = '.yml';
/** The generated file's extension. */
export const LOCK_EXTENSION = '.lock.json';

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: TraceEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

/** Where the replay cache keeps its entries: the file store by default, or a host's own through `cache.store`. */
export interface CacheStore {
  readonly writable: boolean;
  /**
   * Reads one entry. `step` is the step the key was claimed for, as an entry
   * records it (`recordedFor`): a store may use it to find where the entry
   * lives, and may ignore it.
   */
  read(keyHash: string, step?: TraceProvenance): Promise<CacheReadResult>;
  /** Persists one trace, returning its size, or undefined when not written. */
  write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined>;
  /**
   * Evicts one entry, best-effort. Called when a replayed or just-recorded
   * flow is implicated in a failed attempt: the entry re-records on the next
   * pass instead of replaying a poisoned flow forever. Optional — a store
   * without eviction merely stays stale until the next confirmed write.
   * Resolves when the entry is absent; rejects when deletion fails so the
   * best-effort caller can avoid reporting a successful eviction. `step` is
   * as in `read`.
   */
  delete?(keyHash: string, step?: TraceProvenance): Promise<void>;
}

export interface FileCacheStoreOptions {
  readonly directory: string;
  /** File size cap for tests; production passes the wire ceiling, which clamps it. */
  readonly maxBytes: number;
  readonly writable: boolean;
}

/** One test's file pair as the store found it. */
export interface ListedRecordingFile {
  /** The name both files share, before their extensions. */
  readonly name: string;
  /** Both files' sizes together. */
  readonly bytes: number;
  /** The pair's files that say the store wrote them, each by itself: the ones `e2e cache clear` may delete. */
  readonly files: readonly string[];
  readonly parsed: ParsedRecordingFile;
  /** Set when a file of the pair could not be opened, so nothing says whose it is; `list` skips such a pair unless asked. */
  readonly unconfirmed?: true;
}

export class FileCacheStore implements CacheStore {
  readonly writable: boolean;

  private readonly directory: string;
  private readonly maxBytes: number;
  /** The steps read for each test, in the order they were read: where a step new to a file goes (`placeFor`). */
  private readonly readOrder = new Map<string, string[]>();
  /** Each pair as last parsed, beside the text of its files then (`load`). */
  private readonly loaded = new Map<string, { readonly yaml: string; readonly lock: string; readonly file: ListedRecordingFile | undefined }>();

  constructor(options: FileCacheStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = Math.min(options.maxBytes, MAX_CACHE_WIRE_BYTES);
    this.writable = options.writable;
  }

  async read(keyHash: string, step?: TraceProvenance): Promise<CacheReadResult> {
    if (!KEY_HASH.test(keyHash)) return { status: 'invalid', reason: 'key hash is not a SHA-256 digest' };
    if (step === undefined) {
      for (const file of await this.list()) {
        const found = findEntry(file, keyHash);
        if (found !== undefined) return found;
      }
      return { status: 'miss' };
    }
    this.noteRead(step);
    const base = recordingName(step.testId);
    const own = await this.locked(base, async (): Promise<CacheReadResult | undefined> => {
      const file = await this.locate(base, step.testId);
      if (file === undefined) return undefined;
      // The test's own pair that does not read may hold any of its steps: none of them is a miss.
      if (file.parsed.status === 'invalid') return { status: 'invalid', reason: file.parsed.reason, bytes: file.bytes };
      return findEntry(file, keyHash);
    });
    return own ?? { status: 'miss' };
  }

  async write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return undefined;
    const testId = payload.recordedFor?.testId;
    if (testId === undefined || stepIdentity(payload.recordedFor) === undefined) return undefined;
    const base = recordingName(testId);
    return this.locked(base, async () => {
      const file = await this.locate(base, testId);
      // Rewriting a pair drops what does not read; that is a person's to fix, not a write's to erase.
      if (file !== undefined && unreadable(file, keyHash) !== undefined) return undefined;
      const name = file?.name ?? (await this.exists(base) ? collisionName(base, testId) : base);
      const recordings = file?.parsed.status === 'ok' ? hits(file.parsed) : [];
      return this.save(name, testId, this.placed(recordings, keyHash, payload));
    }, true);
  }

  /**
   * Writes several recordings, each as `write` would, and a test's together:
   * its pair is read and published once, under one lock, for all of them,
   * so recording many steps of one test costs one rewrite, not one each.
   * Returns each write's answer, in order. When a test's pair cannot take
   * them all at once (one that does not read, the size cap, or a write that
   * throws), its writes fall back to one at a time, so each gets the answer
   * it would alone, undefined for one that throws. Not part of
   * `CacheStore`: settlement calls it on the file store
   * (`settleStagedTraces`).
   */
  async writeAll(writes: readonly { readonly keyHash: string; readonly payload: ActionTrace }[]): Promise<({ bytes: number } | undefined)[]> {
    const answers: ({ bytes: number } | undefined)[] = writes.map(() => undefined);
    const byTest = new Map<string, number[]>();
    for (const [index, { keyHash, payload }] of writes.entries()) {
      const testId = payload.recordedFor?.testId;
      if (!this.writable || !KEY_HASH.test(keyHash) || testId === undefined || stepIdentity(payload.recordedFor) === undefined) continue;
      byTest.set(testId, [...(byTest.get(testId) ?? []), index]);
    }
    for (const [testId, indexes] of byTest) {
      const base = recordingName(testId);
      const together = await this.locked(base, async () => {
        const file = await this.locate(base, testId);
        if (file !== undefined && indexes.some((index) => unreadable(file, writes[index]!.keyHash) !== undefined)) return undefined;
        const name = file?.name ?? (await this.exists(base) ? collisionName(base, testId) : base);
        let recordings = file?.parsed.status === 'ok' ? hits(file.parsed) : [];
        for (const index of indexes) recordings = this.placed(recordings, writes[index]!.keyHash, writes[index]!.payload);
        return this.save(name, testId, recordings);
        // A write together that throws (a rename a scanner held, the lock's wait run out) falls back the same way.
      }, true).catch(() => undefined);
      for (const index of indexes) {
        answers[index] = together ?? (await this.write(writes[index]!.keyHash, writes[index]!.payload).catch(() => undefined));
      }
    }
    return answers;
  }

  /** `recordings` with `payload` in place under `keyHash`: replacing its key's or its slot's, else where the test runs it. */
  private placed(recordings: readonly StoredRecording[], keyHash: string, payload: ActionTrace): StoredRecording[] {
    const testId = payload.recordedFor!.testId;
    const slot = stepIdentity(payload.recordedFor)!;
    const sameSlot = (recording: StoredRecording) =>
      stepIdentity(recording.trace.recordedFor) === slot && recording.trace.recordedFor?.targetId === payload.recordedFor!.targetId;
    const replaced = recordings.find((recording) => recording.keyHash === keyHash || sameSlot(recording));
    const recording: StoredRecording = {
      keyHash,
      // A recording rewritten under its own key with the same flow (its provenance completed) keeps the
      // time it was made; a new flow under the key is a new recording.
      createdAt:
        replaced?.keyHash === keyHash && canonicalJson(replayed(replaced.trace)) === canonicalJson(replayed(payload)) ? replaced.createdAt : timestamp(),
      trace: wholeSeconds(payload),
    };
    const index = replaced === undefined ? -1 : recordings.indexOf(replaced);
    const next = recordings.filter((existing) => existing.keyHash !== keyHash && !sameSlot(existing));
    if (index >= 0) next.splice(Math.min(index, next.length), 0, recording);
    else next.splice(this.placeFor(testId, slot, next), 0, recording);
    return next;
  }

  async delete(keyHash: string, step?: TraceProvenance): Promise<void> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return;
    const testId = step?.testId ?? (await this.list()).find((file) => findEntry(file, keyHash) !== undefined)?.parsed.testId;
    if (testId === undefined) return;
    const base = recordingName(testId);
    const name = await this.locked(base, async () => (await this.locate(base, testId))?.name);
    if (name !== undefined) await this.evictFrom(name, keyHash);
  }

  /** Drops one key's recording from one pair, under its test's lock. */
  private async evictFrom(name: string, keyHash: string): Promise<void> {
    await this.locked(name.replace(COLLISION_SUFFIX, ''), async () => {
      const file = await this.load(name);
      // A pair that does not read replays nothing, so nothing in it needs evicting; it waits for a person.
      if (file === undefined || file.parsed.status === 'invalid') return;
      if (!file.parsed.recordings.some((recording) => recording.keyHash === keyHash)) return;
      // The YAML cannot be rewritten without dropping what does not read, a person's to fix; the lock alone can
      // let the key go, so a flow a failure implicated stops replaying meanwhile. Only a key that replays: one
      // whose own block does not read (a person's edit) keeps its entry, so undoing the edit restores it.
      if (unreadable(file, keyHash) !== undefined) {
        if (!file.parsed.recordings.some((recording) => recording.keyHash === keyHash && recording.status === 'hit')) return;
        if (!(await holdsFileLock(this.lockPath(file.name)))) throw new Error(`lost the lock on ${file.name} to another writer`);
        const lock = this.path(file.name, LOCK_EXTENSION);
        await writeFileAtomic(lock, lockWithout(await readFile(lock, 'utf8'), keyHash), { mode: 0o600 });
        return;
      }
      const next = hits(file.parsed).filter((recording) => recording.keyHash !== keyHash);
      if (next.length === 0) await this.remove(file.name);
      // A pair it could not write back (one rendered over the size cap, or the lock lost) still replays the key.
      else if ((await this.save(file.name, file.parsed.testId, next)) === undefined) throw new Error(`could not write ${file.name} without ${keyHash.slice(0, 12)}`);
    });
  }

  /**
   * The reviewed file a test's recordings are in, or would be written to:
   * its own name, or the colliding one when another test holds that. The
   * test id is cut as a recording keeps it, which is what the store names
   * files from. Not part of `CacheStore`: trace pages name the file beside
   * a step's key.
   */
  async recordingFile(testId: string): Promise<string> {
    const recorded = bound(testId, MAX_TRACE_TEST_ID_CHARS);
    const base = recordingName(recorded);
    const own = await this.locate(base, recorded);
    if (own !== undefined) return `${own.name}${RECORDING_EXTENSION}`;
    const collided = collisionName(base, recorded);
    return `${(await this.exists(collided)) || (await this.exists(base)) ? collided : base}${RECORDING_EXTENSION}`;
  }

  /**
   * The pair holding `testId`'s recordings, read under its lock, or
   * undefined when there is none. Not part of `CacheStore`: `cache.strict`
   * looks there for a step's recording under another key (`rekeyed.ts`).
   */
  async recordingsOf(testId: string): Promise<ListedRecordingFile | undefined> {
    const base = recordingName(testId);
    return this.locked(base, () => this.locate(base, testId));
  }

  /**
   * Deletes the files of one pair the store wrote, under its test's lock and
   * as they are then: a write that landed since the pair was listed goes
   * whole, never half, so no lone YAML is left behind. Returns how many
   * files went. Not part of `CacheStore`: only `e2e cache clear` empties a
   * store.
   */
  async clear(name: string): Promise<number> {
    return this.locked(name.replace(COLLISION_SUFFIX, ''), async () => {
      const file = await this.load(name);
      let removed = 0;
      for (const owned of file?.files ?? []) {
        try {
          await unlink(join(this.directory, owned));
          removed += 1;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      return removed;
    });
  }

  /**
   * Every file pair in the directory, readable or not; none when the
   * directory does not exist. Not part of `CacheStore`: only `cache.strict`
   * and `e2e cache` list a store, and only this one.
   */
  async list(options: { readonly unconfirmed?: boolean } = {}): Promise<ListedRecordingFile[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }
    const stems = new Set(names.flatMap((name) => {
      const stem = recordingStem(name);
      return stem === undefined ? [] : [stem];
    }));
    const files: ListedRecordingFile[] = [];
    for (const stem of [...stems].toSorted()) {
      // Whose a pair is shows without the lock, from its files' first bytes, so another tool's files
      // named like a pair never hold a listing up. The store's own are read again under the lock its
      // writer takes, so a listing never catches one half-replaced.
      if ((await this.load(stem)) === undefined) continue;
      const file = await this.locked(stem.replace(COLLISION_SUFFIX, ''), () => this.load(stem));
      // One the store cannot tell is its own is listed only when asked for: nothing may delete it, but
      // `e2e cache ls` names it, since a run reads it as `invalid-entry`.
      if (file !== undefined && (file.unconfirmed !== true || options.unconfirmed === true)) files.push(file);
    }
    return files;
  }

  private noteRead(step: TraceProvenance): void {
    const identity = stepIdentity(step);
    if (identity === undefined) return;
    const order = this.readOrder.get(step.testId) ?? [];
    if (!order.includes(identity)) order.push(identity);
    this.readOrder.set(step.testId, order);
  }

  /**
   * Where a recording goes among a test's `recordings` when its step has
   * none there yet: before the recording of the first step read after it
   * that the file holds, so a step added to the middle of a test lands in
   * the middle of its file, even one a person reordered.
   * At the end when the step was not read through this store (a retry
   * records without reading) or no later step is in the file.
   */
  private placeFor(testId: string, identity: string, recordings: readonly StoredRecording[]): number {
    if (recordings.some((recording) => stepIdentity(recording.trace.recordedFor) === identity)) return recordings.length;
    const order = this.readOrder.get(testId) ?? [];
    const at = order.indexOf(identity);
    if (at < 0) return recordings.length;
    // The next step the attempt read that the file holds, wherever a person moved it in the file.
    for (const later of order.slice(at + 1)) {
      const index = recordings.findIndex((recording) => stepIdentity(recording.trace.recordedFor) === later);
      if (index >= 0) return index;
    }
    return recordings.length;
  }

  /**
   * Runs `operation` under the lock of the test's base name, so that it
   * never sees a pair another writer is halfway through replacing. A
   * read-only store locks its reads too: another run, or another worker,
   * can be writing the same directory. Only a write creates the directory:
   * a read or a delete in a directory that does not exist, or that no one
   * can write (a read-only mount), has no writer to wait for, and leaves
   * nothing behind.
   */
  private async locked<T>(base: string, operation: () => Promise<T>, creates = false): Promise<T> {
    if (creates) await mkdir(this.directory, { recursive: true });
    else if (!(await access(this.directory, constants.W_OK).then(() => true, () => false))) return operation();
    return withFileLock(this.lockPath(base), async () => {
      if (this.writable) await this.recover(base);
      return operation();
    });
  }

  /** Where a writer records the lock it is about to publish, so a crash between its two renames can be finished. */
  private pendingPath(base: string): string {
    return join(this.directory, `.${base.replace(COLLISION_SUFFIX, '')}.pending`);
  }

  /**
   * Settles a pair a writer was cut off halfway through replacing. The
   * reviewed file is renamed first and the lock second, so a crash between
   * the two leaves the new YAML beside the old lock, which reads as an edit
   * and blocks every later write. The writer records the lock it meant to
   * publish, with the digest of the YAML and of the lock it replaces, before
   * the first rename: a YAML that is the new one beside the lock it replaced
   * means the lock is all that is left, so it is published; anything else
   * means no rename happened, or both did, or the pair has changed since (a
   * checkout), and the record is dropped. Runs under the test's lock, before
   * anything reads the pair.
   */
  private async recover(base: string): Promise<void> {
    const path = this.pendingPath(base);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return;
    }
    try {
      const pending: unknown = JSON.parse(text);
      const { name, yamlDigest, lock, replaces } = (typeof pending === 'object' && pending !== null ? pending : {}) as Record<string, unknown>;
      // A file of another shape is not a record a writer left, and is not the store's to remove.
      if (typeof name !== 'string' || typeof yamlDigest !== 'string' || typeof lock !== 'string' || (typeof replaces !== 'string' && replaces !== null) || basename(name) !== name) return;
      const yaml = await this.readCapped(this.path(name, RECORDING_EXTENSION));
      const current = await this.readCapped(this.path(name, LOCK_EXTENSION));
      // A file there that could not be read whole (another account's, or one over the size cap) says nothing of
      // which one it is: the record waits for a read that can.
      if ([yaml, current].some((file) => file !== undefined && file.text === undefined)) return;
      const currentDigest = current?.text === undefined ? null : digest(current.text);
      if (yaml?.text !== undefined && digest(yaml.text) === yamlDigest && currentDigest === replaces) {
        await writeFileAtomic(this.path(name, LOCK_EXTENSION), lock, { mode: 0o600 });
      }
    } catch {
      // A record that does not parse, or a lock that cannot be put in place, leaves the pair as it is:
      // the store never guesses at a repair, and a person's fix of the pair is still the way out.
      return;
    }
    await unlink(path).catch(() => undefined);
  }

  /** The lock file a pair's writers take: its test's base name's. */
  private lockPath(name: string): string {
    return join(this.directory, `.${name.replace(COLLISION_SUFFIX, '')}.writing`);
  }

  /**
   * The pair holding `testId`'s recordings, readable or not: its own name,
   * or the colliding one when another test holds that. The colliding name
   * carries the test's own digest, so a pair there is the test's. A pair
   * under its own name whose lock cannot say whose it is (a merge conflict
   * in it, or no lock) is the test's unless its YAML names another test.
   */
  private async locate(base: string, testId: string): Promise<ListedRecordingFile | undefined> {
    const collided = await this.load(collisionName(base, testId));
    if (collided !== undefined) return collided;
    const file = await this.load(base);
    if (file === undefined) return undefined;
    if (file.parsed.testId !== undefined) return file.parsed.testId === testId ? file : undefined;
    const yaml = await this.readCapped(this.path(base, RECORDING_EXTENSION));
    return (yaml?.text === undefined ? undefined : await recordingNamesTest(yaml.text, testId)) === false ? undefined : file;
  }

  private async exists(name: string): Promise<boolean> {
    const present = async (path: string) => stat(path).then(() => true, () => false);
    return (await present(this.path(name, RECORDING_EXTENSION))) || (await present(this.path(name, LOCK_EXTENSION)));
  }

  /**
   * Reads one pair, refusing a file over the size cap before reading all of
   * it. A name the store would write can still be another tool's file
   * (`cache.dir` can point anywhere), so a pair neither of whose files says
   * the store wrote it is not one.
   */
  private async load(name: string): Promise<ListedRecordingFile | undefined> {
    const yaml = await this.readCapped(this.path(name, RECORDING_EXTENSION));
    const lock = await this.readCapped(this.path(name, LOCK_EXTENSION));
    // Every step of a test reads its whole pair: reading is cheap, parsing is not, so a pair whose
    // text is what was parsed last is not parsed again. Compared by text, not by a file's inode, size,
    // and times, which a filesystem with coarse timestamps can leave the same across a quick rewrite.
    const known = this.loaded.get(name);
    if (known !== undefined && yaml?.text === known.yaml && lock?.text === known.lock) return known.file;
    const file = await this.readPair(name, yaml, lock);
    if (yaml?.text !== undefined && lock?.text !== undefined) this.loaded.set(name, { yaml: yaml.text, lock: lock.text, file });
    return file;
  }

  /** One pair as `load` read its files: its name, size, ownership, and what it holds. */
  private async readPair(name: string, yaml: CappedFile | undefined, lock: CappedFile | undefined): Promise<ListedRecordingFile | undefined> {
    // A file that exists but cannot be opened (another account's, say) says nothing about whose it is.
    const unopened = [yaml, lock].some((file) => file !== undefined && file.head === undefined);
    const owned = writtenByStore(yaml?.head, lock?.head);
    if (!owned && !unopened) return undefined;
    const files = [
      ...(writtenByStore(yaml?.head, undefined) ? [`${name}${RECORDING_EXTENSION}`] : []),
      ...(writtenByStore(undefined, lock?.head) ? [`${name}${LOCK_EXTENSION}`] : []),
    ];
    const bytes = (yaml?.bytes ?? 0) + (lock?.bytes ?? 0);
    const problem = yaml?.problem ?? lock?.problem;
    if (problem === undefined && yaml === undefined && lock?.text !== undefined) {
      const parsed = parseLockAlone(lock.text);
      return { name, bytes, files, parsed: parsed.status === 'invalid' ? { ...parsed, reason: `${name}${LOCK_EXTENSION}: ${parsed.reason}` } : parsed };
    }
    if (problem !== undefined || yaml?.text === undefined || lock?.text === undefined) {
      // The lock may still say whose pair this is, so a writer for that test replaces it.
      const parsedLock = lock?.text === undefined ? undefined : await parseRecordingFile('', lock.text);
      const testId = parsedLock?.testId;
      const reason = problem ?? `${yaml === undefined ? `${name}${RECORDING_EXTENSION}` : `${name}${LOCK_EXTENSION}`} is missing`;
      return {
        name,
        bytes,
        files,
        ...(owned ? {} : { unconfirmed: true }),
        parsed: {
          status: 'invalid',
          ...(testId === undefined ? {} : { testId }),
          keyHashes: parsedLock?.status === 'invalid' ? parsedLock.keyHashes : [],
          reason,
        },
      };
    }
    const parsed = await parseRecordingFile(yaml.text, lock.text);
    return {
      name,
      bytes,
      files,
      parsed: parsed.status === 'invalid' ? { ...parsed, reason: `${name}${RECORDING_EXTENSION}: ${parsed.reason}` } : parsed,
    };
  }

  /** One file of a pair: its whole text, or its first bytes and why the rest was not read; undefined when absent. */
  private async readCapped(path: string): Promise<CappedFile | undefined> {
    let bytes: number;
    try {
      bytes = (await stat(path)).size;
    } catch {
      return undefined;
    }
    try {
      if (bytes > this.maxBytes) {
        return { bytes, head: await readHead(path), problem: `${path} is ${bytes} bytes, over the ${this.maxBytes}-byte limit` };
      }
      const text = await readFile(path, 'utf8');
      return { bytes, text, head: text };
    } catch (cause) {
      return { bytes, problem: `${path} is unreadable: ${errorMessage(cause)}` };
    }
  }

  /**
   * Writes one pair, the reviewed file first, as one replacement: a failed
   * write leaves both files as they were, never a new YAML beside its old
   * lock. Undefined when either is over the size cap.
   */
  private async save(name: string, testId: string, recordings: readonly StoredRecording[]): Promise<{ bytes: number } | undefined> {
    const kept = onePerSlot(recordings);
    const { yaml, lock } = await renderRecordingFile({ testId, recordings: kept }, `${name}${LOCK_EXTENSION}`);
    const yamlBytes = Buffer.byteLength(yaml, 'utf8');
    const lockBytes = Buffer.byteLength(lock, 'utf8');
    if (yamlBytes > this.maxBytes || lockBytes > this.maxBytes) return undefined;
    // What reads back is what replays, and the lock's digests are taken from it, so a value the YAML
    // cannot carry as written would replay changed without a word: such a pair is not written.
    if (!(await readsBack(yaml, lock, kept))) return undefined;
    await mkdir(this.directory, { recursive: true });
    const pending = this.pendingPath(name);
    let recorded = false;
    // A write that throws keeps the record: a rollback that failed too left the new YAML beside the old lock,
    // which `recover` finishes, and one that worked left the old pair, whose YAML makes `recover` drop it.
    const replaced = await writeFilesAtomic(
      [
        { path: this.path(name, RECORDING_EXTENSION), content: yaml },
        { path: this.path(name, LOCK_EXTENSION), content: lock },
      ],
      {
        mode: 0o600,
        // Rendered from what was read under the lock: published only while the lock is still this writer's,
        // checked as late as can be, once the files are written and only the renames are left. The lock
        // is recorded then too, for `recover`, which finishes a pair a crash cut between its renames.
        beforeReplace: async () => {
          if (!(await holdsFileLock(this.lockPath(name)))) return false;
          const replaces = await readFile(this.path(name, LOCK_EXTENSION), 'utf8').then(digest, () => null);
          await writeFileAtomic(pending, JSON.stringify({ name, yamlDigest: digest(yaml), lock, replaces }), { mode: 0o600 });
          recorded = true;
          return true;
        },
      },
    );
    if (recorded) await unlink(pending).catch(() => undefined);
    return replaced ? { bytes: yamlBytes + lockBytes } : undefined;
  }

  private async remove(name: string): Promise<void> {
    if (!(await holdsFileLock(this.lockPath(name)))) throw new Error(`lost the lock on ${name} to another writer`);
    for (const extension of [RECORDING_EXTENSION, LOCK_EXTENSION]) {
      try {
        await unlink(this.path(name, extension));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
  }

  /**
   * Resolves one file path. The name is the store's own (`recordingName`),
   * never a caller's text, and matches `RECORDING_NAME`, so traversal is
   * impossible by construction rather than by canonicalization.
   */
  private path(name: string, extension: string): string {
    if (!RECORDING_NAME.test(name)) throw new Error(`not a recording name: ${name}`);
    return join(this.directory, `${name}${extension}`);
  }
}


/** The name a store file carries before its extension, or undefined for any other file. */
function recordingStem(fileName: string): string | undefined {
  const stem = fileName.endsWith(LOCK_EXTENSION)
    ? fileName.slice(0, -LOCK_EXTENSION.length)
    : fileName.endsWith(RECORDING_EXTENSION)
      ? fileName.slice(0, -RECORDING_EXTENSION.length)
      : undefined;
  return stem !== undefined && RECORDING_NAME.test(stem) ? stem : undefined;
}

/** The first `HEAD_BYTES` of a file, as text. */
async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** One key's entry in a pair, as a read result; undefined when the pair does not hold the key. */
function findEntry(file: ListedRecordingFile, keyHash: string): CacheReadResult | undefined {
  const { parsed } = file;
  if (parsed.status === 'invalid') {
    return parsed.keyHashes.includes(keyHash) ? { status: 'invalid', reason: parsed.reason, bytes: file.bytes } : undefined;
  }
  const recording = parsed.recordings.find((candidate) => candidate.keyHash === keyHash);
  if (recording === undefined) return undefined;
  return recording.status === 'hit'
    ? { status: 'hit', entry: recording.entry, bytes: file.bytes }
    : { status: 'invalid', reason: `${file.name}${RECORDING_EXTENSION}: ${recording.reason}`, bytes: file.bytes };
}

/**
 * Why a pair holds something a rewrite for `keyHash` would drop: the pair
 * does not read, one of its recordings under another key does not, or the
 * YAML shows a recording no lock entry claims.
 * Undefined when a rewrite keeps everything else in it.
 */
function unreadable(file: ListedRecordingFile, keyHash: string): string | undefined {
  const { parsed } = file;
  if (parsed.status === 'invalid') return parsed.reason;
  const recording = parsed.recordings.find((candidate) => candidate.status === 'invalid' && candidate.keyHash !== keyHash);
  if (recording?.status === 'invalid') return `${file.name}${RECORDING_EXTENSION}: ${recording.reason}`;
  // A YAML recording no lock entry claims (an edit, a write cut short, a merge resolved in one file only)
  // would go too, and nothing says which step it was: a person undoes the edit or deletes the file.
  const [stray] = parsed.unclaimed;
  return stray === undefined ? undefined : `${file.name}${RECORDING_EXTENSION}: ${stray} has no entry in the lock file`;
}

/**
 * The recordings with one per step and target, the newest. A write keeps
 * that so itself; two under different keys come from a merge of branches
 * that each recorded the step, and the YAML has room for one: rendering
 * both would show one and bind both keys to it.
 */
function onePerSlot(recordings: readonly StoredRecording[]): StoredRecording[] {
  const slot = (recording: StoredRecording) => JSON.stringify([stepIdentity(recording.trace.recordedFor), recording.trace.recordedFor?.targetId]);
  const newest = new Map<string, StoredRecording>();
  for (const recording of recordings) {
    const kept = newest.get(slot(recording));
    if (kept === undefined || recording.createdAt > kept.createdAt) newest.set(slot(recording), recording);
  }
  return recordings.filter((recording) => newest.get(slot(recording)) === recording);
}

/** Whether a rendered pair reads back as every recording it was rendered from, in all a replay uses. */
async function readsBack(yaml: string, lock: string, recordings: readonly StoredRecording[]): Promise<boolean> {
  const parsed = await parseRecordingFile(yaml, lock);
  if (parsed.status !== 'ok' || parsed.unclaimed.length > 0) return false;
  return recordings.every((recording) => {
    const read = parsed.recordings.find((candidate) => candidate.keyHash === recording.keyHash);
    return read?.status === 'hit' && canonicalJson(replayed(read.entry.payload)) === canonicalJson(replayed(recording.trace));
  });
}

/** What a replay reads of a trace: its actions (a summary only where a gap's is its content), paths, and end checks. */
function replayed(trace: ActionTrace): unknown {
  return {
    actions: trace.actions.map((action) => (action.name === 'tool' ? action : { ...action, summary: undefined })),
    startPath: trace.startPath,
    endPath: trace.endPath,
    endAnchors: trace.endAnchors,
    goneAnchors: trace.goneAnchors,
    truncated: trace.truncated,
  };
}

/** The digest a pending record names the YAML it was written beside, and the lock it replaces, by. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A pair's readable recordings, the ones a rewrite keeps. */
function hits(parsed: Extract<ParsedRecordingFile, { readonly status: 'ok' }>): StoredRecording[] {
  return parsed.recordings.flatMap((recording) =>
    recording.status === 'hit' ? [{ keyHash: recording.keyHash, createdAt: recording.entry.createdAt, trace: recording.entry.payload }] : [],
  );
}

/**
 * The trace with its end wait rounded up to whole seconds. The wait is a
 * measured duration plus a margin, so its milliseconds change on every
 * recording and say nothing; rounding up never waits less than measured.
 */
function wholeSeconds(trace: ActionTrace): ActionTrace {
  if (trace.endWaitMs === undefined) return trace;
  return { ...trace, endWaitMs: Math.min(MAX_TRACE_END_WAIT_MS, Math.ceil(trace.endWaitMs / 1000) * 1000) };
}
