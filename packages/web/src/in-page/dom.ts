/**
 * What the driver's page functions share. Each page function is serialized
 * with `toString()` and runs in the page, so none closes over module scope:
 * one that needs the DOM helpers (`createDom`) takes them through `withDom`,
 * which splices their source into its own, and each helper is written once.
 * `Outcome` is the answer they give the driver about acting on an element.
 */

import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';

/**
 * What a page function answers about acting on an element. `kind` alone
 * decides what the driver does next (`settle` in `actions.ts`): `ok` is done,
 * with whatever the function read; `detached` is an element out of the
 * document; `not-yet` is a state the app may leave, polled until the
 * deadline; `refused` is one it will not, and may follow a change the
 * function already made. `reason` is the words a failure carries, written
 * for a person and never matched.
 */
export type Outcome<T extends object = object> =
  | ({ readonly kind: 'ok' } & T)
  | { readonly kind: 'detached' }
  | { readonly kind: 'not-yet'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** The sides of a box in its document's viewport. */
export interface Area {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A box in its document's viewport, by its top-left corner and its size: a type alias, so it crosses to the page as an argument. */
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * An ancestor that clips an element's boxes: the element, the box it clips
 * them to (`clipEdge` in `createDom`), its border box, and the axes it
 * clips on. The border box is as the browser reports it, so a box flush
 * with it compares equal to it, where the edge is a sum that may differ
 * from such a box by a rounding of floats.
 */
interface Clipper {
  readonly element: Element;
  readonly edge: Area;
  readonly bounds: DOMRect;
  readonly x: boolean;
  readonly y: boolean;
}

/**
 * Builds the helpers over the closed shadow roots recorded under `key`,
 * read when a helper runs, so roots recorded after the helpers were built
 * count too. Self-contained: its source is what `withDom` splices in.
 */
export function createDom(key: string) {
  const recorded = (): WeakMap<Element, ShadowRoot> | undefined => Reflect.get(globalThis, Symbol.for(key));

  /** The element's open or recorded closed shadow root. */
  const shadowOf = (element: Element): ShadowRoot | null => element.shadowRoot ?? recorded()?.get(element) ?? null;

  /** The document and every open or recorded closed shadow root under it, outermost first. */
  const roots = (): (Document | ShadowRoot)[] => {
    const found: (Document | ShadowRoot)[] = [document];
    for (let index = 0; index < found.length; index += 1) {
      for (const element of found[index]!.querySelectorAll('*')) {
        const shadow = shadowOf(element);
        if (shadow !== null) found.push(shadow);
      }
    }
    return found;
  };

  /** The element's parent element, else the host of the shadow root it is a child of. */
  const parentOrHostOf = (at: Element): Element | null => at.parentElement ?? (at.parentNode instanceof ShadowRoot ? at.parentNode.host : null);

  /**
   * The element's parent in the flat tree: the slot it is assigned to (in a
   * recorded closed root too, whose slots still list what they hold), else
   * its parent element or shadow host. A slot assigned to another slot is
   * that slot's child, so the lists are read unflattened.
   */
  const parentOf = (at: Element): Element | null => {
    if (at.assignedSlot !== null) return at.assignedSlot;
    const closed = at.parentElement === null ? undefined : recorded()?.get(at.parentElement);
    for (const slot of closed?.querySelectorAll('slot') ?? []) if (slot.assignedElements().includes(at)) return slot;
    return parentOrHostOf(at);
  };

  /** Whether a rotation, skew, reflection, or 3D transform turns the element: its own, or a flat-tree ancestor's (`transform`, `rotate`, or a negative `scale`). */
  const turned = (from: Element): boolean => {
    for (let at: Element | null = from; at !== null; at = parentOf(at)) {
      const style = getComputedStyle(at);
      if (style.rotate !== 'none' || style.scale.includes('-')) return true;
      if (style.transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return true;
    }
    return false;
  };

  /** The boxes the element lays out: its client rects, or those of its contents for a `display: contents` element, which has none of its own. */
  const rectsOf = (element: Element): DOMRect[] => {
    const own = [...element.getClientRects()];
    if (own.length > 0 || getComputedStyle(element).display !== 'contents') return own;
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()];
  };

  /** The box an action reads the element by: its first, for a `display: contents` element the first of its contents with a size, else its bounding box. */
  const boxOf = (element: Element): DOMRect =>
    element.getClientRects()[0] ?? rectsOf(element).find((rect) => rect.width > 0 && rect.height > 0) ?? element.getBoundingClientRect();

  /** The visual viewport's size, the window's without one. */
  const viewport = (): { width: number; height: number } => ({ width: visualViewport?.width || innerWidth, height: visualViewport?.height || innerHeight });

  /** What to scroll to bring the element into view: itself when it lays out a box, else the first element inside it that does, else its parent. */
  const scrollTarget = (element: Element): Element | null =>
    element.getClientRects().length > 0 ? element : ([...element.querySelectorAll('*')].find((child) => child.getClientRects().length > 0) ?? element.parentElement);

  /**
   * Whether the style turns a containment on (CSS Containment 2): a
   * `contain` other than `none`, a `content-visibility` other than
   * `visible`, or a `container-type` of `size` or `inline-size`. It reads
   * the style alone: a containment with no effect on the element's kind of
   * box (an inline one, a table row) counts too.
   */
  const contained = (style: CSSStyleDeclaration): boolean =>
    style.contain !== 'none' || style.contentVisibility !== 'visible' || style.containerType.includes('size');

  /**
   * Whether the viewport takes the element's `overflow`, which leaves the
   * element a used value of `visible` (CSS Overflow 3, "Overflow viewport
   * propagation"): the root element's, and in its place that of the first
   * `<body>` child of an `<html>` root, while the root's is `visible` on
   * both axes and neither of the two has a containment (`contained`). A
   * later `<body>` keeps its own even when the first is `display: none`,
   * as Chromium and Firefox both have it, where the spec names the later one.
   */
  const viewportTakesOverflow = (element: Element): boolean => {
    const root = document.documentElement;
    if (element === root) return true;
    if (!(root instanceof HTMLHtmlElement) || element.parentNode !== root) return false;
    const rootStyle = getComputedStyle(root);
    if (rootStyle.overflowX !== 'visible' || rootStyle.overflowY !== 'visible' || contained(rootStyle)) return false;
    const body = [...root.children].find((child) => child instanceof HTMLBodyElement);
    return body === element && !contained(getComputedStyle(element));
  };

  /** Whether the element is in the top layer: a modal dialog, an open popover, or a fullscreen element. */
  const inTopLayer = (element: Element): boolean => element.matches(':modal, :popover-open, :fullscreen');

  /**
   * The flat-tree parent whose box the element's own is laid out under;
   * none for a top-layer element (`inTopLayer`), which is laid out against
   * the viewport whatever holds it in the document.
   */
  const layoutParentOf = (element: Element): Element | null => (inTopLayer(element) ? null : parentOf(element));

  /**
   * Whether a box of `style` has layout containment (`layout`) or paint
   * containment (`paint`) on (CSS Containment 2): its `contain` names the
   * kind, or `strict` or `content`, which hold both, or its
   * `content-visibility` is `auto` or `hidden`: `auto` turns layout, style,
   * and paint containment on whether or not the box is on screen, and
   * `hidden` every containment, as it skips its contents. Neither is on
   * for a box that takes none: a non-atomic inline box, an internal table
   * box other than a cell, an internal ruby box, and an element that lays
   * out no box (`display: contents`).
   */
  const contains = (style: CSSStyleDeclaration, kind: 'layout' | 'paint'): boolean =>
    !/^(?:inline(?: list-item)?|contents|none|ruby(?:-.*)?|table-(?:row|column|header|footer)(?:-group)?)$/.test(style.display)
    && (['auto', 'hidden'].includes(style.contentVisibility) || style.contain.split(' ').some((value) => value === kind || value === 'strict' || value === 'content'));

  /**
   * Whether a box with `style` is the containing block of its `fixed` and
   * `absolute` descendants whatever its `position`: one with a transform of
   * any kind, a filter, a perspective, or layout or paint containment
   * (`contains`), or whose `will-change` names a property that would make
   * it one.
   */
  const holdsPositioned = (style: CSSStyleDeclaration): boolean =>
    [style.transform, style.translate, style.rotate, style.scale, style.perspective, style.filter, style.backdropFilter].some((value) => value !== undefined && value !== '' && value !== 'none')
    || contains(style, 'layout')
    || contains(style, 'paint')
    || /\b(?:transform|translate|rotate|scale|perspective|filter|contain)\b/.test(style.willChange);

  /**
   * The box `at`, laid out on `bounds`, clips its content to: its padding
   * box, and for a clip at the overflow clip edge (`margin`: `overflow:
   * clip` and paint containment, CSS Overflow 3) the box its
   * `overflow-clip-margin` names, the padding box when it names none, grown
   * by that margin's length. Border, padding, and margin are scaled as the
   * box is, by its laid-out size where it has one (an SVG element has
   * none). It is read as a rectangle: what a `border-radius` rounds off a
   * corner is left to the hit test at the action's point.
   */
  const clipEdge = (at: Element, style: CSSStyleDeclaration, bounds: DOMRect, margin: boolean): Area => {
    const clipMargin = margin ? style.getPropertyValue('overflow-clip-margin') : '';
    const box = /content-box|border-box/.exec(clipMargin)?.[0] ?? 'padding-box';
    const grown = Number.parseFloat(/[\d.]+px/.exec(clipMargin)?.[0] ?? '') || 0;
    /** How far inside the border box the edge sits on `side`, before scaling; negative where the margin puts it outside. */
    const inset = (side: 'Top' | 'Right' | 'Bottom' | 'Left'): number =>
      (box === 'border-box' ? 0 : Number.parseFloat(style[`border${side}Width`]) || 0) + (box === 'content-box' ? Number.parseFloat(style[`padding${side}`]) || 0 : 0) - grown;
    const { offsetWidth, offsetHeight } = at as Element & Partial<Pick<HTMLElement, 'offsetWidth' | 'offsetHeight'>>;
    const scaleX = offsetWidth ? bounds.width / offsetWidth : 1;
    const scaleY = offsetHeight ? bounds.height / offsetHeight : 1;
    return {
      left: bounds.left + inset('Left') * scaleX,
      top: bounds.top + inset('Top') * scaleY,
      right: bounds.right - inset('Right') * scaleX,
      bottom: bounds.bottom - inset('Bottom') * scaleY,
    };
  };

  /**
   * The ancestors that clip the element's boxes, innermost first
   * (`Clipper`). One clips on the axes its used `overflow` is not `visible`
   * on: its computed one, but `visible` for one whose `overflow` the
   * viewport takes (`viewportTakesOverflow`), and with paint containment
   * (`contains`) `clip` in place of `visible`, so such a box clips on both
   * axes whatever its `overflow`. They are the flat-tree ancestors the
   * element is laid out in, up to the top-layer element that holds it
   * (`layoutParentOf`): one a `fixed` or `absolute` box is not laid out
   * against clips nothing of it, nor does a `display: contents` one, which
   * lays out no box to clip to or to lay a box out against, whatever its
   * `position` or `transform`. A `display: contents` element's own boxes
   * are its contents', laid out in its parent whatever its `position`.
   */
  const clippers = (element: Element): Clipper[] => {
    const found: Clipper[] = [];
    const own = getComputedStyle(element);
    let position = own.display === 'contents' ? 'static' : own.position;
    for (let at = layoutParentOf(element); at !== null; at = layoutParentOf(at)) {
      const style = getComputedStyle(at);
      if (style.display === 'contents') continue;
      const holds = holdsPositioned(style);
      if (position === 'fixed' && !holds) continue;
      if (position === 'absolute' && !holds && style.position === 'static') continue;
      position = style.position;
      const taken = viewportTakesOverflow(at);
      const paint = contains(style, 'paint');
      const [x, y] = [style.overflowX, style.overflowY].map((computed) => {
        const used = taken ? 'visible' : computed;
        return used === 'visible' && paint ? 'clip' : used;
      });
      if (x === 'visible' && y === 'visible') continue;
      const bounds = at.getBoundingClientRect();
      found.push({ element: at, edge: clipEdge(at, style, bounds, x === 'clip' || y === 'clip'), bounds, x: x !== 'visible', y: y !== 'visible' });
    }
    return found;
  };

  /**
   * What shows of `rect`, a box of `element`: what the viewport and every
   * ancestor that clips the element (`clippers`) leave of it; null when
   * under a pixel does.
   */
  const clipped = (element: Element, rect: DOMRect): Area | null => {
    const { width, height } = viewport();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, width);
    let bottom = Math.min(rect.bottom, height);
    for (const { edge, x, y } of clippers(element)) {
      if (x) {
        left = Math.max(left, edge.left);
        right = Math.min(right, edge.right);
      }
      if (y) {
        top = Math.max(top, edge.top);
        bottom = Math.min(bottom, edge.bottom);
      }
    }
    return (right - left) * (bottom - top) > 0.99 && right > left && bottom > top ? { left, top, right, bottom } : null;
  };

  /** What shows (`clipped`) of the first of the element's boxes that shows at all; null when none does. */
  const visibleArea = (element: Element): Area | null => {
    for (const rect of rectsOf(element)) {
      const area = clipped(element, rect);
      if (area !== null) return area;
    }
    return null;
  };

  /** Scrolls the element to the centre of the view unless the centre of its box already shows (`visibleArea`). */
  const scrollIfClipped = (element: Element): void => {
    const area = visibleArea(element);
    const rect = boxOf(element);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (area !== null && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) return;
    (scrollTarget(element) ?? element).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  };

  /**
   * Where Chromium's center-if-needed, which Playwright's rect scroll uses,
   * puts a box spanning `start` to `end` on one axis of a view `view` long:
   * `nearest`, where it is, for one inside the view, `center` for one
   * wholly out, and its closest edge for one partly out, `start` unless it
   * is smaller than the view and past its end or larger and short of it.
   */
  const alignment = (start: number, end: number, view: number): ScrollLogicalPosition => {
    if (start >= 0 && end <= view) return 'nearest';
    if (end <= 0 || start >= view) return 'center';
    return (end > view && end - start < view) || (end < view && end - start > view) ? 'end' : 'start';
  };

  /**
   * Lands the page's scroll offset on whole device pixels, as Chromium
   * does; down, so a fractional end still fits. Firefox keeps a fractional
   * offset in layout but paints at a whole-pixel one, so a box's pixels
   * would sit a pixel from where it reports.
   */
  const landOnPixels = (): void => {
    /** `offset` on the whole device pixel at or before it. */
    const whole = (offset: number): number => Math.floor(offset * devicePixelRatio) / devicePixelRatio;
    if (whole(scrollX) !== scrollX || whole(scrollY) !== scrollY) scrollTo({ left: whole(scrollX), top: whole(scrollY), behavior: 'instant' });
  };

  /** Not yet, for an element with no box a person could see. */
  const hidden: Outcome<never> = { kind: 'not-yet', reason: 'element is not visible' };

  /**
   * Whether a flat-tree ancestor with `content-visibility: hidden` skips the
   * element: it keeps the box it was laid out with, and the browser neither
   * paints it nor lets a pointer reach it, as the reader's `hidden` state
   * has it (`isSkippedContent` in `read-semantics.ts`).
   */
  const skipped = (element: Element): boolean => {
    for (let at = parentOf(element); at !== null; at = parentOf(at)) if (getComputedStyle(at).contentVisibility === 'hidden') return true;
    return false;
  };

  /** Whether the element shows, before anything about a pointer: attached, laying out a box, not `visibility: hidden`, and not content the browser skips (`skipped`). */
  const shown = (element: Element): Outcome => {
    if (!element.isConnected) return { kind: 'detached' };
    const box = boxOf(element);
    return box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden' || skipped(element) ? hidden : { kind: 'ok' };
  };

  /**
   * The box `read` answers once it held still for a frame: read in two
   * frames whose animation time differs, since a frame that repeats the
   * time shows no motion. Not yet while there is no box to read, or it
   * moved between the two.
   */
  const still = async (read: () => DOMRect | null): Promise<Outcome<{ box: DOMRect }>> => {
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const first = await frame();
    const before = read();
    if (before === null) return hidden;
    for (let tries = 0; tries < 5 && (await frame()) === first; tries += 1);
    const box = read();
    if (box === null) return hidden;
    const held = box.x === before.x && box.y === before.y && box.width === before.width && box.height === before.height;
    return held ? { kind: 'ok', box } : { kind: 'not-yet', reason: 'element is not stable' };
  };

  /** The element a pointer event for `element` must reach, as Playwright's hit check retargets it: the button or link that holds it, unless it is a field or an editing host. */
  const pointerTarget = (element: Element): Element =>
    element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable
      ? element
      : (element.closest('button, [role=button], a, [role=link]') ?? element);

  /** The element a pointer event at `x`, `y` of this document hits, descending through open and recorded closed shadow roots. */
  const hitAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    for (let root = hit === null ? null : shadowOf(hit); hit !== null && root !== null; root = shadowOf(hit)) {
      const inner = root.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  /** Whether an event on `hit` reaches `target`: `target` is `hit` or one of its flat-tree ancestors. */
  const reaches = (hit: Element, target: Element): boolean => {
    for (let at: Element | null = hit; at !== null; at = parentOf(at)) if (at === target) return true;
    return false;
  };

  /** Not yet, for a pointer event that `hit` takes in place of the element it was meant for; undefined for something that is no element. */
  const interceptedBy = (hit: Element | undefined): Outcome<never> => ({
    kind: 'not-yet',
    reason: `${hit === undefined ? 'another element' : `<${hit.localName}${hit.id === '' ? '' : `#${hit.id}`}>`} intercepts pointer events`,
  });

  /** The element holding focus in this document, followed through open and recorded closed shadow roots. */
  const activeElement = (): Element | null => {
    let active = document.activeElement;
    for (let inner = active === null ? null : shadowOf(active)?.activeElement; inner !== null && inner !== undefined; inner = shadowOf(inner)?.activeElement) active = inner;
    return active;
  };

  /** Focuses `element`; whether focus landed on it, or on the editing host that holds it. */
  const focus = (element: Element): boolean => {
    (element as HTMLElement).focus();
    const active = activeElement();
    return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
  };

  /**
   * The control an edit of `element` goes to, as Playwright retargets one: a
   * label, or an element inside one that is no control itself, stands for
   * the label's control.
   */
  const control = (element: Element): Element => {
    if (element.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]') || (element as HTMLElement).isContentEditable) return element;
    return element.closest('label')?.control ?? element;
  };

  /** Where `keepEvent` keeps the page's own `Event` constructor for `fireEdit`. */
  const eventKey = 'e2e.bidi.Event';

  /** Keeps the page's own `Event` constructor, which a page may replace later; the click watch's preload calls it before the page's scripts run. */
  const keepEvent = (): void => {
    Reflect.set(globalThis, Symbol.for(eventKey), Event);
  };

  /** Fires the `input` and `change` an edit of `target` ends with, built with the page's own `Event` as `keepEvent` kept it, else as the page has it now. */
  const fireEdit = (target: Element): void => {
    const kept: typeof Event | undefined = Reflect.get(globalThis, Symbol.for(eventKey));
    const EventClass = kept ?? Event;
    target.dispatchEvent(new EventClass('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new EventClass('change', { bubbles: true }));
  };

  /**
   * Sets a form control's state (`value`, `checked`, `selected`, `files`)
   * through the setter of the interface that defines it: the one deepest in
   * the element's prototype chain. A property the page put over it, on the
   * element or on a class it derived from the built-in one, is never
   * written through: a framework's records every write (React's value
   * tracker) and takes the `input` that follows for no change, so its
   * change handler would not run.
   */
  const setState = <E extends Element, K extends keyof E & string>(element: E, property: K, state: E[K]): void => {
    let setter: ((this: E, state: E[K]) => void) | undefined;
    for (let at: object | null = Object.getPrototypeOf(element); at !== null; at = Object.getPrototypeOf(at)) {
      setter = Object.getOwnPropertyDescriptor(at, property)?.set ?? setter;
    }
    setter?.call(element, state);
  };

  return { shadowOf, roots, parentOrHostOf, parentOf, turned, rectsOf, boxOf, viewport, scrollTarget, inTopLayer, clippers, clipped, visibleArea, scrollIfClipped, alignment, landOnPixels, shown, still, pointerTarget, hitAt, reaches, interceptedBy, activeElement, focus, control, keepEvent, fireEdit, setState };
}

/** The shared DOM helpers, as a page function takes them. */
export type Dom = ReturnType<typeof createDom>;

/**
 * A page function that takes the shared DOM helpers before the arguments
 * the driver passes. Its source builds them from `createDom`'s own, over the
 * registry the closed-roots preload fills, so it stays self-contained and
 * the driver calls it with its arguments alone; it only runs in a page.
 */
export function withDom<A extends unknown[], R>(fn: (dom: Dom, ...args: A) => R): (...args: A) => R {
  const source = `(...args) => (${fn.toString()})((${createDom.toString()})(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)}), ...args)`;
  const inPageOnly = (..._args: A): R => {
    throw new Error('a page function runs only in the page');
  };
  return Object.assign(inPageOnly, { toString: () => source });
}
