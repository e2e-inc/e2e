/**
 * Every engine operation goes through one guard: an error a route handler
 * latched fails the next step once, with its own classification, and an
 * operation already cancelled, or cancelled mid-flight, ends as `CANCELLED`.
 * The calls a fixture makes outside the guard refuse a fixture whose attempt
 * ended as the guard refuses its steps.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserFixture, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('the operation guard', () => {
  let session: WebSession;

  beforeAll(async () => {
    session = await startWebSession({ startAttempt: false });
    session.serve('/', '<!doctype html><title>Guard</title><h1>Guard</h1>');
    session.serve('/never', () => undefined);
  });

  beforeEach(async () => {
    await session.startAttempt();
    await session.open(`${session.origin}/`);
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  it('fails the next step once with the error a route handler latched, then runs steps again', async () => {
    await session.browser.route('**/api/undecided', async () => undefined);
    await session.browser.evaluate(() => fetch('/api/undecided').then(() => 'answered', () => 'aborted'));
    await expect(session.observe()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('route handler returned without calling fulfill'),
    });
    await expect(session.observe()).resolves.toBeDefined();
  });

  it.each(['waitForDownload', 'waitForPopup'] as const)('%s is guarded too: the latched error fails it before its trigger runs', async (wait) => {
    await session.browser.route('**/api/undecided', async () => undefined);
    await session.browser.evaluate(() => fetch('/api/undecided').then(() => 'answered', () => 'aborted'));
    let triggered = false;
    await expect(session.browser[wait](async () => { triggered = true; }, { timeout: 500 })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('route handler returned without calling fulfill'),
    });
    expect(triggered).toBe(false);
  });

  describe('a fixture whose attempt ended', () => {
    const ended = { code: 'INVALID_STATE', message: 'no attempt is running' };

    /** The runner's fixture, one no runner hosts (whose steps reach the engine), and a tab of the attempt, which then ends. */
    async function staleFixture() {
      const hosted = session.browser;
      const bare = browserFixture(session.engine, { baseUrl: session.origin });
      const [tab] = hosted.tabs();
      expect(tab!.isActive()).toBe(true);
      await session.endAttempt();
      return { hosted, bare, tab: tab! };
    }

    it('refuses its tabs, a dialog handler, and a step between attempts, and none of its tabs is active', async () => {
      const { hosted, bare, tab } = await staleFixture();
      expect(() => hosted.tabs()).toThrow(expect.objectContaining(ended));
      await expect(bare.onDialog(() => undefined)).rejects.toMatchObject(ended);
      await expect(bare.url()).rejects.toMatchObject(ended);
      expect(tab.isActive()).toBe(false);
    });

    it('refuses its tabs and a dialog handler while the next attempt runs, which keeps its own', async () => {
      const { hosted, bare, tab } = await staleFixture();
      await session.startAttempt();
      await session.open(`${session.origin}/`);
      expect(() => hosted.tabs()).toThrow(expect.objectContaining(ended));
      await expect(bare.onDialog(() => undefined)).rejects.toMatchObject(ended);
      expect(tab.isActive()).toBe(false);
      expect(session.browser.tabs()).toHaveLength(1);
    });
  });

  it('refuses an operation whose signal already aborted as CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(session.engine.observe!({ ...session.op(), signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
      retryable: false,
    });
  });

  it('stops waiting on an operation once its signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = session.engine.session!.open!(`${session.origin}/never`, { ...session.op(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
