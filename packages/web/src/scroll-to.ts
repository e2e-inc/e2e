/** `scrollTo`: scrolls a container to one of its edges with the page's own scroll API. */

import type { ElementHandle, JSHandle, Page } from 'playwright-core';
import { Deadline, EngineError, type ScrollEdge } from '@e2e-dev/core/engine';
import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import type { ConnectionBudget } from './operation-budget.ts';
import { isPwTimeout, type ActionTarget } from './support.ts';

/**
 * One jump: `settled` when it moved nothing and the container still held that
 * end, with the same extent, after the next rendered frame; `moved` when it
 * moved or the end did; `detached` when the container left the document.
 * `from` is the scrollable extent before the jump, `extent` the one after.
 */
interface JumpResult {
  readonly state: 'settled' | 'moved' | 'detached';
  readonly from: number;
  readonly extent: number;
}

interface FindArgs {
  readonly edge: ScrollEdge;
  readonly fromCenter: boolean;
  readonly closedRootsKey: string;
  /** What the page function throws for a start node no longer in the document. */
  readonly detached: string;
}

const DETACHED = 'e2e: scrollTo start node is not in the document';

/**
 * Below this much budget no jump starts: a jump is a round trip and a
 * rendered frame, and one cut short would only report the budget late.
 */
const MIN_JUMP_MS = 50;

/**
 * Scrolls the container of `target` (the node, or its nearest ancestor that
 * scrolls along the edge's axis), or with no target the page, else (an app
 * shell whose page does not scroll) the container under the viewport's
 * center, to `edge`. The container is found once and held by a handle, so a
 * located row that unmounts while the list grows does not lose it. Each jump
 * sets the offset past the end, which the browser clamps, and waits for a
 * rendered frame. The edge is reached on the first jump that moves nothing,
 * so content that loads at the end after that frame (an IntersectionObserver
 * on a sentinel row) gets another jump. The loop runs here, one evaluate per
 * jump, so a cancelled step leaves nothing running in the page.
 */
export async function scrollToEdge(page: Page, target: ActionTarget | undefined, edge: ScrollEdge, operation: ConnectionBudget): Promise<void> {
  const deadline = new Deadline(operation.timeoutMs);
  // An action waits for its node as every other one does: a node with no box
  // yet (still arriving, or display: none) is waited on, not taken as at its edge.
  if (target?.kind === 'locator') await target.locator.waitFor({ state: 'visible', timeout: operation.timeoutMs });
  else if (target?.kind === 'element') await target.element.waitForElementState('visible', { timeout: operation.timeoutMs });
  const args: FindArgs = { edge, fromCenter: target === undefined, closedRootsKey: CLOSED_SHADOW_ROOTS_KEY, detached: DETACHED };
  let jumps = 0;
  let firstExtent: number | undefined;
  let grew = false;
  // Three causes, three reasons: no jump fit the budget, the end kept moving, or the budget ended before a jump confirmed it.
  const outOfBudget = (): EngineError => {
    const done = `${jumps} ${jumps === 1 ? 'jump' : 'jumps'}`;
    const reason = jumps === 0
      ? `the budget ran out before the first jump toward the ${edge} edge`
      : grew
        ? `more content kept loading at the ${edge} edge after ${done}, until the budget ran out`
        : `the budget ran out after ${done}, before a jump confirmed the ${edge} edge`;
    return new EngineError('OPERATION_TIMEOUT', reason, { retryable: false });
  };
  const stale = (what: string): EngineError => new EngineError('NODE_STALE', `${what} left the page during scrollTo; re-resolve`, { retryable: true });
  let container: JSHandle<Element | null> | undefined;
  let found = false;
  try {
    for (;;) {
      operation.signal.throwIfAborted();
      if (container === undefined) {
        try {
          container = await findContainer(page, target, args, Math.max(1, deadline.remaining()));
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes(DETACHED)) throw stale('the node');
          // A locate that ran out once a container was found means the node it came from is gone.
          if (isPwTimeout(cause)) throw found ? stale('the scroll container') : outOfBudget();
          throw cause;
        }
        found = true;
      }
      const element = container.asElement();
      if (element === null) return;
      const result = await element.evaluate(jumpOnce, edge);
      if (result.state === 'settled') return;
      if (result.state === 'detached') {
        await container.dispose();
        container = undefined;
      } else {
        jumps += 1;
        firstExtent ??= result.from;
        if (result.extent > firstExtent) grew = true;
      }
      if (deadline.remaining() < MIN_JUMP_MS) throw outOfBudget();
    }
  } finally {
    await container?.dispose().catch(() => undefined);
  }
}

/** The container a scroll toward `args.edge` moves, as a handle that holds `null` when nothing scrolls. */
function findContainer(page: Page, target: ActionTarget | undefined, args: FindArgs, timeout: number): Promise<JSHandle<Element | null>> {
  if (target === undefined) return page.locator(':root').evaluateHandle(scrollContainer, args, { timeout });
  if (target.kind === 'locator') return target.locator.evaluateHandle(scrollContainer, args, { timeout });
  const element: ElementHandle<Element> = target.element;
  return element.evaluateHandle(scrollContainer, args);
}

/**
 * Page-side: the element that scrolls along the edge's axis from `start`
 * (itself, or its nearest ancestor across slots and open and closed shadow
 * roots), or for the screen the page, else what is under the viewport's
 * center; `null` when nothing does.
 */
