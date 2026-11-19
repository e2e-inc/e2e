/**
 * The selector chain the readers resolve a `selector` and a frame selector
 * with. Self-contained, so its source is spliced into the readers a document
 * keeps (`readers.ts`).
 */

import type { Dom } from './dom.ts';

/** A CSS combinator between two compounds; `' '` is the descendant one. */
export type CssCombinator = ' ' | '>' | '+' | '~';

/**
 * A pseudo-class of a compound whose arguments are selectors: `:is()` (and
 * `:where()`), `:not()`, or `:has()`, with the complex selectors it takes.
 * A `:has()` argument that starts with `>` starts at a `:scope` compound.
 */
export type CssNested = { readonly name: 'is' | 'not' | 'has'; readonly chains: CssStep[][] };

/**
 * One compound of a complex CSS selector and the combinator joining it to
 * the compound before it, null for the first. One with pseudo-classes that
 * take selectors also carries them apart (`nested`) from the rest of the
 * compound (`plain`, `*` when nothing is left).
 */
export type CssStep =
  | { readonly compound: string; readonly combinator: CssCombinator | null }
  | { readonly compound: string; readonly combinator: CssCombinator | null; readonly plain: string; readonly nested: CssNested[] };

/** One `>>` chain part as the page reads it: CSS as its complex selectors (`cssChains`), or an XPath expression. */
export type PagePart =
  | { readonly engine: 'css'; readonly body: string; readonly chains: CssStep[][] }
  | { readonly engine: 'xpath'; readonly body: string };

/**
 * The elements a `>>` chain (`pageParts`) matches, each part evaluated inside
 * every element the part before it matched, as Playwright's engines read it.
 * CSS pierces open shadow roots: the last compound is queried natively in the
 * scope and in each shadow root under it, and matched against the scope
 * element too, which a native query never answers; the compounds before it
 * are matched right to left up the composed tree (`dom.parentOrHostOf`),
 * memoized per element and compound, with every combinator stopping at the
 * scope element, which only a `:scope` compound matches. A selector inside
 * `:is()`, `:where()`, `:not()`, or `:has()` is matched the same way where a
 * shadow root lies under the scope, since the browser's own reading of one
 * stops at a shadow root; with none there, the browser's is whole and is
 * the one used. Playwright reads
 * `:scope` differently in two ways, pinned as `LIMITS` in
 * `selector-parity.test.ts`: a top-level one reaches the scope element's
 * siblings, and one inside a pseudo-class makes its compound no `:scope`
 * compound. XPath stays in the light DOM, a leading `/` read from the scope
 * element. The result is a set: its order means nothing, and `locate`
 * answers matches in its own. A selector the page cannot parse is its error
 * message; any other failure is thrown, so a page that broke a built-in the
 * chain calls is not taken for a bad selector.
 */
