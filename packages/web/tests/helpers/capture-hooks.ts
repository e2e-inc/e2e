/** What a test does around the screenshots the driver takes, and what a capture holds of a page meanwhile. */

import { vi } from 'vitest';
import type { EngineSnapshot } from '@e2e-dev/core/engine';
import { BidiConnection } from '../../src/driver/connection.ts';
import { unmaskSecureFields } from '../../src/in-page/mask.ts';
import type { WebSession } from './web-session.ts';

/**
 * What a test does around each screenshot, counted from 1: `before` once the
 * page is masked and the capture is about to be sent, `after` once the
 * browser answered it, each with the connection and the browsing context the
 * capture is of, and `unmask` before a document is told to take its masks
 * off. A `before` that throws fails the capture in the browser's place.
 */
export interface CaptureHooks {
  readonly before?: (order: number, connection: BidiConnection, context: string) => Promise<void>;
  readonly after?: (order: number, connection: BidiConnection, context: string) => void;
  readonly unmask?: () => Promise<void>;
}

/** Runs `hooks` around every screenshot the driver takes, until the test restores its mocks. */
export function aroundCapture(hooks: CaptureHooks): void {
  const send = BidiConnection.prototype.send;
  let captures = 0;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(async function (this: BidiConnection, method, params) {
    const order = method === 'browsingContext.captureScreenshot' ? (captures += 1) : 0;
    if (order > 0) await hooks.before?.(order, this, (params as { context: string }).context);
    if (method === 'script.callFunction' && (params as { functionDeclaration: string }).functionDeclaration === unmaskSecureFields.toString()) await hooks.unmask?.();
    const result = await send.call(this, method, params);
    if (order > 0) hooks.after?.(order, this, (params as { context: string }).context);
    return result;
  });
}

/** One agent observation of `session`'s page with pixels, on a 5 s budget: the capture that masks fields and hides carets. */
export function observeWithPixels(session: WebSession): Promise<EngineSnapshot> {
  return session.engine.observe!({ ...session.op(5_000), origin: 'agent' }, { pixels: true });
}

/** What a capture holds of the document: its mask hosts, the stylesheets it adopted, and the animations left to run on its `#blink`. Runs in the page. */
export function heldByCapture(): string {
  return `${String(document.querySelectorAll('e2e-mask').length)} hosts, ${String(document.adoptedStyleSheets.length)} sheets, ${String(document.getElementById('blink')!.getAnimations().length)} animations`;
}