function scrollContainer(start: Element, args: FindArgs): Element | null {
  // A node out of the document has no ancestor that scrolls; the page is not its container.
  if (!start.isConnected) throw new Error(args.detached);
  const vertical = args.edge === 'top' || args.edge === 'bottom';
  const doc = start.ownerDocument;
  const view = doc.defaultView ?? window;
  const scrolling = doc.scrollingElement ?? doc.documentElement;
  const closedRoots = (globalThis as Record<symbol, unknown>)[Symbol.for(args.closedRootsKey)] as WeakMap<Element, ShadowRoot> | undefined;
  const overflowOf = (style: CSSStyleDeclaration): string => (vertical ? style.overflowY : style.overflowX);
  const paintContained = (style: CSSStyleDeclaration): boolean => /\b(paint|strict|content)\b/.test(style.contain);

  // The viewport takes the root element's overflow, or the body's when the
  // root's is visible on both axes and neither has paint containment; the
  // body then does not scroll itself.
  const rootStyle = view.getComputedStyle(doc.documentElement);
  const bodyStyle = doc.body === null ? undefined : view.getComputedStyle(doc.body);
  const bodyGivesOverflow = bodyStyle !== undefined && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
    && !paintContained(rootStyle) && !paintContained(bodyStyle);
  const viewportScrolls = (): boolean => {
    const overflow = overflowOf(bodyGivesOverflow && bodyStyle !== undefined ? bodyStyle : rootStyle);
    return overflow !== 'hidden' && overflow !== 'clip';
  };
  const scrolls = (element: Element): boolean => {
    const room = vertical ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
    if (room < 1) return false;
    if (element === scrolling) return viewportScrolls();
    if (element === doc.body && bodyGivesOverflow) return false;
    const overflow = overflowOf(view.getComputedStyle(element));
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  };
  // A closed shadow root hides its slots from `assignedSlot`; the registry of closed roots finds them.
  const slotOf = (element: Element): Element | null => {
    if (element.assignedSlot !== null) return element.assignedSlot;
    const root = element.parentElement === null ? undefined : closedRoots?.get(element.parentElement);
    return root === undefined ? null : [...root.querySelectorAll('slot')].find((slot) => slot.assignedNodes().includes(element)) ?? null;
  };
  const parentOf = (element: Element): Element | null => {
    const slot = slotOf(element);
    if (slot !== null) return slot;
    if (element.parentElement !== null) return element.parentElement;
    const parent = element.parentNode;
    return parent instanceof ShadowRoot ? parent.host : null;
  };

  let from: Element | null = start;
  // The screen is the page when the page scrolls along the axis, as a test
  // migrated from `cy.scrollTo` expects; an inner pane that happens to sit
  // under the center is scrolled only through a locator.
  if (args.fromCenter && scrolls(scrolling)) return scrolling;
  if (args.fromCenter) {
    // The element under the viewport's center, inside open and closed shadow
    // roots. A frame there is not entered: its document is not this one.
    const x = view.innerWidth / 2;
    const y = view.innerHeight / 2;
    from = doc.elementFromPoint(x, y);
    while (from !== null) {
      const root: ShadowRoot | null | undefined = from.shadowRoot ?? closedRoots?.get(from);
      const inner = root?.elementFromPoint(x, y) ?? null;
      if (inner === null || inner === from) break;
      from = inner;
    }
  }
  for (let element = from; element !== null; element = parentOf(element)) {
    if (scrolls(element)) return element;
    if (element === scrolling) break;
  }
  return scrolls(scrolling) ? scrolling : null;
}

/**
 * Page-side: one jump of `container` toward `edge`, then the position after
 * the next rendered frame. A hidden document renders no frames, so it reads
 * at once; a frame that renders none while out of view (a cross-origin
 * iframe) reads after 100 ms.
 */
function jumpOnce(container: Element, edge: ScrollEdge): Promise<JumpResult> {
  if (!container.isConnected) return Promise.resolve({ state: 'detached', from: 0, extent: 0 });
  const vertical = edge === 'top' || edge === 'bottom';
  const view = container.ownerDocument.defaultView ?? window;
  const extentOf = (): number => (vertical ? container.scrollHeight : container.scrollWidth);
  const offsetOf = (): number => (vertical ? container.scrollTop : container.scrollLeft);
  const start = offsetOf();
  // Past the end on purpose: the browser clamps the offset, and the sign
  // covers a container whose offsets run negative (right-to-left, column-reverse).
  const far = extentOf();
  const offset = edge === 'top' || edge === 'left' ? -far : far;
  // `instant` overrides `scroll-behavior: smooth`, so the offset is read where it landed.
  container.scrollTo(vertical ? { top: offset, behavior: 'instant' } : { left: offset, behavior: 'instant' });
  const extent = extentOf();
  const landed = offsetOf();
  // Content that loads at the end grows the extent; a scroll handler that pulls
  // the container back moves the offset. Either means the end was not held.
  const read = (): JumpResult => ({
    state: landed === start && extentOf() === extent && offsetOf() === landed ? 'settled' : 'moved',
    from: far,
    extent: extentOf(),
  });
  if (container.ownerDocument.visibilityState === 'hidden') return Promise.resolve(read());
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(read());
    };
    view.requestAnimationFrame(() => view.setTimeout(finish, 0));
    view.setTimeout(finish, 100);
  });
}
