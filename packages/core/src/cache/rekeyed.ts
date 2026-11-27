/**
 * Recordings stored under a key the runner no longer derives.
 *
 * A key names everything that can change replay (`identity.ts`), so a new
 * replay policy, a new key field, or an agent's context changing turns every
 * entry recorded before into a lookup miss, the same `no-entry` as a step
 * that was never recorded. `cache.strict` lets a never-recorded step run
 * live, so without this it would let a whole committed cache go quietly
 * unused. The entries say which step they were recorded for
 * (`TraceProvenance`), and a step whose own key misses while the store holds
 * a recording made for exactly that step is stale, not new.
 *
 * Only the file store can be looked through. A step's recordings are all
 * in its test's pair, so a strict miss reads that pair alone, under its lock:
 * only a writer of a test whose name has the same stem (its lock, `lockPath`
 * in `store.ts`) can hold it up. A read that fails finds nothing, and the
 * next miss reads again.
 */

import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES, RECORDING_EXTENSION } from './store.ts';
import type { TraceKeyContext, TraceProvenance } from './trace.ts';

export class StoredRecordings {
  private readonly store: FileCacheStore;

  constructor(store: FileCacheStore) {
    this.store = store;
  }

  /**
   * The key hash of an entry recorded for `step` under a key other than
   * `keyHash`, with the key context it recorded, or undefined when there is none or the store cannot be
   * read. `step` is in the form an entry stores it (`recordedProvenance`).
   * Only an entry that records the whole step counts: one written before the
   * params, occurrence, and agent were recorded could belong to another call
   * of the same instruction, and a read-write run that replays it completes
   * it (`settleStagedTraces`). A truncated entry never replays under any key,
   * so it is never the reason a step is stale.
   */
  async underAnotherKey(
    keyHash: string,
    step: TraceProvenance,
  ): Promise<{ readonly keyHash: string; readonly file: string; readonly keyedBy?: TraceKeyContext } | undefined> {
    const key = stepKey(step);
    if (key === undefined) return undefined;
    // A read that failed (the test's lock held past the wait, say) is tried again by the next step.
    const file = await this.store.recordingsOf(step.testId).catch(() => undefined);
    if (file === undefined || file.parsed.status !== 'ok') return undefined;
    for (const recording of file.parsed.recordings) {
      if (recording.status !== 'hit' || recording.keyHash === keyHash || recording.entry.payload.truncated === true) continue;
      const { recordedFor, keyedBy } = recording.entry.payload;
      if (recordedFor === undefined || stepKey(recordedFor) !== key) continue;
      return { keyHash: recording.keyHash, file: `${file.name}${RECORDING_EXTENSION}`, ...(keyedBy === undefined ? {} : { keyedBy }) };
    }
    return undefined;
  }
}

/**
 * What `cache.strict` checks a run's misses against, for the file store
 * only. Undefined when strict is off, the cache is off, or a custom
 * `cache.store` replaced the file store, which `CacheStore` gives no way to
 * list.
 */
export function storedRecordingsFor(cache: ResolvedCacheConfig): StoredRecordings | undefined {
  if (cache.strict === false || cache.mode === 'off' || cache.store !== undefined) return undefined;
  return new StoredRecordings(new FileCacheStore({ directory: cache.dir, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false }));
}

/**
 * The whole step as one map key, or undefined when the provenance does not
 * record all of it. When an entry could store a name cut, the key includes
 * `identityDigest`, so such a step never matches an entry without one.
 */
function stepKey(step: TraceProvenance): string | undefined {
  const { testId, targetId, instructionDigest, paramsDigest, callIndex, agent, identityDigest } = step;
  if (paramsDigest === undefined || callIndex === undefined || agent === undefined) return undefined;
  return JSON.stringify([testId, targetId, instructionDigest, paramsDigest, callIndex, agent, identityDigest ?? null]);
}
