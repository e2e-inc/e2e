/**
 * A poll on an app that re-creates its elements under every read: the engine
 * answers a retryable `NODE_STALE` until the poll's deadline. The poll samples
 * again, and its timeout is the assertion's own failure, never a "node became
 * stale" and never a pass that a read which saw nothing would allow.
 */

import { describe, expect, it } from 'vitest';
import { EngineError, resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const status: SemanticNode = { ref: { id: 'status', revision: '' }, role: 'text', text: 'Syncing', testId: 'status' };

const RECREATED = 'the app re-created the element while it was read';

/** A screen whose reads answer `status` while `stale()` says no, and a retryable `NODE_STALE` (`why`) while it says yes. */
function screenWith(stale: () => boolean, why = RECREATED, measure?: () => { intersects: boolean; ratio?: number }) {
  return screenOver({
    locate: (expression) => {
      if (stale()) throw new EngineError('NODE_STALE', why, { retryable: true });
      return resolveExpression(expression, [status]);
    },
    observe: () => snapshot([status]),
    ...(measure === undefined ? {} : { viewportIntersection: () => measure() }),
    timeoutMs: 300,
  }).screen;
}

const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable('expected a failure'), (error: unknown) => error);

describe('a read the screen changed under', () => {
  it("fails a text assertion with the assertion's own message when every read is stale", async () => {
    const locator = screenWith(() => true).getByTestId('status');
    expect(await failure(expectFixture(locator).toHaveText('Synced', { timeout: 50 }))).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining(`observed: no read until the deadline: ${RECREATED}`),
    });
  });

  it("names the engine's reason a read failed, such as a locked screen, and keeps its error as the cause", async () => {
    const locked = "the Mac's screen is locked, so no window can be read; unlock it";
    const error = await failure(expectFixture(screenWith(() => true, locked).getByTestId('status')).toBeVisible({ timeout: 50 }));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining(`no read until the deadline: ${locked}`) });
    expect((error as Error).cause).toMatchObject({ message: expect.stringContaining(locked) });
  });

  it('reports the last value it read when the reads went stale after it', async () => {
    let reads = 0;
    const locator = screenWith(() => (reads += 1) > 1).getByTestId('status');
    const error = await failure(expectFixture(locator).toHaveText('Synced', { timeout: 50 }));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('Syncing') });
    expect((error as Error).message).toContain(`then no read until the deadline: ${RECREATED}`);
    expect((error as Error).message).not.toContain('node became stale');
  });

  it('passes once a read gets through within the timeout', async () => {
    let reads = 0;
    const locator = screenWith(() => (reads += 1) <= 3).getByTestId('status');
    await expectFixture(locator).toHaveText('Syncing', { timeout: 2_000 });
  });

  it('never lets a negated assertion pass on reads that saw nothing', async () => {
    const locator = screenWith(() => true).getByTestId('status');
    expect(await failure(expectFixture(locator).not.toBeVisible({ timeout: 50 }))).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(await failure(expectFixture(locator).toBeHidden({ timeout: 50 }))).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(await failure(expectFixture(locator).toHaveCount(0, { timeout: 50 }))).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(await failure(expectFixture(locator).toHaveText([], { timeout: 50 }))).toMatchObject({ code: 'ASSERTION_FAILED' });
  });

  it('times waitFor out on its own failure, never as a detached node', async () => {
    const locator = screenWith(() => true).getByTestId('status');
    expect(await failure(locator.waitFor({ state: 'detached', timeout: 50 }))).toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining(`did not become detached: getByTestId("status") (no read until the deadline: ${RECREATED})`),
    });
  });

  it('keeps the last measured sample of toBeInViewport when later reads go stale', async () => {
    let reads = 0;
    const locator = screenWith(() => (reads += 1) > 1, RECREATED, () => ({ intersects: false })).getByTestId('status');
    const error = await failure(expectFixture(locator).toBeInViewport({ timeout: 50 }));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining(`outside the viewport, then no read until the deadline: ${RECREATED} (match count 1)`) });
  });
});
