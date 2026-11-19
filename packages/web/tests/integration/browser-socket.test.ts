/**
 * What the driver's WebSocket to a browser has to carry, on every Node the
 * engine runs on: a message of several megabytes, which a browser sends
 * whole (a value a page call returns, a response body a wait reads), and
 * more than 4096 commands on one connection. Node 22's own client fails
 * both: it drops a connection on a compressed message over 4 MB, which is
 * what Chrome sends a client that offers compression, and it masks every
 * frame after a process's 4096th with zeros, which Firefox answers by
 * closing the connection.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

const SIX_MB = 6 * 1024 * 1024;

describe('the connection to the browser', () => {
  let session: WebSession;
  let browser: Browser;
  let page: string;

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 20_000, startAttempt: false });
    page = session.serve('/page', '<!doctype html><title>Large</title><h1>Large</h1>');
    session.serve('/large', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SIX_MB) });
      response.end(Buffer.alloc(SIX_MB, 7));
    });
  });

  beforeEach(async () => {
    await session.startAttempt();
    browser = session.browser;
    await browser.goto(page);
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  it('still answers after 4500 commands', async () => {
    let sum = 0;
    for (let sent = 0; sent < 4500; sent += 1) sum += await browser.evaluate((value) => value, 1);
    expect(sum).toBe(4500);
    expect(await browser.evaluate(() => document.title)).toBe('Large');
  }, 120_000);

  it('returns a 6 MB string from a page call', async () => {
    const text = await browser.evaluate((length) => 'x'.repeat(length), SIX_MB);
    expect(text.length).toBe(SIX_MB);
  });

  it('reads a 6 MB response body, and the page still answers', async () => {
    const [response, received] = await Promise.all([
      browser.waitForResponse('**/large'),
      browser.evaluate(async () => (await (await fetch('/large')).arrayBuffer()).byteLength),
    ]);
    expect(received).toBe(SIX_MB);
    const body = await response.body();
    expect(body.length).toBe(SIX_MB);
    expect(body.every((byte) => byte === 7)).toBe(true);
    expect(await browser.evaluate(() => document.title)).toBe('Large');
  });
});
