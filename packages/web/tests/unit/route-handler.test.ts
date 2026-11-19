/**
 * The route handler contract the fixture runs over the network's decisions:
 * exactly one decision, options checked before it, and every failure
 * latched with the request aborted rather than left pending.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import type { RouteDecisions } from '../../src/driver/network-decisions.ts';
import { runRouteHandler } from '../../src/fixture/routes.ts';

const context = { app: { resolveUrl: (url: string) => new URL(url, 'http://app.test').href } } as EngineFixtureContext;

const REQUEST = { url: 'http://app.test/api/users', method: 'GET', headers: {} };

/** Decisions that record what the route decided. */
function adapter() {
  const calls: string[] = [];
  const held: RouteDecisions = {
    fetch: async () => {
      calls.push('fetch');
      return { url: 'http://app.test/api/users', status: 200, headers: { 'content-type': 'text/plain' }, body: async () => Buffer.from('upstream') };
    },
    fulfill: async (decision) => void calls.push(`fulfill ${decision.status}`),
    continue: async (decision) => void calls.push(`continue ${decision.url ?? ''}`),
    fallback: async () => void calls.push('fallback'),
    abort: async () => void calls.push('abort'),
  };
  return { held, calls };
}

describe('runRouteHandler', () => {
  it('passes one decision to the network', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler((route) => route.fulfill({ status: 204 }), REQUEST, held, (error) => latched.push(error), context, (file) => file);
    await runRouteHandler((route) => route.continue({ url: '/v2/users' }), REQUEST, held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['fulfill 204', 'continue http://app.test/v2/users']);
    expect(latched).toEqual([]);
  });

  it('reads the upstream response within the operation budget, and leaves the request undecided', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    const budget = { signal: new AbortController().signal, timeoutMs: 1_000 };
    const asked: unknown[] = [];
    held.fetch = async (given) => {
      asked.push(given);
      return { url: REQUEST.url, status: 200, headers: {}, body: async () => Buffer.from('{"ok":true}') };
    };
    const read: unknown[] = [];
    await runRouteHandler(async (route) => {
      const upstream = await route.fetch();
      read.push(upstream.status, await upstream.text(), await upstream.json(), (await upstream.body()).toString());
      await route.fulfill({ status: 204 });
    }, REQUEST, held, (error) => latched.push(error), { ...context, operation: () => budget } as never, (file) => file);
    expect(asked).toEqual([budget]);
    expect(read).toEqual([200, '{"ok":true}', { ok: true }, '{"ok":true}']);
    expect(calls).toEqual(['fulfill 204']);
    expect(latched).toEqual([]);
  });

  it('keeps a fetched body that could not be read for its readers to reject with', async () => {
    const { held } = adapter();
    const latched: Error[] = [];
    held.fetch = async () => ({ url: REQUEST.url, status: 200, headers: {}, body: async () => Promise.reject(new Error('terminated')) });
    let failure: unknown;
    await runRouteHandler(async (route) => {
      const upstream = await route.fetch();
      failure = await upstream.text().then(() => undefined, (cause: unknown) => cause);
      await route.abort();
    }, REQUEST, held, (error) => latched.push(error), { ...context, operation: () => ({ signal: new AbortController().signal, timeoutMs: 1_000 }) } as never, (file) => file);
    expect(failure).toMatchObject({ code: 'ACTION_FAILED', message: 'route.fetch: response body could not be read: terminated' });
    expect(latched).toEqual([]);
  });

  it('latches a second decision', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler(async (route) => {
      await route.abort();
      await route.fallback();
    }, REQUEST, held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['abort']);
    expect(latched.map((error) => error.message)).toEqual(['route handler already decided; fallback called twice']);
  });

  it('aborts and latches a handler that returns undecided or throws', async () => {
    const undecided = adapter();
    const latched: Error[] = [];
    await runRouteHandler(async () => undefined, REQUEST, undecided.held, (error) => latched.push(error), context, (file) => file);
    const throwing = adapter();
    await runRouteHandler(() => {
      throw new Error('handler exploded');
    }, REQUEST, throwing.held, (error) => latched.push(error), context, (file) => file);
    expect(undecided.calls).toEqual(['abort']);
    expect(throwing.calls).toEqual(['abort']);
    expect(latched.map((error) => error.message)).toEqual([
      'route handler returned without calling fulfill, continue, fallback, or abort',
      'handler exploded',
    ]);
  });

  it('refuses invalid options before deciding, so the request is still aborted', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler((route) => route.fulfill({ status: 42 }), REQUEST, held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['abort']);
    expect(latched[0]).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
