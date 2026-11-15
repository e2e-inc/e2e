/**
 * Slots for peers: how many each target must serve beside its own workers,
 * how worker counts are lowered where an engine serves fewer, and which
 * slots each worker's peers take, so no two users of a run share one.
 */

import { describe, expect, it } from 'vitest';
import type { TestTargetPair } from '../../src/collect/select.ts';
import { fitWorkers, peerSlotsOf, peersBrought, reservedPeerSlot, slotsNeeded, type PeersBrought } from '../../src/run/peer-slots.ts';

/** A pair on `target` whose test declares one peer per entry of `peers`, each on the named target or the test's own. */
function pair(target: string, peers: readonly (string | undefined)[], disposition: TestTargetPair['disposition'] = 'run'): TestTargetPair {
  return {
    target: { name: target },
    disposition,
    options: { peers: peers.map((peer, index) => ({ name: `peer${index}`, ...(peer === undefined ? {} : { target: peer }) })) },
  } as unknown as TestTargetPair;
}

const brought = (entries: Record<string, Record<string, number>>): PeersBrought =>
  new Map(Object.entries(entries).map(([from, on]) => [from, new Map(Object.entries(on))]));

describe('peersBrought', () => {
  it('keeps, per test target, the most peers one runnable test puts on each target', () => {
    const counted = peersBrought({
      pairs: [
        pair('web', ['iphone', 'iphone', undefined]),
        // A later test with fewer peers leaves the most standing.
        pair('web', ['iphone']),
        pair('web', []),
        pair('iphone', [undefined]),
        // A test that does not run opens no peer.
        pair('web', ['iphone', 'iphone', 'iphone'], 'skip'),
      ],
    });
    expect([...counted].map(([from, on]) => [from, [...on]])).toEqual([
      ['web', [['iphone', 2], ['web', 1]]],
      ['iphone', [['iphone', 1]]],
    ]);
    expect(peersBrought({ pairs: [pair('web', [])] }).size).toBe(0);
  });
});

describe('slotsNeeded', () => {
  it("adds, to a target's own workers, a slot per peer every worker brings to it", () => {
    const peers = brought({ web: { iphone: 2 }, iphone: { iphone: 1 } });
    const workers = new Map([['web', 3], ['iphone', 2]]);
    // 2 own workers, each with 1 peer of its own, and 3 web workers with 2 peers each.
    expect(slotsNeeded('iphone', workers, peers)).toEqual({ slots: 10, peerSlots: 8 });
    expect(slotsNeeded('web', workers, peers)).toEqual({ slots: 3, peerSlots: 0 });
    expect(slotsNeeded('tablet', workers, peers)).toEqual({ slots: 0, peerSlots: 0 });
  });
});

describe('fitWorkers', () => {
  it('leaves every count as planned when each engine serves enough, or names no bound', () => {
    const fitted = fitWorkers(
      [{ name: 'web', workers: 2, served: undefined }, { name: 'iphone', workers: 1, served: 3 }],
      brought({ web: { iphone: 1 } }),
    );
    expect([...fitted.workers]).toEqual([['web', 2], ['iphone', 1]]);
    expect(fitted.notices).toEqual([]);
  });

  it("lowers a short target's own workers first, down to one, then the workers of the targets that bring it peers, and says so", () => {
    // 3 own workers and 2 web workers with a peer each need 5; the engine serves 3.
    const first = fitWorkers(
      [{ name: 'web', workers: 2, served: undefined }, { name: 'iphone', workers: 3, served: 3 }],
      brought({ web: { iphone: 1 } }),
    );
    expect([...first.workers]).toEqual([['web', 2], ['iphone', 1]]);
    expect(first.notices).toEqual([
      'target "iphone" runs 1 worker at a time, not 3: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
    ]);
    // With 2 served, its own worker stays and the web workers give way.
    const second = fitWorkers(
      [{ name: 'web', workers: 3, served: undefined }, { name: 'iphone', workers: 2, served: 2 }],
      brought({ web: { iphone: 1 } }),
    );
    expect([...second.workers]).toEqual([['web', 1], ['iphone', 1]]);
    // A count left above one reads in the plural.
    expect(fitWorkers([{ name: 'web', workers: 2, served: undefined }, { name: 'iphone', workers: 3, served: 4 }], brought({ web: { iphone: 1 } })).notices).toEqual([
      'target "iphone" runs 2 workers at a time, not 3: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
    ]);
    expect(second.notices).toEqual([
      'target "web" runs 1 worker at a time, not 3: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
      'target "iphone" runs 1 worker at a time, not 2: the peers of tests take slots of their own on their targets, and an engine serves only so many at once',
    ]);
  });

  it('lowers first the target whose workers bring the most peers', () => {
    const fitted = fitWorkers(
      [{ name: 'web', workers: 2, served: undefined }, { name: 'tablet', workers: 2, served: undefined }, { name: 'iphone', workers: 0, served: 5 }],
      brought({ web: { iphone: 1 }, tablet: { iphone: 2 } }),
    );
    // 2 + 4 needed of 5: one tablet worker fewer leaves 2 + 2.
    expect([...fitted.workers]).toEqual([['web', 2], ['tablet', 1], ['iphone', 0]]);
  });

  it("counts a target's own tests' peers with each of its own workers", () => {
    // Two devices: one worker, with its test's own user on one and the peer on the other.
    const fitted = fitWorkers([{ name: 'iphone', workers: 2, served: 2 }], brought({ iphone: { iphone: 1 } }));
    expect([...fitted.workers]).toEqual([['iphone', 1]]);
  });

  it('says nothing of an engine that serves fewer workers than planned when no peer took a slot', () => {
    const fitted = fitWorkers([{ name: 'iphone', workers: 3, served: 2 }, { name: 'web', workers: 2, served: undefined }], brought({ web: { web: 1 } }));
    expect([...fitted.workers]).toEqual([['iphone', 2], ['web', 2]]);
    expect(fitted.notices).toEqual([]);
    expect(fitWorkers([{ name: 'iphone', workers: 3, served: 2 }], new Map()).notices).toEqual([]);
  });

  it('fails, naming the target and the count, when it cannot serve one worker of each target at once', () => {
    expect(() =>
      fitWorkers([{ name: 'web', workers: 2, served: undefined }, { name: 'iphone', workers: 2, served: 1 }], brought({ web: { iphone: 1 } })),
    ).toThrow(
      'target "iphone" serves 1 at once, and this run needs 2 of it at once with one worker per target: 1 for its own worker, 1 for the peer of one "web" test; a peer takes a slot of its own, a device on a phone target, so give the target more, or keep the tests that put a peer on it out of this run',
    );
    // Its own tests' peers, and a target with no worker of its own.
    expect(() => fitWorkers([{ name: 'iphone', workers: 1, served: 2 }], brought({ iphone: { iphone: 2 } }))).toThrow(
      'serves 2 at once, and this run needs 3 of it at once with one worker per target: 1 for its own worker, 2 for the peers of one of its own tests;',
    );
    expect(() =>
      fitWorkers([{ name: 'web', workers: 1, served: undefined }, { name: 'iphone', workers: 0, served: 1 }], brought({ web: { iphone: 2 } })),
    ).toThrow('target "iphone" serves 1 at once, and this run needs 2 of it at once with one worker per target: 2 for the peers of one "web" test;');
    try {
      fitWorkers([{ name: 'iphone', workers: 1, served: 1 }], brought({ iphone: { iphone: 1 } }));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENGINE_FAILURE', category: 'infrastructure' });
    }
  });
});

