import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { gate } from '../helpers/gate.ts';

/**
 * One origin with a body for every outcome `waitForResponse` reports: a full
 * JSON body, a genuinely empty body under 200 and 204, a redirect whose body
 * the browser drops, and a body cut short by a connection reset before the
 * declared `Content-Length` was sent, one whose body follows its headers
 * only once the test calls `sendSlowBody`, and one that never finishes. The
 * fragment is flushed before the reset so the browser has seen the headers
 * and reports the response rather than an empty reply.
 */
function startBodyServer(): Promise<{ server: Server; url: string; sendSlowBody: () => void }> {
  const { held: slowBodyDue, release: sendSlowBody } = gate();
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/':
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Bodies</title><h1>Bodies</h1>');
        return;
      case '/api/full':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      case '/api/empty':
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '0' });
        response.end();
        return;
      case '/api/no-content':
        response.writeHead(204);
        response.end();
        return;
      case '/api/redirect':
        response.writeHead(302, { location: '/api/full', 'content-type': 'text/plain' });
        response.end('moved');
        return;
      case '/api/slow':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.flushHeaders();
        void slowBodyDue.then(() => response.end('slow-body'));
        return;
      case '/api/endless':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('a first chunk and never the rest');
        return;
      case '/api/cut':
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('{"partial":', () => {
          setTimeout(() => response.socket?.destroy(), 50);
        });
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, sendSlowBody });
    });
  });
}

describe('browser.waitForResponse bodies', () => {
  let session: WebSession;
  let server: Server;
  let origin: string;
  let browser: Browser;
  let sendSlowBody: () => void;

  beforeAll(async () => {
    ({ server, url: origin, sendSlowBody } = await startBodyServer());
    session = await startWebSession({ appUrl: origin, timeoutMs: 2_000, startAttempt: false });
  });

  beforeEach(async () => {
    await session.startAttempt();
    browser = session.browser;
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Fires one page-side fetch that reads its body the way an app does and
   * returns the response `waitForResponse` observed for it.
   */
  async function observe(pathname: string, options?: { timeout: number }) {
    await session.open(`${origin}/`);
    const [response] = await Promise.all([
      browser.waitForResponse(`**${pathname}`, options),
      browser.evaluate(
        (url: string) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); return null; },
        `${origin}${pathname}`,
      ),
    ]);
    return response;
  }

  it('observes the first navigation before any page is open', async () => {
    const [response] = await Promise.all([
      browser.waitForResponse(`${origin}/`),
      browser.goto('/'),
    ]);
    expect(response.url).toBe(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html');
    await expect(response.text()).resolves.toContain('<h1>Bodies</h1>');
  });

  it('reads a full body as text and JSON', async () => {
    const response = await observe('/api/full');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    ['/api/empty', 200],
    ['/api/no-content', 204],
  ])('resolves a genuinely empty body at %s to an empty string', async (pathname, status) => {
    const response = await observe(pathname);
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe('');
  });

  it('keeps the status of a body the connection cut short and rejects reading it', async () => {
    const response = await observe('/api/cut');
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${origin}/api/cut`);
    expect(response.headers['content-length']).toBe('1000');
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('waitForResponse: response body could not be read'),
    });
    await expect(response.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('matches on headers inside its timeout and lets text() wait for a slower body, on Chromium', async () => {
    try {
      // Firefox sends network.responseStarted only once the body starts, not when the headers arrive.
      if (onFirefox) return await expect(observe('/api/slow', { timeout: 500 })).rejects.toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('operation timed out in browser.waitForResponse') });
      // No body is sent before the wait settled, so the headers alone matched.
      const response = await observe('/api/slow');
      expect(response.status).toBe(200);
      const text = response.text();
      sendSlowBody();
      await expect(text).resolves.toBe('slow-body');
    } finally {
      sendSlowBody();
    }
  });

  it('rejects reading a body that never finishes once the action budget runs out', async () => {
    const response = await observe('/api/endless', { timeout: 500 });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'waitForResponse: response body did not finish within 2000ms',
    });
  });

  it('reads the body of the response a fulfilled redirect led to, not the body the route wrote', async () => {
    await session.open(`${origin}/`);
    await browser.route('**/api/moved', (route) => route.fulfill({ status: 302, headers: { location: '/api/full' }, body: 'moved' }));
    const [response] = await Promise.all([
      browser.waitForResponse('**/api/full'),
      browser.evaluate(
        (url: string) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); return null; },
        `${origin}/api/moved`,
      ),
    ]);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });

  it('resolves on the redirect a route fulfilled a request with, on Chromium', async () => {
    await browser.route('**/api/moved', (route) => route.fulfill({ status: 302, headers: { location: '/api/full' } }));
    // Firefox sends no response event for a redirect a route fulfilled, only the events of the hop it led to.
    if (onFirefox) return expect(observe('/api/moved', { timeout: 500 })).rejects.toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('operation timed out in browser.waitForResponse') });
    const response = await observe('/api/moved');
    expect(response.status).toBe(302);
  });

  it('keeps the status of a redirect and rejects reading its body', async () => {
    const response = await observe('/api/redirect');
    expect(response.status).toBe(302);
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('Response body is unavailable for redirect responses'),
    });
  });
});
