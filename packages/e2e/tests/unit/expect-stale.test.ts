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

/** A screen whose reads answer `status` while `stale()` says no, and a retryable `NODE_STALE` while it says yes. */
function screenWith(stale: () => boolean) {
  return screenOver({
    locate: (expression) => {
      if (stale()) throw new EngineError('NODE_STALE', 'the app re-created the element while it was read', { retryable: true });
      return resolveExpression(expression, [status]);
    },
    observe: () => snapshot([status]),
    timeoutMs: 300,
  }).screen;
}

const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable('expected a failure'), (error: unknown) => error);

describe('a read the screen changed under', () => {
  it("fails a text assertion with the assertion's own message when every read is stale", async () => {
    const locator = screenWith(() => true).getByTestId('status');
    expect(await failure(expectFixture(locator).toHaveText('Synced', { timeout: 50 }))).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: no read: the screen changed under every read until the deadline'),
    });
  });

  it('reports the last value it read when the reads went stale after it', async () => {
    let reads = 0;
    const locator = screenWith(() => (reads += 1) > 1).getByTestId('status');
    const error = await failure(expectFixture(locator).toHaveText('Synced', { timeout: 50 }));
    expect(error).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('Syncing') });
    expect((error as Error).message).toContain('then a screen that changed under every read until the deadline');
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
      message: expect.stringContaining('did not become detached'),
    });
  });
});
