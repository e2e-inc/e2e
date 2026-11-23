/**
 * `browser.setViewport` against a real page: a whole, non-negative size is
 * applied and recorded, and anything else is `INVALID_ARGUMENT` before the
 * engine is asked, so a test's arithmetic slip is not reported as an engine
 * failure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Answers every path with an empty page. */
function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Viewport</title>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('browser.setViewport', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-set-viewport-'));
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  let attached: unknown[];

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    await surface.init({ runId: 'viewport', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'viewport', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    attached = [];
    browser = createBrowserFixture(surface, {
      app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, `${origin}/`).href },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'viewport', attemptId: 'viewport', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachViewport: (size: unknown) => attached.push(size),
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('applies and records a whole-pixel size, zero included', async () => {
    await browser.setViewport({ width: 390, height: 844 });
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    await browser.setViewport({ width: 0, height: 0 });
    expect(page.viewportSize()).toEqual({ width: 0, height: 0 });
    expect(attached).toEqual([{ width: 390, height: 844, scale: 1 }, { width: 0, height: 0, scale: 1 }]);
  });

  it.each<[string, unknown, string]>([
    ['no size', undefined, ', got undefined'],
    ['null', null, ', got null'],
    ['a number', 390, ', got 390'],
    ['an array', [390, 844], ', got an array'],
    ['a missing height', { width: 800 }, ', got height undefined'],
    ['a fractional width', { width: 585.5, height: 600 }, ', got width 585.5'],
    ['a negative width', { width: -1, height: 600 }, ', got width -1'],
    ['a NaN height', { width: 800, height: Number.NaN }, ', got height NaN'],
    ['a string width', { width: '800', height: 600 }, ', got width "800"'],
  ])('refuses %s with INVALID_ARGUMENT, leaving the page as it was', async (_name, size, suffix) => {
    const before = page.viewportSize();
    expect(() => browser.setViewport(size as { width: number; height: number })).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: `browser.setViewport takes { width, height } in whole, non-negative pixels${suffix}`,
      }),
    );
    expect(page.viewportSize()).toEqual(before);
    expect(attached).toEqual([]);
  });

  it.each<[string, object, string]>([
    ['an unknown key', { width: 800, height: 600, deviceScaleFactor: 2 }, 'browser.setViewport size has unknown key "deviceScaleFactor"; expected one of width, height'],
    ['a misspelled key', { width: 800, heigth: 600 }, 'browser.setViewport size has unknown key "heigth"; did you mean "height"?'],
  ])('refuses %s with INVALID_ARGUMENT, naming it', async (_name, size, message) => {
    const before = page.viewportSize();
    expect(() => browser.setViewport(size as { width: number; height: number })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', message }));
    expect(page.viewportSize()).toEqual(before);
    expect(attached).toEqual([]);
  });
});
