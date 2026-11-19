/**
 * `afterTrigger`, the one wait on a test's own trigger: the wait runs once
 * the trigger returned, its timeout is told whether the trigger had resolved
 * and after how long, the trigger's own error leaves wrapped for `guard` to
 * hand back, cancellation ends it, the wait's signal aborts with either, and
 * a wait whose trigger returns after either never starts.
 */

import { describe, expect, it, vi } from 'vitest';
import { afterTrigger, TriggerFailure } from '../../src/driver/budget.ts';
import { gate } from '../helpers/gate.ts';

const never = new Promise<never>(() => undefined);
const waitForever = (): Promise<never> => never;
const budget = (timeoutMs: number, signal = new AbortController().signal) => ({ timeoutMs, signal });
const timedOut = (triggerMs: number | undefined): Error => new Error(triggerMs === undefined ? 'trigger pending' : `trigger took ${typeof triggerMs}`);

describe('afterTrigger', () => {
  it('runs the wait once the trigger returned, and resolves with it', async () => {
    const { held: trigger, release } = gate();
    let waits = 0;
    const waited = afterTrigger(() => trigger, async () => {
      waits += 1;
      return 'tab';
    }, budget(1_000), timedOut);
    const early = await Promise.race([waited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))]);
    expect([early, waits]).toEqual(['still waiting', 0]);
    release();
    expect(await waited).toBe('tab');
  });

  it('tells its timeout whether the trigger had resolved', async () => {
    await expect(afterTrigger(() => never, waitForever, budget(20), timedOut)).rejects.toThrow('trigger pending');
    await expect(afterTrigger(async () => undefined, waitForever, budget(20), timedOut)).rejects.toThrow('trigger took number');
  });

  it('bounds the wait by a budget that is a fraction of a millisecond, and aborts its signal when the budget runs out', async () => {
    let seen: AbortSignal | undefined;
    const waited = afterTrigger(async () => undefined, (signal) => {
      seen = signal;
      return never;
    }, budget(20.5), timedOut);
    await expect(waited).rejects.toThrow('trigger took number');
    expect(seen?.aborted).toBe(true);
  });

  it('leaves the signal of a wait that finished in time alone', async () => {
    let seen: AbortSignal | undefined;
    await afterTrigger(async () => undefined, async (signal) => {
      seen = signal;
    }, budget(1_000), timedOut);
    expect(seen?.aborted).toBe(false);
  });

  it('wraps what the trigger threw, a synchronous throw included, without waiting out the budget', async () => {
    const failure = new Error('trigger broke');
    const thrown = (await afterTrigger(async () => { throw failure; }, waitForever, budget(10_000), timedOut).catch((cause: unknown) => cause)) as TriggerFailure;
    expect(thrown).toBeInstanceOf(TriggerFailure);
    expect(thrown.thrown).toBe(failure);
    const sync = (() => { throw failure; }) as () => Promise<void>;
    await expect(afterTrigger(sync, waitForever, budget(10_000), timedOut)).rejects.toMatchObject({ thrown: failure });
  });

  it('ends as CANCELLED once its signal aborts, and so does the signal of the wait', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const waited = afterTrigger(async () => undefined, (signal) => {
      seen = signal;
      return never;
    }, budget(10_000, controller.signal), timedOut);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    await expect(waited).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(seen?.aborted).toBe(true);
  });

  it('ends as CANCELLED while the trigger is still pending', async () => {
    const controller = new AbortController();
    const waited = afterTrigger(() => never, waitForever, budget(10_000, controller.signal), timedOut);
    controller.abort();
    await expect(waited).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.each(['the budget ran out', 'it was cancelled'])('never starts the wait of a trigger that returns after %s', async (ending) => {
    const controller = new AbortController();
    const { held: trigger, release } = gate();
    let waits = 0;
    const waited = afterTrigger(() => trigger, async () => {
      waits += 1;
    }, budget(ending === 'the budget ran out' ? 20 : 10_000, controller.signal), timedOut);
    if (ending === 'it was cancelled') controller.abort();
    await expect(waited).rejects.toThrow(ending === 'the budget ran out' ? 'trigger pending' : 'trigger wait cancelled');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waits).toBe(0);
  });
});
