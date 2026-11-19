/** Page functions that hold a document still and cover its secure fields for one screenshot, and prove afterwards that the cover held. */

import { withDom } from './dom.ts';

/** One masking of the document, kept under its token until it is taken off: what `unmaskSecureFields` proves the cover by, the animations it stopped, and the two steps that take it off. */
type Mask = {
  readonly hosts: { container: Element | null; host: HTMLElement }[];
  readonly boxes: { field: Element; rect: DOMRect; box: HTMLElement }[];
  readonly selector: string;
  readonly cancelled: Animation[];
  readonly held: HeldAnimation[];
  /** Takes the cover off: the hosts, the caret's stylesheet, and this record. */
  readonly uncover: () => void;
  /**
   * Sets going again each animation the masking stopped, unless a capture
   * that overlaps this one still holds the document: that one takes them
   * over and sets them going when it lets go. A held one goes on from where
   * the clock would have it by now, unless the page ended it meanwhile. A
   * cancelled one plays again. A CSS animation the page dropped meanwhile
   * stays cancelled: its target no longer computes its name (a class
   * removed, the element out of the document), so the browser let go of it,
   * and played again it would run as a script animation no style could
   * stop. A script animation the page cancelled itself during the capture
   * reads the same as one the mask cancelled, and plays again; so does a
   * CSS animation the browser dropped from a target that still computes its
   * name (one hidden with `display: none`, or whose animation the page
   * started over).
   */
  readonly replay: () => void;
};

/** An animation a masking paused where it was, with the start time that puts it back on its clock; null for one that had yet to start. */
type HeldAnimation = { readonly animation: Animation; readonly startTime: CSSNumberish | null };

/**
 * What a masking does with the animations the clock moves. `finish` shows
 * them where they come to rest, the same on every capture: one that ends is
 * finished, and one that repeats forever is cancelled and played again.
 * `hold` pauses each where it is and puts it back on its clock, which leaves
 * the page as it was: nothing ends, and no event fires.
 */
export type AnimationStop = 'finish' | 'hold';

/**
 * Covers every secure field of the document, through open and recorded
 * closed shadow roots, with an opaque box, and hides the caret in the
 * document and each of those roots (with a stylesheet each adopts), for one
 * screenshot; returns how many fields it covered. A field inside a top-layer
 * element (a modal dialog, an open popover, a fullscreen element, found
 * through the composed tree, slots included) gets its box inside that
 * element, in its scaled coordinates, so the box moves with it however the
 * app reorders the top layer; any other field's box (and one in a top-layer
 * element turned or mirrored) sits in a manual popover of its own, above
 * what the app shows. Boxes live in closed shadow roots of hosts whose every
 * style is set inline as `!important`, so no page rule reaches them. `token`
 * names this masking for `unmaskSecureFields`; captures that overlap each
 * keep their own.
 *
 * Before any field is measured, so each is covered where it rests, it stops
 * every animation and transition the clock moves in the document and those
 * roots, as `stop` says (`AnimationStop`). To `finish`, one that ends is
 * finished, so the page gets its end events and keeps its end state, and
 * one that repeats forever is cancelled to the style under it, for
 * `unmaskSecureFields` to play again. To `hold`, each is paused where it
 * is, for `unmaskSecureFields` to put back on its clock. One that holds
 * still is left as the page set it: paused, at a zero playback rate, or
 * driven by a scroll position. The caret's stylesheet is adopted first, so
 * a transition of the caret color it starts in a field that transitions
 * `all` is stopped with the rest: a transition's value outranks the sheet's
 * `!important`, and the caret would fade through the screenshot.
 *
 * A masking that fails part way (a page that replaced `attachShadow` or
 * `showPopover`) takes off what it put on and sets its animations going
 * again before it throws.
 *
 * A document that leaves while masked takes its own masking off and plays
 * its animations again, on `pagehide`: the driver's unmask then reaches the
 * document that replaced it, which holds no such token, and a browser the
 * engine did not launch can keep this one masked in its back-forward cache
 * and show it so again on the way back.
 */