describe('peerSlotsOf', () => {
  it("gives every worker's peers slots no worker and no other peer holds: the target's own workers first, then a block per target in order", () => {
    const peers = brought({ web: { iphone: 2 }, iphone: { iphone: 1 }, tablet: { iphone: 1, web: 1 } });
    const workers = new Map([['web', 2], ['iphone', 2], ['tablet', 1]]);
    const order = ['web', 'iphone', 'tablet'];
    const taken: number[] = [0, 1];
    for (const [target, count] of workers) {
      for (let slot = 0; slot < count; slot += 1) {
        const reserved = peerSlotsOf(target, slot, order, workers, peers)['iphone'];
        if (reserved !== undefined) for (let index = 0; index < reserved.count; index += 1) taken.push(reserved.firstSlot + index);
      }
    }
    // 2 own workers, 4 for the web workers' peers, 2 for its own workers' peers, 1 for the tablet worker's: every slot once.
    expect(taken.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(slotsNeeded('iphone', workers, peers).slots).toBe(9);
    expect(peerSlotsOf('web', 1, order, workers, peers)).toEqual({ iphone: { firstSlot: 4, count: 2 } });
    expect(peerSlotsOf('iphone', 1, order, workers, peers)).toEqual({ iphone: { firstSlot: 7, count: 1 } });
    expect(peerSlotsOf('tablet', 0, order, workers, peers)).toEqual({ iphone: { firstSlot: 8, count: 1 }, web: { firstSlot: 2, count: 1 } });
    expect(peerSlotsOf('web', 0, order, workers, brought({}))).toEqual({});
  });
});

describe('reservedPeerSlot', () => {
  it('gives each peer on a target the next reserved slot, with what the target handed its workers', () => {
    const reserved = { iphone: { firstSlot: 3, count: 2, env: { POOL: 'x' } } };
    expect(reservedPeerSlot(reserved, 'iphone', 0, 'test "pays"')).toEqual({ firstSlot: 3, count: 2, env: { POOL: 'x' }, slot: 3 });
    expect(reservedPeerSlot(reserved, 'iphone', 1, 'test "pays"').slot).toBe(4);
  });

  it('refuses a peer the run reserved nothing for, so it never takes a slot or a device another user holds', () => {
    const refusal = 'test "pays" runs a peer on target "iphone", and the run reserved no slot there for it; a peer never takes a slot, or a device, the run did not set aside';
    expect(() => reservedPeerSlot({ iphone: { firstSlot: 3, count: 2 } }, 'iphone', 2, 'test "pays"')).toThrow(refusal);
    expect(() => reservedPeerSlot({}, 'iphone', 0, 'test "pays"')).toThrow(refusal);
    expect(() => reservedPeerSlot(undefined, 'iphone', 0, 'test "pays"')).toThrow(refusal);
  });
});
