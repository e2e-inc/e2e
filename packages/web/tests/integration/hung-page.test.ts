/**
 * Every operation ends at its budget, whatever the page does: a server that
 * never answers a navigation, and a renderer stuck in a script a button
 * started. The browser answers none of these calls, so the operation's
 * deadline ends each one: `OPERATION_TIMEOUT`, or
 * `ACTION_MAY_HAVE_COMMITTED` for input, which may have reached the page.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'e2e';
import type { EngineFixtureContext, EngineHandle, NodeRef, OperationContext } from '@e2e-dev/core/engine';
import type { BrowserExpectation } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { byRole, cleanup, initInfo, onFirefox, operation as attemptOperation, startPageServer, testWeb, type PageServer } from '../helpers/web-session.ts';

const BUDGET_MS = 1_000;
/** The action timeout a read left to the harness's default budget takes. */
const ACTION_TIMEOUT_MS = 30_000;
/** How long past its budget a call may still be pending before the test calls it unbounded. */
const SLACK_MS = 1_000;
/** How much sooner than the budget a call may fail: the driver's own timeout fires 250 ms short of it (`DRIVER_TIMEOUT_LEAD_MS` in `src/driver/budget.ts`). */
const EARLY_MS = 300;

const BUSY_PAGE = `<!doctype html><title>Busy</title>
<button onclick="while (true) {}">Freeze</button>
<button>Next</button>`;

const COVERED_PAGE = `<!doctype html><title>Covered</title>
<button>Pay</button>
<div id="overlay" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3)"></div>`;

/** An operation of the attempt on the budget under test. */
function operation(): OperationContext {
  return attemptOperation('hung', { timeoutMs: BUDGET_MS });
}

/** An operation that sets a test up, on a page that answers: a first navigation of a new browser takes longer than the budget under test on a busy machine. */
function setup(): OperationContext {
  return attemptOperation('hung', { timeoutMs: 15_000 });
}

/**
 * Settles one call, or gives up on it a while after its budget: a call
 * still pending then is reported as such, so an unbounded one fails the test
 * at once instead of holding it to the vitest timeout. A call that failed
 * well before its budget fails the test too: the budget must bound it, not
 * cut it short.
 */
async function bounded(call: () => Promise<unknown>): Promise<{ error: unknown }> {
  const started = Date.now();
  const pending = Symbol('pending');
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    call().then(() => undefined, (error: unknown) => error),
    new Promise<typeof pending>((resolve) => { timer = setTimeout(() => resolve(pending), BUDGET_MS + SLACK_MS); }),
  ]);
  clearTimeout(timer);
  if (outcome === pending) throw new Error(`still pending ${BUDGET_MS + SLACK_MS}ms into a ${BUDGET_MS}ms budget`);
  expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - EARLY_MS);
  return { error: outcome };
}

describe('operations on a hung page', () => {
  let server: PageServer;
  let origin: string;
  let artifactsDir: string;
  let engine: EngineHandle;

  beforeAll(async () => {
    server = await startPageServer();
    ({ origin } = server);
    server.serve('/', BUSY_PAGE);
    server.serve('/covered', COVERED_PAGE);
    server.serve('/never', () => undefined);
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-hung-page-'));
  });

  afterAll(async () => {
    await server.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await engine.endAttempt!(cleanup(10_000));
    await engine.dispose!(cleanup(10_000));
  });

  /** Boots a fresh engine and attempt. */
  async function start(): Promise<void> {
    engine = testWeb();
    await engine.init!(initInfo({ app: { site: '127.0.0.1' } }));
    await engine.startAttempt!({ attemptId: 'hung', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  }

  /** Opens the busy page, observes it, and taps the button that starts the endless script. */
  async function freeze(): Promise<void> {
    await engine.session!.open!(`${origin}/`, setup());
    await engine.observe!(setup());
    const [target] = await engine.locate!(byRole('button', 'Freeze'), setup());
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  }

  /**
   * `expect(browser)` over the attempt, through a fixture context with the
   * harness's budgets: an operation with no explicit timeout gets the action
   * timeout.
   */
  function browserExpectation(): BrowserExpectation {
    let expectation: (() => unknown) | undefined;
    const context = {
      targetName: 'web',
      timeouts: { test: 60_000, action: ACTION_TIMEOUT_MS, assertion: BUDGET_MS },
      signal: new AbortController().signal,
      operation: (timeoutMs?: number) => ({ ...operation(), timeoutMs: Math.max(1, timeoutMs ?? ACTION_TIMEOUT_MS) }),
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      fixture: (_name: string, target: object) => target,
      expectable: (target: object, factory: () => unknown) => {
        expectation = factory;
        return target;
      },
    } as unknown as EngineFixtureContext;
    engine.fixtures!.browser!(context);
    return expectation!() as BrowserExpectation;
  }

  it('ends a browser assertion on a stuck page at its own timeout, not the action timeout', async () => {
    await start();
    await freeze();
    const expectation = browserExpectation();
    const title = await bounded(() => expectation.toHaveTitle('Other', { timeout: BUDGET_MS }));
    expect(title.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    // A locator read waits out the action timeout, as the harness's does.
    const card = {
      count: async () => 1,
      getAttribute: async () => {
        await engine.locate!(byRole('button', 'Next'), { ...operation(), timeoutMs: ACTION_TIMEOUT_MS });
        return 'card';
      },
    } as unknown as Locator;
    const negated = await bounded(() => expectation.not.toHaveClass(card, 'card', { timeout: BUDGET_MS }));
    expect(negated.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('fails a class assertion the deadline cut a later read of short with what the read before saw', async () => {
    await start();
    const expectation = browserExpectation();
    let reads = 0;
    const card = {
      count: async () => 1,
      getAttribute: async () => {
        reads += 1;
        if (reads > 1) await new Promise((resolve) => setTimeout(resolve, ACTION_TIMEOUT_MS));
        return 'card active';
      },
    } as unknown as Locator;
    const failed = await bounded(() => expectation.toHaveClass(card, 'card inactive', { timeout: BUDGET_MS }));
    expect(failed.error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: class "card active"') });
  });

  it('times out a navigation to a server that never answers', async () => {
    await start();
    const open = await bounded(() => engine.session!.open!(`${origin}/never`, operation()));
    expect(open.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('times out a locate and a point tap on a page whose renderer is stuck in a script', async () => {
    await start();
    await freeze();
    const locate = await bounded(() => engine.locate!(byRole('button', 'Next'), operation()));
    expect(locate.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    const tap = await bounded(() => engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation()));
    // Firefox sends a pointer only once the page rendered a frame, which a stuck renderer never does: no input went out.
    expect(tap.error).toMatchObject({ code: onFirefox ? 'OPERATION_TIMEOUT' : 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('keeps the reason the driver gives for a tap that cannot land, ahead of the deadline', async () => {
    await start();
    await engine.session!.open!(`${origin}/covered`, setup());
    const [target] = await engine.locate!(byRole('button', 'Pay'), setup());
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('intercepts pointer events') });
  });
});
