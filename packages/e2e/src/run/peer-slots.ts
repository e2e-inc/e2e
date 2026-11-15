/**
 * Slots for peers. A peer of a test (the `peers` option) runs on an engine of
 * its own inside the worker that runs the test, so on the peer's target it
 * takes a slot no worker of that target holds: a device of its own, on a
 * phone target. The runner asks each target's `prepare` for its own workers'
 * slots plus the ones peers need, lowers worker counts where an engine serves
 * fewer, and tells each worker which slots its tests' peers take.
 */

import { peerTarget, type Selection } from '../collect/select.ts';
import { ConfigurationError, InfrastructureError } from '../internal/errors.ts';

/**
 * The most peers one test of a target puts on each peer target, by the
 * test's target, then the peer's: what one worker of the first can need of
 * the second at once, since a worker runs one test at a time.
 */
export type PeersBrought = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Counts the peers each runnable test brings to each target, and keeps the most per test target. */
export function peersBrought(selection: Pick<Selection, 'pairs'>): PeersBrought {
  const brought = new Map<string, Map<string, number>>();
  for (const pair of selection.pairs) {
    if (pair.disposition !== 'run') continue;
    const perTest = new Map<string, number>();
    for (const peer of pair.options.peers) {
      const target = peerTarget(peer, pair);
      perTest.set(target, (perTest.get(target) ?? 0) + 1);
    }
    for (const [target, count] of perTest) {
      const own = brought.get(pair.target.name) ?? new Map<string, number>();
      own.set(target, Math.max(own.get(target) ?? 0, count));
      brought.set(pair.target.name, own);
    }
  }
  return brought;
}

/** The slots `target` must serve at once with these worker counts: one per worker of its own, and one per peer any worker brings to it. */
export function slotsNeeded(target: string, workers: ReadonlyMap<string, number>, brought: PeersBrought): { readonly slots: number; readonly peerSlots: number } {
  let peerSlots = 0;
  for (const [from, onTargets] of brought) peerSlots += (workers.get(from) ?? 0) * (onTargets.get(target) ?? 0);
  return { slots: (workers.get(target) ?? 0) + peerSlots, peerSlots };
}

/** One target as the fit reads it: the workers its own units can use, and the slots its engine serves at once, when it said. */
export interface TargetSlots {
  readonly name: string;
  readonly workers: number;
  readonly served: number | undefined;
}

/** The worker counts that fit every engine, and a line for each target that runs fewer workers than planned. */
export interface FittedWorkers {
  readonly workers: ReadonlyMap<string, number>;
  readonly notices: readonly string[];
}

/**
 * Lowers worker counts until every target serves its own workers and the
 * peers brought to it. A target short of slots gives up its own workers
 * first, down to one; then the targets whose tests bring it the most peers
 * do. A target that cannot serve one worker of each is an error, raised
 * before any test starts.
 */
export function fitWorkers(targets: readonly TargetSlots[], brought: PeersBrought): FittedWorkers {
  const workers = new Map(targets.map((target) => [target.name, target.workers]));
  const short = (): TargetSlots | undefined =>
    targets.find((target) => target.served !== undefined && slotsNeeded(target.name, workers, brought).slots > target.served);
  for (let target = short(); target !== undefined; target = short()) {
    const own = workers.get(target.name) ?? 0;
    if (own > 1) {
      workers.set(target.name, own - 1);
      continue;
    }
    // The slots a target's workers beyond its first take here: what lowering it can give back.
    const gives = (other: TargetSlots): number => {
      const count = workers.get(other.name) ?? 0;
      return count > 1 ? count * (brought.get(other.name)?.get(target.name) ?? 0) : 0;
    };
    const most = targets.reduce((best, other) => (gives(other) > gives(best) ? other : best), target);
    if (gives(most) === 0) {
      const parts = [
        ...(own === 0 ? [] : ['1 for its own worker']),
        ...targets.flatMap((other) => {
          const count = brought.get(other.name)?.get(target.name) ?? 0;
          return count === 0 ? [] : [`${count} for the ${count === 1 ? 'peer' : 'peers'} of one ${other.name === target.name ? 'of its own tests' : `"${other.name}" test`}`];
        }),
      ];
      throw new InfrastructureError(
        'ENGINE_FAILURE',
        `target "${target.name}" serves ${target.served} at once, and this run needs ${slotsNeeded(target.name, workers, brought).slots} of it at once with one worker per target: ${parts.join(', ')}; a peer takes a slot of its own, a device on a phone target, so give the target more, or keep the tests that put a peer on it out of this run`,
      );
    }
    workers.set(most.name, (workers.get(most.name) ?? 0) - 1);
  }
  const notices = targets.flatMap((target) => {
    const fitted = workers.get(target.name) ?? 0;
    // An engine that serves fewer workers than planned lowers its own count as it always has, silently; a line tells only what peers took.
    if (fitted === Math.min(target.workers, target.served ?? target.workers)) return [];
    return [`target "${target.name}" runs ${fitted} ${fitted === 1 ? 'worker' : 'workers'} at a time, not ${target.workers}: the peers of tests take slots of their own on their targets, and an engine serves only so many at once`];
  });
  return { workers, notices };
}

/** The slots on one peer target that one worker's tests' peers take: `count` of them from `firstSlot`. */
export interface PeerSlots {
  readonly firstSlot: number;
  readonly count: number;
  /** What the peer target's `prepare` handed its workers, which the peer's engine reads the same way. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The slots worker `workerSlot` of `target` has on each target its tests put
 * a peer on. A target's slots are laid out as its own workers first, then one
 * block per target in `order` for the peers that target's workers bring, a
 * worker's peers side by side: no two users of a run share a slot.
 */
export function peerSlotsOf(
  target: string,
  workerSlot: number,
  order: readonly string[],
  workers: ReadonlyMap<string, number>,
  brought: PeersBrought,
): Record<string, PeerSlots> {
  const slots: Record<string, PeerSlots> = {};
  for (const [peerTargetName, count] of brought.get(target) ?? []) {
    let firstSlot = workers.get(peerTargetName) ?? 0;
    for (const before of order) {
      if (before === target) break;
      firstSlot += (workers.get(before) ?? 0) * (brought.get(before)?.get(peerTargetName) ?? 0);
    }
    slots[peerTargetName] = { firstSlot: firstSlot + workerSlot * count, count };
  }
  return slots;
}

/**
 * The slot the `index`th peer on `targetName` takes in a worker, from what
 * the run reserved for the worker. A peer the run reserved nothing for is an
 * error: it never takes a slot, or a device, the run did not set aside.
 */
export function reservedPeerSlot(reserved: Readonly<Record<string, PeerSlots>> | undefined, targetName: string, index: number, named: string): PeerSlots & { readonly slot: number } {
  const slots = reserved?.[targetName];
  if (slots === undefined || index >= slots.count) {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `${named} runs a peer on target "${targetName}", and the run reserved no slot there for it; a peer never takes a slot, or a device, the run did not set aside`,
    );
  }
  return { ...slots, slot: slots.firstSlot + index };
}
