import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { LocatorExpression, NodeRef, OperationContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const paragraph: LocatorExpression = { kind: 'selector', selector: 'p' };
const nameField: LocatorExpression = {
  kind: 'query',
  query: { kind: 'label', value: { kind: 'string', value: 'Name', exact: true } },
};

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
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, false))
      .resolves.toEqual({ ok: true, value: 'one' });
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'two' })));
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, false))
      .rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reports a ref whose strict locator now matches nothing as retryable NODE_STALE', async () => {
    await page.setContent('<p>one</p>');
    const ref = await locateOne(paragraph);
    await page.evaluate(() => document.querySelector('p')!.remove());
    await expect(surface.evaluateOn(ref, '(el) => el.textContent', undefined, operation, false))
      .rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringContaining('matches 0 elements') });
  });

  it.each([
    ['a label', nameField],
    ['a selector', { kind: 'selector', selector: 'input' } as const],
  ])('fails as EVALUATE_FAILED once the page replaced a built-in after %s located the node', async (_, expression) => {
    await page.setContent('<label>Name <input value="Ada"></label>');
    const ref = await locateOne(expression);
    await page.evaluate('window.Map = 1');
    await expect(surface.evaluateOn(ref, '(el) => el.value', undefined, operation, false))
      .rejects.toMatchObject({ code: 'EVALUATE_FAILED', category: 'test' });
  });
});