export const maskSecureFields = withDom((dom, selector: string, token: string, stop: AnimationStop): number => {
  const sheeted = dom.roots();
  const caret = new CSSStyleSheet();
  caret.replaceSync('input, textarea, [contenteditable] { caret-color: transparent !important; }');
  const cancelled: Animation[] = [];
  const held: HeldAnimation[] = [];
  const hosts = new Map<Element | null, { host: HTMLElement; layer: ShadowRoot }>();
  const kept: Map<string, Mask> | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask'));
  const masks = kept ?? new Map<string, Mask>();
  const uncover = (): void => {
    removeEventListener('pagehide', leave);
    masks.delete(token);
    for (const { host } of hosts.values()) host.remove();
    for (const root of sheeted) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== caret);
  };
  const dropped = (animation: Animation): boolean =>
    animation instanceof CSSAnimation && animation.effect instanceof KeyframeEffect && animation.effect.target !== null
    && !getComputedStyle(animation.effect.target, animation.effect.pseudoElement).animationName.split(', ').includes(CSS.escape(animation.animationName));
  const replay = (): void => {
    const overlapping: Mask | undefined = masks.values().next().value;
    if (overlapping !== undefined) {
      overlapping.cancelled.push(...cancelled);
      overlapping.held.push(...held);
      return;
    }
    for (const { animation, startTime } of held) {
      // One the page cancelled or finished meanwhile is no longer paused, and stays as the page left it.
      if (animation.playState !== 'paused') continue;
      try {
        if (startTime === null) animation.play();
        else animation.startTime = startTime;
      } catch {
        // play() refuses an animation with no end that the page turned backwards meanwhile.
      }
    }
    for (const animation of cancelled) {
      if (dropped(animation)) continue;
      try {
        animation.play();
      } catch {
        // play() refuses an animation with no end that plays backwards.
      }
    }
  };
  const leave = (): void => {
    uncover();
    replay();
  };
  const pin = (element: HTMLElement, styles: Record<string, string>): void => {
    element.style.setProperty('all', 'initial', 'important');
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  const layerOf = (field: Element): Element | null => {
    for (let at: Element | null = field; at !== null; at = dom.parentOf(at)) {
      if (dom.inTopLayer(at)) return dom.turned(at) ? null : at;
    }
    return null;
  };
  const hostFor = (container: Element | null): { host: HTMLElement; layer: ShadowRoot } => {
    let made = hosts.get(container);
    if (made === undefined) {
      const host = document.createElement('e2e-mask');
      pin(host, {
        display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
        opacity: '1', visibility: 'visible', overflow: 'visible', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647',
      });
      // Kept before it is shown, so a host that cannot be shown is still taken off.
      const entry = { host, layer: host.attachShadow({ mode: 'closed' }) };
      hosts.set(container, entry);
      if (container === null) {
        host.popover = 'manual';
        document.documentElement.append(host);
        host.showPopover();
      } else {
        container.append(host);
      }
      made = entry;
    }
    return made;
  };
  try {
    for (const root of sheeted) root.adoptedStyleSheets = [...root.adoptedStyleSheets, caret];
    for (const animation of sheeted.flatMap((root) => root.getAnimations())) {
      if (animation.playState !== 'running' || animation.playbackRate === 0 || !(animation.timeline instanceof DocumentTimeline)) continue;
      if (stop === 'hold') {
        const { startTime, currentTime } = animation;
        animation.pause();
        // A pause takes effect at the next frame; setting the time completes it now, where the animation is.
        animation.currentTime = currentTime;
        held.push({ animation, startTime });
        continue;
      }
      if (animation.effect?.getComputedTiming().endTime === Infinity) {
        animation.cancel();
        cancelled.push(animation);
        continue;
      }
      try {
        animation.finish();
      } catch {
        // finish() refuses an animation whose playback rate is turning zero, which holds still without it.
      }
    }
    const boxes: Mask['boxes'] = [];
    for (const field of sheeted.flatMap((root) => [...root.querySelectorAll(selector)])) {
      const rect = field.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const { host, layer } = hostFor(layerOf(field));
      const origin = host.getBoundingClientRect();
      const scaleX = host.offsetWidth > 0 ? origin.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight > 0 ? origin.height / host.offsetHeight : 1;
      const box = document.createElement('div');
      pin(box, {
        display: 'block', position: 'absolute',
        left: `${(rect.left - origin.left) / scaleX}px`, top: `${(rect.top - origin.top) / scaleY}px`, width: `${rect.width / scaleX}px`, height: `${rect.height / scaleY}px`,
        background: '#000', opacity: '1', visibility: 'visible', 'pointer-events': 'none',
      });
      layer.append(box);
      boxes.push({ field, rect, box });
    }
    addEventListener('pagehide', leave);
    masks.set(token, { hosts: [...hosts].map(([container, { host }]) => ({ container, host })), boxes, selector, cancelled, held, uncover, replay });
    Reflect.set(globalThis, Symbol.for('e2e.bidi.mask'), masks);
    return boxes.length;
  } catch (cause) {
    leave();
    throw cause;
  }
});

/**
 * Takes off what `maskSecureFields` put on. Returns whether the screenshot
 * taken between the two showed no secure field: this document holds the
 * masking under `token`, every host still where it was put (the popover
 * still open, each other host still inside its top-layer element) and
 * painted opaque, every box drawn over the whole of its field, every
 * covered field where its box was, and no visible secure field appeared
 * that no box covers.
 *
 * Last, once every field was read where it rested, it sets the animations
 * the masking stopped going again (`Mask.replay`).
 */
export const unmaskSecureFields = withDom((dom, token: string): boolean => {
  const masks: Map<string, Mask> | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask'));
  const mask = masks?.get(token);
  if (mask === undefined) return false;
  const painted = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
  };
  const placed = ({ container, host }: Mask['hosts'][number]): boolean =>
    (container === null ? host.matches(':popover-open') : host.parentNode === container && dom.inTopLayer(container)) && painted(host);
  const covers = ({ field, box }: Mask['boxes'][number]): boolean => {
    const target = field.getBoundingClientRect();
    const drawn = box.getBoundingClientRect();
    return drawn.left <= target.left + 0.5 && drawn.top <= target.top + 0.5 && drawn.right >= target.right - 0.5 && drawn.bottom >= target.bottom - 0.5;
  };
  const shown = mask.hosts.every(placed) && mask.boxes.every((entry) => painted(entry.box) && covers(entry));
  mask.uncover();
  const still = ({ field, rect }: Mask['boxes'][number]): boolean => {
    const now = field.getBoundingClientRect();
    return now.x === rect.x && now.y === rect.y && now.width === rect.width && now.height === rect.height;
  };
  const covered = new Set(mask.boxes.map(({ field }) => field));
  const uncovered = (field: Element): boolean => {
    const rect = field.getBoundingClientRect();
    return !covered.has(field) && rect.width > 0 && rect.height > 0;
  };
  const held = shown && mask.boxes.every(still) && !dom.roots().some((root) => [...root.querySelectorAll(mask.selector)].some(uncovered));
  mask.replay();
  return held;
});
