/**
 * `attachBrowser`'s own `timeout`, which bounds attaching and every operation
 * after it together: once it runs out, the operation it cut short, each
 * operation started after it, and an attach still in flight fail
 * `TEST_TIMEOUT` naming that timeout, never as the `CANCELLED` of a caller
 * that gave up, which the caller's own `signal` still is.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachBrowser } from '../../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../../helpers/cdp-host.ts';

/** What the attach's timeout of `timeoutMs` fails an operation with. */
const ranOut = (timeoutMs: number) => ({
  code: 'TEST_TIMEOUT',
  message: `attachBrowser's timeout of ${String(timeoutMs)}ms ran out: it bounds attaching and every operation on the attached browser together. Pass a longer timeout`,
});

describe("attachBrowser's timeout", () => {
  let chrome: RemoteChrome;
  /** A DevTools endpoint that takes a connection and never answers it. */
  let silent: Server;
  let silentEndpoint: string;

  beforeAll(async () => {
    chrome = await launchRemoteChrome();
    silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    silentEndpoint = `http://127.0.0.1:${String((silent.address() as AddressInfo).port)}`;
  }, 60_000);

  afterAll(async () => {
    if (silent !== undefined) {
      const closed = new Promise<void>((resolve) => silent.close(() => resolve()));
      silent.closeAllConnections();
      await closed;
    }
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('fails the operation it cut short, and each one after it, as the timeout that ran out', async () => {
    const timeout = 5_000;
    const attached = await attachBrowser(`http://${new URL(chrome.endpoint).host}`, { timeout });
    try {
      await expect(attached.browser.evaluate(() => new Promise<null>(() => undefined))).rejects.toMatchObject(ranOut(timeout));
      await expect(attached.browser.url()).rejects.toMatchObject(ranOut(timeout));
      await expect(attached.screen.getByRole('button').count()).rejects.toMatchObject(ranOut(timeout));
      await expect(attached.screen.getByRole('button', 'Missing').tap()).rejects.toMatchObject(ranOut(timeout));
    } finally {
      await attached.close();
    }
  });

  it('fails an attach still in flight as the timeout that ran out', async () => {
    await expect(attachBrowser(silentEndpoint, { timeout: 500 })).rejects.toMatchObject(ranOut(500));
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31])('refuses a timeout of %s, which no timer can wait, before it attaches', async (timeout) => {
    await expect(attachBrowser(silentEndpoint, { timeout })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: `attachBrowser's timeout must be a whole number of milliseconds from 1 to 2147483647, got ${String(timeout)}`,
    });
  });

  it('attaches with the longest timeout a timer can wait', async () => {
    const attached = await attachBrowser(`http://${new URL(chrome.endpoint).host}`, { timeout: 2 ** 31 - 1 });
    try {
      expect(await attached.browser.evaluate(() => 1 + 1)).toBe(2);
    } finally {
      await attached.close();
    }
  });

  it("fails an attach the caller's own signal ended as cancelled", async () => {
    const caller = new AbortController();
    const attaching = attachBrowser(silentEndpoint, { signal: caller.signal });
    silent.once('request', () => caller.abort());
    await expect(attaching).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
