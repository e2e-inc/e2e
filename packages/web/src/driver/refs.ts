/** The node refs one attempt minted: observation ids and located ids, each with the element behind it. */

import { EngineError, type NodeRef } from '@e2e-dev/core/engine';
import type { NodeTarget } from './frames.ts';

/**
 * The ids the driver minted and the element behind each, with the browsing
 * context that holds it. A BiDi shared id holds no handle: it names the
 * element for as long as it lives, so nothing here needs disposing.
 */
export class BidiRefs {
  private counter = 0;
  private observation = new Map<string, NodeTarget>();
  private readonly located = new Map<string, NodeTarget>();
  /** The input count when each located id was minted, until an action claims it. */
  private readonly minted = new Map<string, number>();

  /** `dispatches` reads the attempt's input count. */
  constructor(private readonly dispatches: () => number) {}

  /** Reserves ids before a document can stamp them. */
  reserveIds(count: number): number {
    const first = this.counter + 1;
    this.counter += count;
    return first;
  }

  /** Replaces the observation generation. */
  publish(generation: Map<string, NodeTarget>): void {
    this.observation = generation;
  }

  /** Keeps a located element under the id its read gave it, dropping the oldest past 2048. */
  storeLocated(id: string, target: NodeTarget): void {
    this.located.delete(id);
    this.located.set(id, target);
    this.minted.set(id, this.dispatches());
    for (const oldest of this.located.keys()) {
      if (this.located.size <= 2048) break;
      this.located.delete(oldest);
      this.minted.delete(oldest);
    }
  }

  /**
   * Whether `ref` is acted on for the first time with no input, page
   * mutation, or test code since its locate proved it its locator's only
   * match, so that proof still holds; claims it, so a later action checks again.
   */
  claimFresh(ref: NodeRef): boolean {
    const mintedAt = this.minted.get(ref.id);
    this.minted.delete(ref.id);
    return mintedAt !== undefined && mintedAt === this.dispatches();
  }

  /** The element behind `ref`; `NODE_STALE` when no generation holds it. */
  lookup(ref: NodeRef): NodeTarget {
    const target = this.located.get(ref.id) ?? this.observation.get(ref.id);
    if (target === undefined) throw new EngineError('NODE_STALE', `node reference ${ref.id} is stale`, { retryable: true });
    return target;
  }

  /** The element `ref` names when an observation minted it; a ref only a locate minted is refused for good. */
  lookupObserved(ref: NodeRef): NodeTarget {
    const target = this.observation.get(ref.id);
    if (target !== undefined) return target;
    if (this.located.has(ref.id)) throw new EngineError('NODE_STALE', `node reference ${ref.id} is not from an observation`, { retryable: false });
    return this.lookup(ref);
  }

  /** Forgets everything recorded, for a new user context. */
  clear(): void {
    this.observation = new Map();
    this.located.clear();
    this.minted.clear();
  }
}
