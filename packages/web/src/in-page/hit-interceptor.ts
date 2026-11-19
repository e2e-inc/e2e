/**
 * The click watch: capture listeners on a document's window, which decide
 * whether the input of a click reaches the element it was aimed at and
 * suppress it when it does not. A document gets them from its preload,
 * ahead of the page's own scripts, when the attempt adopts the tab it was
 * already open in, or with the first watch armed in it.
 */

import { withDom, type Outcome } from './dom.ts';

/** What an armed watch leaves for the listeners: the element the input must reach, and their verdict once an event arrived. */
type HitWatch = { readonly target: Element; verdict: Outcome | undefined };

/**
 * Adds the click watch's capture listeners to the window and arms the watch
 * for the input about to reach `element`, as Playwright's hit target
 * interceptor: the first press, release, or click decides whether the input
 * reaches the element (retargeted to its button or link, through slots,
 * shadow hosts, and recorded closed roots), and every later one is
 * suppressed when it did not. Only trusted events count: one the page
 * dispatched itself (`el.click()`, `dispatchEvent`) is the app's own,
 * neither judged nor suppressed. `hitInterceptorResult` reads the decision.
 *
 * The first call in a document builds the listeners, which do nothing until
 * a watch is armed, keeps what adds them (`listen`) for every call to run,
 * and keeps the page's `Event` as it is then for the driver's edits
 * (`dom.keepEvent`). A call with no element arms nothing. The preload's is
 * one, before the page's own scripts, so the listeners sit ahead of any the
 * app adds. A document open before the attempt gets the same call when the
 * attempt adopts its tab (`AttemptUserContext.prepareOpen`), and any other
 * document no preload ran in gets its listeners with the first watch armed
 * there: in both, behind the capture listeners the app already has on the
 * window.
 */
const watchHits = withDom((dom, element: Element | null): void => {
  let listen: (() => void) | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.listen'));
  if (listen === undefined) {
    const contains = (target: Element, x: number, y: number): boolean => {
      const hit = dom.hitAt(x, y);
      return hit !== null && dom.reaches(hit, target);
    };
    /** True for an element of any realm: one adopted from a frame may not be an `Element` of this window. */
    const isElement = (target: EventTarget | undefined): target is Element => target !== undefined && 'nodeType' in target && target.nodeType === 1;
    const listener = (event: MouseEvent): void => {
      const watch: HitWatch | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.active'));
      if (watch === undefined || !event.isTrusted) return;
      if (watch.verdict === undefined) {
        const path = event.composedPath();
        const reached = path.includes(watch.target) || contains(watch.target, event.clientX, event.clientY);
        const [hit] = path;
        watch.verdict = reached ? { kind: 'ok' } : dom.interceptedBy(isElement(hit) ? hit : undefined);
      }
      if (watch.verdict.kind !== 'ok') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    let listeningIn: Document | undefined;
    /**
     * Adds the listeners to the window, which can lose them, or stop hearing
     * through them, with no preload running again. `document.open()` erases a
     * window's listeners, in Chromium and in Firefox, and adding the same
     * function again restores them. A frame's window kept from its first,
     * empty document for the document that loads next keeps them registered,
     * so adding them again does nothing. Firefox goes on delivering to them;
     * Chromium delivers them no event until they are removed and added again,
     * though a function the window never had works once added. So they are
     * removed first only when the window shows another document than the one
     * they were last added in (`listeningIn`): removed every time, they would
     * sit behind the app's own capture listeners on the window at every click.
     */
    listen = (): void => {
      const kept = listeningIn !== undefined && listeningIn !== document;
      listeningIn = document;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const) {
        if (kept) window.removeEventListener(type, listener, { capture: true });
        window.addEventListener(type, listener, { capture: true });
      }
    };
    Reflect.set(globalThis, Symbol.for('e2e.bidi.hit.listen'), listen);
    dom.keepEvent();
  }
  listen();
  if (element === null) return;
  const watch: HitWatch = { target: dom.pointerTarget(element), verdict: undefined };
  Reflect.set(globalThis, Symbol.for('e2e.bidi.hit.active'), watch);
});

/** `watchHits` with no element, as a script: a preload runs it before the page's own scripts, so no listener of the app runs ahead of the watch's. */
export const HIT_INTERCEPTOR_INIT_SCRIPT = `(${watchHits.toString()})(null);`;

/** `watchHits` as the driver calls it, for the element a click is about to reach: it cannot arm nothing. */
export const armHitInterceptor: (element: Element) => void = watchHits;

/**
 * Ends the click watch: `ok` when the input reached the element, or when
 * the document it was armed in is gone (the click navigated, so it landed);
 * not yet, with what took the input, when it did not; `unseen` when no input
 * reached this document.
 */
export function hitInterceptorResult(): Outcome | { readonly kind: 'unseen' } {
  const watch: HitWatch | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.active'));
  Reflect.deleteProperty(globalThis, Symbol.for('e2e.bidi.hit.active'));
  if (watch === undefined) return { kind: 'ok' };
  return watch.verdict ?? { kind: 'unseen' };
}
