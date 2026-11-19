/**
 * Page functions that read a document as a whole: its viewport, load and
 * history state, title, rendered frames, an element's computed style, and a
 * frame element's content box. Each is self-contained and serialized with
 * `toString()`.
 */

/** The viewport's size in CSS pixels. */
export function viewportSize(): { width: number; height: number } {
  return { width: innerWidth, height: innerHeight };
}

/** Resolves once the document is past `loading`, or after `timeoutMs`. */
export function domReady(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    document.addEventListener('DOMContentLoaded', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

/** Resolves true after the next rendered frame, or false at once in a hidden document, which renders none. */
export function nextFrame(): Promise<boolean> | boolean {
  if (document.visibilityState === 'hidden') return false;
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(true), 0)));
}

/**
 * The history entry the document shows once it reads complete, null while
 * it loads: the Navigation API's entry key, else its URL and state.
 */
export function historyEntry(): string | null {
  if (document.readyState !== 'complete') return null;
  const key = (globalThis as { navigation?: { currentEntry?: { key?: string } | null } }).navigation?.currentEntry?.key;
  return key ?? `${location.href} ${JSON.stringify(history.state)}`;
}

/** The document's ready state. */
export function readyState(): DocumentReadyState {
  return document.readyState;
}

/** The document's title. */
export function documentTitle(): string {
  return document.title;
}

/** `names` of `element`'s computed style, or `null` once it left the document. */
export function computedStyle(element: Element, names: readonly string[]): Record<string, string> | null {
  const view = element.ownerDocument.defaultView;
  if (!element.isConnected || view === null) return null;
  const computed = view.getComputedStyle(element);
  return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name)]));
}

/**
 * Where a frame element's content box, the box its document's viewport
 * fills, sits inside its border box: past the border and the padding. Runs in
 * the page.
 */
export function frameContentInset(element: Element): { x: number; y: number; width: number; height: number } {
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.paddingLeft) || 0;
  const top = Number.parseFloat(style.paddingTop) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  return {
    x: element.clientLeft + left,
    y: element.clientTop + top,
    width: Math.max(0, element.clientWidth - left - right),
    height: Math.max(0, element.clientHeight - top - bottom),
  };
}