export function selectChain(dom: Dom, parts: readonly PagePart[]): Element[] | string {
  const queryCss = (scope: Document | Element, chains: readonly (readonly CssStep[])[], into: Set<Element>): void => {
    const roots: (Document | Element | ShadowRoot)[] = [];
    const collect = (root: Document | Element | ShadowRoot): void => {
      roots.push(root);
      if (root.nodeType === 1 && (root as Element).shadowRoot !== null) collect((root as Element).shadowRoot!);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) collect(element.shadowRoot);
    };
    collect(scope);
    const pierces = roots.length > 1;
    const scopeElement = scope.nodeType === 1 ? (scope as Element) : null;
    const isScope = (element: Element): boolean => (scope.nodeType === 9 ? element === (scope as Document).documentElement : element === scope);
    const holds = (element: Element, nested: CssNested): boolean => {
      if (nested.name === 'has') {
        const found = new Set<Element>();
        queryCss(element, nested.chains, found);
        return found.size > 0;
      }
      const any = nested.chains.some((chain) => {
        const last = chain[chain.length - 1];
        return last !== undefined && matchesCompound(element, last) && beforeOf(chain)(element, chain.length - 1);
      });
      return nested.name === 'not' ? !any : any;
    };
    const matchesCompound = (element: Element, step: CssStep): boolean => {
      if (step.compound.includes(':scope') ? !isScope(element) : element === scope) return false;
      if (!pierces || !('nested' in step)) return element.matches(step.compound);
      return element.matches(step.plain) && step.nested.every((nested) => holds(element, nested));
    };
    const parentOf = (element: Element): Element | null => (element === scope ? null : dom.parentOrHostOf(element));
    const previousOf = (element: Element): Element | null => (element === scope ? null : element.previousElementSibling);
    const befores = new Map<readonly CssStep[], (element: Element, index: number) => boolean>();
    /** Whether the compounds of `chain` before the one at `index` match up the tree from `element`, memoized per element and compound. */
    const beforeOf = (chain: readonly CssStep[]): ((element: Element, index: number) => boolean) => {
      const made = befores.get(chain);
      if (made !== undefined) return made;
      const memo = new Map<Element, (boolean | undefined)[]>();
      const matchesBefore = (element: Element, index: number): boolean => {
        if (index === 0) return true;
        const known = memo.get(element)?.[index];
        if (known !== undefined) return known;
        const { combinator } = chain[index]!;
        const before = chain[index - 1]!;
        let result = false;
        if (combinator === '>' || combinator === '+') {
          const next = combinator === '>' ? parentOf(element) : previousOf(element);
          result = next !== null && matchesCompound(next, before) && matchesBefore(next, index - 1);
        } else {
          const step = combinator === '~' ? previousOf : parentOf;
          for (let at = step(element); at !== null; at = step(at)) {
            if (!matchesCompound(at, before)) continue;
            if (matchesBefore(at, index - 1)) {
              result = true;
              break;
            }
            if (before.combinator === combinator) break;
          }
        }
        const entry = memo.get(element) ?? [];
        entry[index] = result;
        memo.set(element, entry);
        return result;
      };
      befores.set(chain, matchesBefore);
      return matchesBefore;
    };
    for (const chain of chains) {
      const last = chain[chain.length - 1];
      if (last === undefined) continue;
      const matchesBefore = beforeOf(chain);
      // A compound the chain matches itself is queried by the rest of it, then matched whole.
      const whole = !pierces || !('nested' in last);
      for (const root of roots) {
        for (const element of root.querySelectorAll(whole ? last.compound : last.plain)) {
          if ((whole || matchesCompound(element, last)) && matchesBefore(element, chain.length - 1)) into.add(element);
        }
      }
      if (scopeElement !== null && matchesCompound(scopeElement, last) && matchesBefore(scopeElement, chain.length - 1)) into.add(scopeElement);
    }
  };
  /** Adds what the XPath `body` selects under `scope`; answers the browser's words for an expression it cannot evaluate to nodes. */
  const queryXpath = (scope: Document | Element, body: string, into: Set<Element>): string | undefined => {
    const expression = scope.nodeType !== 9 && body.startsWith('/') ? `.${body}` : body;
    let found: XPathResult;
    try {
      found = (scope.ownerDocument ?? (scope as Document)).evaluate(expression, scope, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
    for (let node = found.iterateNext(); node !== null; node = found.iterateNext()) if (node.nodeType === 1) into.add(node as Element);
    return undefined;
  };
  try {
    let matched: (Document | Element)[] = [document];
    for (const part of parts) {
      if (part.engine === 'css') document.querySelector(part.body);
      const found = new Set<Element>();
      for (const scope of matched) {
        if (part.engine === 'css') {
          queryCss(scope, part.chains, found);
          continue;
        }
        const refused = queryXpath(scope, part.body, found);
        if (refused !== undefined) return refused;
      }
      matched = [...found];
    }
    return matched as Element[];
  } catch (cause) {
    // The browser refuses a selector with a DOMException. Anything else is a fault of the read, which the caller tells apart.
    if (!(cause instanceof DOMException)) throw cause;
    return cause.message;
  }
}
