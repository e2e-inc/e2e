/**
 * Actors on the web engine: a second attempt started while another runs is
 * a browser context of its own in the same browser. Each attempt keeps its
 * own page, cookies, storage, and routes, operations reach the attempt they
 * name, and ending one leaves the other open.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle, OperationContext, SemanticNode } from '@e2e-dev/core/engine';
import { surfaceOf, web } from '../../src/engine.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** `/` greets whoever the `user` cookie names, with a button that changes the heading. */
function startApp(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const user = /(?:^|; )user=([^;]*)/u.exec(request.headers.cookie ?? '')?.[1] ?? 'nobody';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>${user}</title><h1>Hello ${user}</h1><button onclick="document.querySelector('h1').textContent = 'Clicked by ${user}'">Go</button>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

/** Every node of a tree, depth first. */
const nodes = (node: SemanticNode): SemanticNode[] => [node, ...(node.children ?? []).flatMap(nodes)];

describe('two attempts at once on one web engine', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-web-actors-'));
  const signal = new AbortController().signal;
  const operation = (attemptId: string): OperationContext => ({ signal, timeoutMs: 10_000, runId: 'actors', attemptId, origin: 'test' });
  const start = (engine: EngineHandle, attemptId: string) =>
    engine.startAttempt!({ attemptId, artifactsDir: path.join(projectRoot, attemptId), signal, resolveSecret: noSecrets, ...ignoreTrace });
  const heading = async (engine: EngineHandle, attemptId: string): Promise<string | undefined> =>
    nodes((await engine.observe!(operation(attemptId))).root).find((node) => node.role === 'heading')?.name;
  let engine: EngineHandle;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    ({ server, origin } = await startApp());
    engine = web({ viewport: { width: 320, height: 200 } });
    await engine.init!({ runId: 'actors', targetName: 'web', projectRoot, app: { site: '127.0.0.1', origin }, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await start(engine, 'test');
    await start(engine, 'actor');
  });

  afterAll(async () => {
    await engine.dispose!({ signal, timeoutMs: 10_000 });
    await new Promise((resolve) => server.close(resolve));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('declares the capability, and not for a persistent context, which has no second one to give', () => {
    expect(engine.capabilities.has('actors')).toBe(true);
    const persistent = web({ connect: { cdpEndpoint: async () => 'ws://127.0.0.1:1', reconnectEndpoint: async () => 'ws://127.0.0.1:1' } });
    expect(persistent.capabilities.has('actors')).toBe(false);
  });

  it('gives each attempt a context of its own in one browser', async () => {
    const own = surfaceOf(engine, 'test')!.context();
    await engine.session!.open!(`${origin}/`, operation('test'));
    await engine.session!.open!(`${origin}/`, operation('actor'));
    expect(own.browser()!.contexts()).toHaveLength(2);
    expect(surfaceOf(engine, 'actor')!.context()).not.toBe(own);
  });

  it('reads the page of the attempt surfaceOf names, and refuses to pick one of several without an id', async () => {
    await engine.session!.open!(`${origin}/?test`, operation('test'));
    await engine.session!.open!(`${origin}/?actor`, operation('actor'));
    expect(surfaceOf(engine, 'test')!.page().url()).toBe(`${origin}/?test`);
    expect(surfaceOf(engine, 'actor')!.page().url()).toBe(`${origin}/?actor`);
    const live = surfaceOf(engine)!;
    for (const read of [() => live.page(), () => live.context()]) {
      expect(read).toThrow(expect.objectContaining({ code: 'INVALID_STATE', message: expect.stringContaining('surfaceOf(engine, attemptId)') }));
    }
    expect(() => surfaceOf(engine, 'nobody')!.page()).toThrow(/the attempt this call belongs to is not running/);
  });

  it('keeps cookies and what an operation changes to the attempt it names', async () => {
    await engine.state!.restore({ format: 'playwright-storage-state', version: 1, data: { cookies: [{ name: 'user', value: 'ada', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } }, operation('actor'));
    await engine.session!.open!(`${origin}/`, operation('test'));
    await engine.session!.open!(`${origin}/`, operation('actor'));
    expect(await heading(engine, 'test')).toBe('Hello nobody');
    expect(await heading(engine, 'actor')).toBe('Hello ada');

    const observed = await engine.observe!(operation('actor'));
    const button = nodes(observed.root).find((node) => node.role === 'button')!;
    await engine.perform!(button.ref, { kind: 'tap' }, operation('actor'));
    expect(await heading(engine, 'actor')).toBe('Clicked by ada');
    expect(await heading(engine, 'test')).toBe('Hello nobody');
  });

  it('ends one attempt and leaves the other open', async () => {
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'actor' });
    expect(await heading(engine, 'test')).toBe('Hello nobody');
    // One attempt is open again, so no id is needed to read it.
    expect(surfaceOf(engine)!.context().browser()!.contexts()).toHaveLength(1);
    // A call still on its way to the ended actor fails, and never lands on the test's own page.
    await expect(async () => engine.observe!(operation('actor'))).rejects.toThrow(/the attempt this call belongs to is not running/);
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'test' });
    await expect(engine.observe!(operation('test'))).rejects.toThrow(/no attempt is running/);
    // Nor on the page of the test that runs next.
    await start(engine, 'next');
    await engine.session!.open!(`${origin}/`, operation('next'));
    await expect(async () => engine.session!.open!(`${origin}/?late`, operation('actor'))).rejects.toThrow(/the attempt this call belongs to is not running/);
    await expect(async () => engine.session!.open!(`${origin}/?late`, operation('test'))).rejects.toThrow(/the attempt this call belongs to is not running/);
    expect(await heading(engine, 'next')).toBe('Hello nobody');
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'next' });
  });

  it('runs two attempts of a test that has none of its own', async () => {
    await start(engine, 'author');
    await start(engine, 'reviewer');
    await engine.session!.open!(`${origin}/`, operation('author'));
    await engine.session!.open!(`${origin}/`, operation('reviewer'));
    expect(surfaceOf(engine, 'author')!.context().browser()!.contexts()).toHaveLength(2);

    // The first ends while the second runs: a call still on its way to it never lands on the second's page.
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'author' });
    await expect(async () => engine.observe!(operation('author'))).rejects.toThrow(/the attempt this call belongs to is not running/);
    expect(await heading(engine, 'reviewer')).toBe('Hello nobody');

    // Nor on the page of the next test, whose first attempt starts while the second of this one is still open.
    await start(engine, 'next-author');
    await engine.session!.open!(`${origin}/`, operation('next-author'));
    await expect(async () => engine.session!.open!(`${origin}/?late`, operation('author'))).rejects.toThrow(/the attempt this call belongs to is not running/);
    expect(await heading(engine, 'next-author')).toBe('Hello nobody');
    expect(surfaceOf(engine, 'next-author')!.context().browser()!.contexts()).toHaveLength(2);
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'reviewer' });
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'next-author' });
  });

  it('runs an attempt again under an id that ended', async () => {
    await start(engine, 'author');
    await engine.session!.open!(`${origin}/`, operation('author'));
    expect(await heading(engine, 'author')).toBe('Hello nobody');
    await engine.endAttempt!({ signal, timeoutMs: 5_000, attemptId: 'author' });
  });
});
