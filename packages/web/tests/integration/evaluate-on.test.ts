import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { withTimeout, type LocatorExpression, type NodeRef, type OperationContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { connectionObjectCount } from '../helpers/handles.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const paragraph: LocatorExpression = { kind: 'selector', selector: 'p' };
const nameField: LocatorExpression = {
  kind: 'query',
  query: { kind: 'label', value: { kind: 'string', value: 'Name', exact: true } },
};

/**
 * Watches for the next Playwright handle dispose after this returns:
 * `released` resolves at that dispose, and the watch stops. A timed-out
 * `evaluateOn` keeps running in the background, and its first dispose comes
 * after any page code it ran, so a test that waits for it reads the page
 * state that call left.
 */
async function watchNextDispose(page: Page): Promise<{ readonly released: Promise<void>; readonly restore: () => void }> {
  const probe = await page.evaluateHandle('1');
  let owner: object | null = Object.getPrototypeOf(probe) as object | null;
  while (owner !== null && !Object.hasOwn(owner, 'dispose')) owner = Object.getPrototypeOf(owner) as object | null;
  await probe.dispose();
  if (owner === null) throw new Error('playwright-core handles no longer have a dispose method');
  const prototype = owner;
  const dispose = Reflect.get(prototype, 'dispose') as (this: unknown, ...args: unknown[]) => Promise<void>;
  let active = true;
  const restore = (): void => {
    if (!active) return;
    active = false;
    Reflect.set(prototype, 'dispose', dispose);
  };
  const released = new Promise<void>((resolve) => {
    Reflect.set(prototype, 'dispose', function watched(this: unknown, ...args: unknown[]) {
      restore();
      resolve();
      return dispose.apply(this, args);
    });
  });
  return { released, restore };
}

/**
 * Fires `onResolved` as soon as the next Playwright `elementHandles` lookup
 * receives real handles from the page, then restores the prototype method.
 */
function watchNextElementHandles(page: Page, onResolved: () => void): () => void {
  const probe = page.locator('p');
  let owner: object | null = Object.getPrototypeOf(probe) as object | null;
  while (owner !== null && !Object.hasOwn(owner, 'elementHandles')) owner = Object.getPrototypeOf(owner) as object | null;
  if (owner === null) throw new Error('playwright-core locators no longer have an elementHandles method');
  const prototype = owner;
  const elementHandles = Reflect.get(prototype, 'elementHandles') as (this: unknown, ...args: unknown[]) => Promise<unknown[]>;
  let active = true;
  const restore = (): void => {
    if (!active) return;
    active = false;
    Reflect.set(prototype, 'elementHandles', elementHandles);
  };
  Reflect.set(prototype, 'elementHandles', async function watched(this: unknown, ...args: unknown[]) {
    restore();
    const handles = await elementHandles.apply(this, args);
    onResolved();
    return handles;
  });
  return restore;
}

describe('PlaywrightSurface.evaluateOn', () => {
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-evaluate-on-'));
  const signal = new AbortController().signal;
  const operation: OperationContext = { signal, timeoutMs: 5_000, runId: 'evaluate-on', attemptId: 'evaluate-on', origin: 'test' };
  let page: Page;

  /** The ref of the one node `expression` matches now. */
  async function locateOne(expression: LocatorExpression): Promise<NodeRef> {
    const nodes = await surface.locate(expression, operation);
    expect(nodes).toHaveLength(1);
    return nodes[0]!.ref;
  }

  beforeAll(async () => {
    await surface.init({ runId: 'evaluate-on', targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'evaluate-on', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('reports a ref whose strict locator now matches two elements as retryable NODE_STALE', async () => {
    await page.setContent('<p>one</p>');
    const ref = await locateOne(paragraph);
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'test' }))
      .resolves.toEqual({ ok: true, value: 'one' });
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'two' })));
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'test' }))
      .rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reports a ref whose strict locator now matches nothing as retryable NODE_STALE', async () => {
    await page.setContent('<p>one</p>');
    const ref = await locateOne(paragraph);
    await page.evaluate(() => document.querySelector('p')!.remove());
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'test' }))
      .rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringContaining('matches 0 elements') });
  });

  it('releases the element and result handles of every evaluation', async () => {
    const objects = await connectionObjectCount(page);
    await page.setContent('<p>one</p>');
    const ref = await locateOne(paragraph);
    await surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'engine' });
    await page.evaluate('1');
    const before = objects();
    for (let index = 0; index < 50; index += 1) {
      await surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'engine' });
    }
    await page.evaluate('1');
    expect(objects() - before).toBeLessThanOrEqual(2);
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'two' })));
    const stale = objects();
    for (let index = 0; index < 25; index += 1) {
      await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, { owner: 'engine' }))
        .rejects.toMatchObject({ code: 'NODE_STALE' });
    }
    await page.evaluate('1');
    expect(objects() - stale).toBeLessThanOrEqual(2);
  });

  it('never starts the source or probes the page when aborted while the element was found', async () => {
    await page.setContent('<p>one</p>');
    const ref = await locateOne(paragraph);
    const objects = await connectionObjectCount(page);
    const controller = new AbortController();
    const { released, restore: restoreDispose } = await watchNextDispose(page);
    onTestFinished(restoreDispose);
    const restoreLookup = watchNextElementHandles(page, () => controller.abort());
    onTestFinished(restoreLookup);
    const locatorSpy = vi.spyOn(page, 'locator');
    onTestFinished(() => locatorSpy.mockRestore());
    try {
      await page.evaluate('1');
      const before = objects();
      await expect(
        surface.evaluateOn(
          ref,
          '() => { window.ran = true; return 1; }',
          undefined,
          { ...operation, signal: controller.signal },
          { owner: 'test' },
        ),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      await withTimeout(released, 5_000, () => new Error('timed out waiting for element handle dispose'));
      await expect(page.evaluate('window.ran')).resolves.toBeUndefined();
      expect(locatorSpy).not.toHaveBeenCalled();
      await page.evaluate('1');
      expect(objects() - before).toBe(0);
    } finally {
      restoreLookup();
      restoreDispose();
      locatorSpy.mockRestore();
    }
  });

  it.each([
    ['a label', nameField],
    ['a selector', { kind: 'selector', selector: 'input' } as const],
  ])('fails as EVALUATE_FAILED once the page replaced a built-in after %s located the node', async (_, expression) => {
    await page.setContent('<label>Name <input value="Ada"></label>');
    const ref = await locateOne(expression);
    await page.evaluate('window.Map = 1');
    await expect(surface.evaluateOn(ref, '(el) => el.value', undefined, operation, { owner: 'test' }))
      .rejects.toMatchObject({ code: 'EVALUATE_FAILED', category: 'test' });
  });
});
