/**
 * Pointer drags. On Chromium, as Playwright's Chromium driver performs them:
 * a drag the page starts (an HTML5 `draggable` picked up) is intercepted
 * through CDP (`Input.setInterceptDrags`, reached with the mapper's
 * `goog:cdp` passthrough), and its enter, over, and drop are dispatched with
 * the drag data the page set (`Input.dispatchDragEvent`): a synthesized
 * mouse drag in headless Chromium drops without its `dataTransfer`. A drag
 * the page does not start stays plain pointer moves. Firefox's remote agent
 * drops no drag the page starts
 * (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879), so there one is
 * refused rather than left to end without a drop.
 */

import type { Protocol } from 'devtools-protocol';
import { EngineError, raceAbort } from '@e2e-dev/core/engine';
import type { BidiInput } from './input.ts';
import { releaseQuietly, unlessStale } from '../errors.ts';
import { dragPath, dragReleaseSources, moveSources, pressDownSources, releaseSources } from './input-sources.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction } from './script.ts';

type Point = { readonly x: number; readonly y: number };

/** Records, in the page, whether the next mouse move started a drag the page did not cancel. */
function watchDrag(): void {
  let started = Promise.resolve(false);
  let drag: DragEvent | null = null;
  const onDrag = (event: DragEvent): void => {
    drag = event;
  };
  const onMove = (): void => {
    started = new Promise((resolve) => {
      window.addEventListener('dragstart', onDrag, { once: true, capture: true });
      setTimeout(() => resolve(drag !== null && !drag.defaultPrevented), 0);
    });
  };
  window.addEventListener('mousemove', onMove, { once: true, capture: true });
  Reflect.set(window, Symbol.for('e2e.drag'), async () => {
    const value = await started;
    window.removeEventListener('mousemove', onMove, { capture: true });
    window.removeEventListener('dragstart', onDrag, { capture: true });
    return value;
  });
}

/** Whether the move `watchDrag` watched started a drag. */
function dragStarted(): Promise<boolean> | boolean {
  const check = Reflect.get(window, Symbol.for('e2e.drag')) as (() => Promise<boolean>) | undefined;
  return check === undefined ? false : check();
}

/**
 * Presses at `from`, then reads where the drag goes (`resolveTarget`), as
 * Playwright resolves a drop target only once the source is pressed, moves
 * there through `dragPath`, and releases; a drag the page starts on the
 * first move carries its data to the drop. The first move is one discrete
 * step, and the rest of a drag the page did not start take `durationMs`.
 * The button of a drag the page started is released before its enter,
 * over, and drop are dispatched: Chromium takes the release of a drag in
 * progress for its end and tells the page nothing of it, as with a
 * person's drag, where one sent after the drop reaches the page as a
 * `pointerup` and a `mouseup` no person's drag ends with.
 * Every input goes through `input`, the scripts and the drag event
 * subscription through `connection`. Once `signal` aborts, nothing more is
 * dispatched; however it ends, interception is off and the button is up
 * where the mouse last was, so a drag that failed midway drops nothing at
 * the target, and only the mouse is released, so keys the test holds stay
 * held.
 */
export async function chromiumDrag(
  input: BidiInput,
  connection: BidiConnection,
  context: string,
  documents: readonly string[],
  from: Point,
  resolveTarget: () => Promise<Point>,
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  let intercepted: (data: Protocol.Input.DragData) => void = () => undefined;
  const dragData = new Promise<Protocol.Input.DragData>((resolve) => (intercepted = resolve));
  const off = await input.onDragIntercepted((data) => intercepted(data));
  let subscription: string | undefined;
  let pressed = false;
  let intercepting = false;
  try {
    subscription = await connection.subscribeExtension(['goog:cdp.Input.dragIntercepted'], [context]);
    signal.throwIfAborted();
    pressed = true;
    await input.send(pressDownSources(from.x, from.y), signal);
    const [, first, ...rest] = dragPath(from, await resolveTarget());
    const last = rest.at(-1) ?? first!;
    // Armed after the press: armed before, it latches onto the move to the press point and misses the drag.
    await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, watchDrag), undefined)));
    signal.throwIfAborted();
    intercepting = true;
    await input.interceptDrags(true);
    // One discrete move, as Playwright's: an interpolated one would be checked before it passed the drag threshold.
    await input.send(moveSources(first!.x, first!.y), signal);
    const started = await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, dragStarted, [], { awaitPromise: true }), false)));
    const data = started.includes(true) ? await raceAbort(dragData, signal, 'drag') : undefined;
    signal.throwIfAborted();
    await input.interceptDrags(false);
    intercepting = false;
    if (data === undefined) {
      await input.send(dragReleaseSources(rest, durationMs), signal);
      pressed = false;
      return;
    }
    await input.send(releaseSources(), signal);
    pressed = false;
    await input.dragEvent('dragEnter', first!, data, signal);
    for (const point of rest) await input.dragEvent('dragOver', point, data, signal);
    await input.dragEvent('drop', last, data, signal);
  } finally {
    off();
    if (intercepting) await releaseQuietly(input.interceptDrags(false));
    if (pressed) await releaseQuietly(input.send(releaseSources()));
    if (subscription !== undefined) await releaseQuietly(connection.send('session.unsubscribe', { subscriptions: [subscription] }));
  }
}

/** Records, in the page, whether a drag it starts and does not cancel ends without a drop. */
function watchUndropped(): void {
  let started: DragEvent | null = null;
  let dropped = false;
  const onStart = (event: DragEvent): void => {
    started = event;
  };
  const onDrop = (): void => {
    dropped = true;
  };
  window.addEventListener('dragstart', onStart, { capture: true });
  window.addEventListener('drop', onDrop, { capture: true });
  Reflect.set(window, Symbol.for('e2e.undropped'), () => {
    window.removeEventListener('dragstart', onStart, { capture: true });
    window.removeEventListener('drop', onDrop, { capture: true });
    return started !== null && !started.defaultPrevented && !dropped;
  });
}

/** Whether the drag `watchUndropped` watched started and never dropped. */
function undropped(): boolean {
  const check = Reflect.get(window, Symbol.for('e2e.undropped')) as (() => boolean) | undefined;
  return check === undefined ? false : check();
}

/**
 * Presses at `from`, reads where the drag goes (`resolveTarget`), moves
 * there through `dragPath` over `durationMs`, and releases, on Firefox.
 * A drag the page started and did not cancel that ends without a drop is
 * refused as `UNSUPPORTED_CAPABILITY`. However it ends, the button is up.
 */
export async function firefoxDrag(
  input: BidiInput,
  connection: BidiConnection,
  documents: readonly string[],
  from: Point,
  resolveTarget: () => Promise<Point>,
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  await input.send(pressDownSources(from.x, from.y), signal);
  let released = false;
  try {
    const [, ...steps] = dragPath(from, await resolveTarget());
    await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, watchUndropped), undefined)));
    await input.send(dragReleaseSources(steps, durationMs), signal);
    released = true;
  } finally {
    if (!released) await releaseQuietly(input.send(releaseSources()));
  }
  const failed = await Promise.all(documents.map((each) => unlessStale(callFunction(connection, each, undropped), false)));
  if (failed.includes(true)) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'the page started an HTML5 drag, which Firefox drops nowhere over WebDriver BiDi (https://bugzilla.mozilla.org/show_bug.cgi?id=1515879)', { retryable: false });
  }
}
