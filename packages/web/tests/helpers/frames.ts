/** What a test writes a framed document with, and how it names a node through its frames. */

import type { LocatorExpression } from '@e2e-dev/core/engine';

/** Escapes HTML for a quoted attribute value, in either quote, so a document can carry a nested `srcdoc`. */
export function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
export function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}
