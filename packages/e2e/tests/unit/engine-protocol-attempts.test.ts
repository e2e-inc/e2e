/** The engine protocol with more than one attempt open at a time, and a target a worker prepares again as a host: what actors need of it. */

import { describe, expect, it, vi } from 'vitest';
import { defineEngine, type EngineAttemptContext } from '@e2e-dev/core/lib/engine/index';
import { attemptContext, cleanup, initInfo, operation, overLoopback, toy } from '../helpers/protocol-loopback.ts';

describe('engine protocol with more than one attempt', () => {
  it('runs two attempts at once for an engine that declares actors, each with its own callbacks and its own end', async () => {
    const started = new Map<string, EngineAttemptContext>();
    const ended: (string | undefined)[] = [];
    const settled: (string | undefined)[] = [];
    const { local, remote } = overLoopback(
      toy({
        actors: true,
        async startAttempt(context) {
          started.set(context.attemptId, context);
        },
        async settleAttempt(context) {
          settled.push(context.attemptId);
        },
        async endAttempt(context) {
          ended.push(context.attemptId);
        },
      }),
    );
    expect(local.capabilities.has('actors')).toBe(true);
    expect(remote.actors).toBe(true);
    expect(remote.capabilities.has('actors')).toBe(true);
    const received: string[] = [];
    const attempt = (attemptId: string): EngineAttemptContext => attemptContext(attemptId, { appLog: (entry) => received.push(`${attemptId}:${entry.text}`) });
    await remote.init!(initInfo());
    await remote.startAttempt!(attempt('test'));
    await remote.startAttempt!(attempt('actor'));
    // Both are open: a callback of either reaches the harness under its own attempt.
    started.get('test')!.appLog({ source: 'console', level: 'info', text: 'from the test' });
    started.get('actor')!.appLog({ source: 'console', level: 'info', text: 'from the actor' });
    await vi.waitFor(() => expect(received).toEqual(['test:from the test', 'actor:from the actor']));
    await remote.settleAttempt!({ ...cleanup, attemptId: 'actor' });
    await remote.endAttempt!({ ...cleanup, attemptId: 'actor' });
    // The actor's end leaves the test's attempt open.
    started.get('test')!.appLog({ source: 'console', level: 'info', text: 'still open' });
    started.get('actor')!.appLog({ source: 'console', level: 'info', text: 'after its end' });
    await vi.waitFor(() => expect(received).toContain('test:still open'));
    await remote.endAttempt!({ ...cleanup, attemptId: 'test' });
    expect(received).toEqual(['test:from the test', 'actor:from the actor', 'test:still open']);
    expect(settled).toEqual(['actor']);
    expect(ended).toEqual(['actor', 'test']);
    await remote.dispose!(cleanup);
  });

  it('keeps a signal two attempts share until the last of them ends', async () => {
    const seen = new Map<string, AbortSignal>();
    const { remote } = overLoopback(
      toy({
        actors: true,
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          seen.set(context.attemptId, context.signal);
        },
        startAttempt: async () => {},
        endAttempt: async () => {},
      }),
    );
    const attempt = attemptContext;
    // A test and its actor run on one budget: their calls carry the same signal.
    const shared = new AbortController();
    await remote.init!(initInfo());
    await remote.startAttempt!(attempt('test'));
    await remote.startAttempt!(attempt('actor'));
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, { ...operation(shared.signal), attemptId: 'test' });
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, { ...operation(shared.signal), attemptId: 'actor' });
    expect(seen.get('actor')).toBe(seen.get('test'));
    await remote.endAttempt!({ ...cleanup, attemptId: 'test' });
    shared.abort();
    // The attempt still open hears the abort, though the one that sent the signal first is gone.
    await vi.waitFor(() => expect(seen.get('actor')!.aborted).toBe(true));
    await remote.endAttempt!({ ...cleanup, attemptId: 'actor' });
    await remote.dispose!(cleanup);
  });

  it('refuses actors on an engine with no attempt hooks, and a value that is no boolean', () => {
    expect(() => defineEngine(toy({ actors: true }))).toThrow(/declares actors without startAttempt and endAttempt/);
    // @ts-expect-error actors is a boolean
    expect(() => defineEngine(toy({ actors: 'yes' }))).toThrow(/actors must be a boolean/);
    expect(defineEngine(toy({ actors: false })).capabilities.has('actors')).toBe(false);
  });

  it('finishes a target once for the run that prepared it and once for a host that prepared it again', async () => {
    const finished: (string | undefined)[] = [];
    const { remote } = overLoopback(
      toy({
        async prepare() {},
        async finish(info) {
          finished.push(info.hostId);
        },
      }),
    );
    const info = { runId: 'run', targetName: 'phone', env: {}, log: () => {} };
    const prepare = (hostId?: string) =>
      remote.prepare!({ ...info, ...(hostId === undefined ? {} : { hostId }), projectRoot: process.cwd(), app: {}, slots: 1, headed: false, signal: new AbortController().signal });
    // The run prepares the target for its setup tests; a worker prepares it again for an actor, as a host.
    await prepare();
    await prepare('host-1');
    await remote.finish!({ ...info, hostId: 'host-1', ...cleanup });
    await remote.finish!({ ...info, ...cleanup });
    expect(finished).toEqual(['host-1', undefined]);
  });
});
