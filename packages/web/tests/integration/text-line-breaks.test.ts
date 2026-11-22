import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, LocatorExpression, OperationContext } from '@e2e-dev/core/engine';
import { surfaceOf, web } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const PAGE = `
  <p data-testid="address">Line one<br>line two</p>
  <p data-testid="spaced">Total due: 10</p>
  <p data-testid="glued">Item.sku(1)<br>[x]</p>
`;

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-breaks', attemptId: 'breaks-1', origin: 'test' };
}

function byText(value: string, exact = true): LocatorExpression {
  return { kind: 'query', query: { kind: 'text', value: { kind: 'string', value, exact } } };
}

describe('text queries across line breaks', () => {
  let app: FixtureApp;
  let artifactsDir: string;
  const engine: EngineHandle = web();
  const op = operation();
  const count = (expression: LocatorExpression) => engine.locate!(expression, op).then((nodes) => nodes.length);

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-breaks-'));
    await engine.init!({
      runId: 'run-breaks', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'breaks-1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, op);
    await surfaceOf(engine)!.page().setContent(PAGE);
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('matches the text a <br> separates as it reads', async () => {
    expect(await count(byText('Line one line two'))).toBe(1);
    expect(await count(byText('one LINE', false))).toBe(1);
    expect(await count(byText('Item.sku(1) [x]'))).toBe(1);
  });

  it('stays whole and case-sensitive when exact', async () => {
    expect(await count(byText('Total due: 10'))).toBe(1);
    expect(await count(byText('Line one'))).toBe(0);
    expect(await count(byText('line one line two'))).toBe(0);
  });
});
