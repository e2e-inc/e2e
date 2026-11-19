/**
 * An artifact screenshot taken while the page navigates captures the
 * document showing, masked, instead of failing because the document its
 * masks were resolved in went away.
 */

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePng } from '../helpers/png.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';
import { BidiError } from '../../src/errors.ts';

/** `/hop?n=<n>` holds a white password field on a white page and moves on to the next hop a moment after it loads, up to 40. */
function hop(request: IncomingMessage, response: ServerResponse): void {
  const n = Number(new URL(request.url ?? '/', 'http://host').searchParams.get('n') ?? '0');
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Hop ${n}</title>
    <style>body { margin: 0; background: #fff; } input { position: absolute; left: 20px; top: 20px; width: 120px; height: 40px; border: 0; background: #fff; color: #fff; }</style>
    <input type="password" value="hunter22">
    <script>if (${n} < 40) setTimeout(() => { location.href = '/hop?n=${n + 1}'; }, 1);</script>`);
}

describe('screenshot while navigating', () => {
  let session: WebSession;
  let origin: string;

  /** Takes a screenshot and asserts the password field is covered by the opaque mask, not left white. */
  const expectMaskedShot = async (label: string): Promise<void> => {
    const relative = await session.engine.artifacts!.screenshot!(label, session.op(10_000));
    const image = decodePng(readFileSync(path.join(session.artifactsDir, relative)));
    expect(image.pixelAt(80, 40)).toEqual([0, 0, 0, 255]);
    expect(image.pixelAt(200, 150)).toEqual([255, 255, 255, 255]);
  };

  beforeAll(async () => {
    session = await startWebSession({ web: { viewport: { width: 320, height: 200 } }, startAttempt: false });
    origin = session.origin;
    session.serve('/hop', hop);
  });

  beforeEach(async () => {
    await session.startAttempt();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  it('captures each screenshot, masked, while the page hops between documents', async () => {
    await session.open(`${origin}/hop?n=0`);
    for (let shot = 0; shot < 10; shot += 1) await expectMaskedShot(`hop-${shot}`);
  });

  it('retries the capture when the navigation event arrives after the capture error', async () => {
    await session.open(`${origin}/hop?n=40`);
    const send = BidiConnection.prototype.send;
    let captures = 0;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      const capture = method === 'browsingContext.captureScreenshot';
      if (capture) captures += 1;
      if (!capture || captures > 1) return send.call(this, method, params);
      const { context } = params as { context: string };
      // A timer is a macrotask, so the event reaches the listeners only after the capture's rejection did.
      setTimeout(() => {
        const event = { type: 'event', method: 'browsingContext.navigationStarted', params: { context, navigation: null, timestamp: Date.now(), url: `${origin}/hop?n=40` } };
        (this as unknown as { receive(raw: string): void }).receive(JSON.stringify(event));
      }, 0);
      return Promise.reject(new BidiError(method, 'unknown error', 'Unable to capture screenshot'));
    });
    await expectMaskedShot('late-event');
    expect(captures).toBe(2);
  });

  it('takes a capture again when a navigation committed while the page was masked, even if the capture answered', async () => {
    await session.open(`${origin}/hop?n=40`);
    const send = BidiConnection.prototype.send;
    let captures = 0;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(async function (this: BidiConnection, method, params) {
      const capture = method === 'browsingContext.captureScreenshot';
      if (capture) captures += 1;
      const result = await send.call(this, method, params);
      if (capture && captures === 1) {
        // Firefox may snapshot the document a navigation just committed while scripts still run in the masked one.
        const { context } = params as { context: string };
        const event = { type: 'event', method: 'browsingContext.navigationCommitted', params: { context, navigation: null, timestamp: Date.now(), url: `${origin}/hop?n=40` } };
        (this as unknown as { receive(raw: string): void }).receive(JSON.stringify(event));
      }
      return result;
    });
    await expectMaskedShot('committed');
    expect(captures).toBe(2);
  });

  it('keeps any other capture failure an engine failure, tried once', async () => {
    await session.open(`${origin}/hop?n=40`);
    const send = BidiConnection.prototype.send;
    let captures = 0;
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      if (method !== 'browsingContext.captureScreenshot') return send.call(this, method, params);
      captures += 1;
      return Promise.reject(new BidiError(method, 'unknown error', 'the capture failed'));
    });
    await expect(session.engine.artifacts!.screenshot!('closed', session.op())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(captures).toBe(1);
  });
});
