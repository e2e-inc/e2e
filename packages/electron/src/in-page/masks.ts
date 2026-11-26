/**
 * Page-side halves of a masked screenshot: a black box painted over every
 * element a selector matches, with the caret hidden and animations stopped,
 * and the cleanup that takes it all away again. Sent as source text: each
 * function is self-contained.
 */

/** What the masks cover: how many elements, and where each one is. */
export interface MaskState {
  readonly count: number;
  /** The masked elements' boxes in the viewport, as one comparable string. */
  readonly boxes: string;
  /** Whether the masks were in place, whole, on top, and over every element: false once their document is gone, or the page took one away. */
  readonly placed: boolean;
}

/**
 * Paints a black box over every element `selector` matches in the document
 * and in each open shadow root, hides the text caret, and stops animations:
 * a finite one jumps to its end, an endless one to its start, so a field an
 * animation moves stays under the box measured for it.
 */
export function placeMasks(selector: string): MaskState {
  // The cleanup of masks still in place, kept on the isolated world's global between the two calls.
  const earlier: unknown = Reflect.get(globalThis, 'e2eRemoveMasks');
  if (typeof earlier === 'function') earlier();
  const elements: Element[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    elements.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) visit(element.shadowRoot);
  };
  visit(document);

  const resume: Animation[] = [];
  for (const animation of document.getAnimations()) {
    if (animation.effect === null || animation.playbackRate === 0) continue;
    const end = animation.effect.getComputedTiming().endTime;
    try {
      if (Number.isFinite(Number(end))) {
        animation.finish();
      } else {
        animation.cancel();
        resume.push(animation);
      }
    } catch {
      // An animation that cannot be finished or cancelled is left running.
    }
  }

  const style = document.createElement('style');
  style.textContent = '* { caret-color: transparent !important; }';
  const layer = document.createElement('div');
  // A popover is in the top layer, above a modal dialog and anything else the app put there before it.
  layer.popover = 'manual';
  layer.style.cssText = 'all: initial; position: fixed; inset: 0; width: 100%; height: 100%; margin: 0; border: 0; padding: 0; background: transparent; overflow: visible; pointer-events: none;';
  document.documentElement.append(style, layer);
  layer.showPopover();
  // A zoom on the root scales the layer's own lengths, which the measured boxes already include.
  const zoom = layer.currentCSSZoom;
  const boxes: string[] = [];
  let covered = true;
  for (const element of elements) {
    const { x, y, width, height } = element.getBoundingClientRect();
    boxes.push([x, y, width, height].map(Math.round).join(','));
    const box = document.createElement('div');
    box.style.cssText = `all: initial; position: fixed; left: ${x / zoom}px; top: ${y / zoom}px; width: ${width / zoom}px; height: ${height / zoom}px; background: #000000;`;
    layer.append(box);
    // Measured, not assumed: a page can lay the layer out in ways no formula here foresees.
    const drawn = box.getBoundingClientRect();
    covered &&= drawn.left <= x + 1 && drawn.top <= y + 1 && drawn.right >= x + width - 1 && drawn.bottom >= y + height - 1;
  }
  const painted = layer.outerHTML;
  Reflect.set(globalThis, 'e2eRemoveMasks', (): boolean => {
    // A page script can reach the masks through the document: they count only as painted, each one, to the end.
    const whole = layer.parentNode === document.documentElement && layer.matches(':popover-open') && layer.outerHTML === painted;
    style.remove();
    layer.remove();
    for (const animation of resume) {
      try {
        animation.play();
      } catch {
        // The animation's element is gone.
      }
    }
    Reflect.deleteProperty(globalThis, 'e2eRemoveMasks');
    return whole;
  });
  return { count: elements.length, boxes: boxes.join(';'), placed: covered };
}

/** Takes the masks away, and says what `selector` matches now: an element that appeared or moved since was not under one. */
export function removeMasks(selector: string): MaskState {
  const remove: unknown = Reflect.get(globalThis, 'e2eRemoveMasks');
  const placed = typeof remove === 'function' && remove() === true;
  const boxes: string[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll(selector)) {
      const { x, y, width, height } = element.getBoundingClientRect();
      boxes.push([x, y, width, height].map(Math.round).join(','));
    }
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) visit(element.shadowRoot);
  };
  visit(document);
  return { count: boxes.length, boxes: boxes.join(';'), placed };
}

/** How many device pixels one CSS pixel covers. */
export function pixelRatio(): number {
  return devicePixelRatio;
}
