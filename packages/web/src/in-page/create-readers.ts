/**
 * The readers a document keeps: typed page functions over one shared
 * semantic reader, the contract's locator rules, the selector chain, and the
 * DOM helpers. `createReaders` builds them in the page from the parts
 * `readers.ts` hands it by name. It is serialized with `toString()`, so this
 * module imports types only: nothing here can be reached from the page but
 * what arrives as an argument.
 */

import type { createResolver, createTextMatching, LocatorExpression } from '@e2e-dev/core/engine';
import type { createAccessibleNames } from './accessible-name.ts';
import type { frameContentInset } from './document.ts';
import type { createDom } from './dom.ts';
import type { createLocatorMatch } from './locator-match.ts';
import type { createModalScope } from './modal-dialogs.ts';
import type { createSemanticReader } from './read-semantics.ts';
import type { RawNodeData, RawObservedFrame, RawObservedNode, TreeLimits } from './read-node.ts';
import type { createRoles } from './roles.ts';
import type { PagePart, selectChain } from './select-chain.ts';

/** What every reader builds the semantic reader with. */
export type ReadOptions = { readonly testIdAttribute: string; readonly secureFieldSelector: string };

/**
 * A reader's metadata beside the elements it read: one JSON string when the
 * page left `JSON.stringify` native and added no `toJSON` the metadata would
 * go through, else the value itself.
 */
type Encoded<T> = readonly [metadata: T | string, elements: Element[]];

/** The walk's metadata, as the `tree` reader reports it. */
interface TreeMetadata {
  readonly nodes: RawObservedNode[];
  readonly ids: string[];
  readonly truncated: boolean;
  /** Each iframe among `nodes`, with how the document lays it out, read with the nodes so a child document is placed in the box its node reports. */
  readonly frames: (RawObservedFrame & { readonly box: FrameBox })[];
}

/** A `selector` of a located expression that the page could not parse, with the page's reason. */
interface UnparsedSelector {
  readonly selector: string;
  readonly reason: string;
}

type Point = { readonly x: number; readonly y: number };

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** One frame element as its document lays it out: its content box in that document's viewport, and the scale from the document inside it to that box. */
interface FrameStep {
  readonly content: Rect;
  readonly scale: Point;
}

/**
 * A frame element a rotation, skew, reflection, or 3D transform turns, whose
 * points no scale maps: its border box size, where its content box sits
 * inside that box, and, where the page has `getBoxQuads` (Firefox), the quad
 * the border box lays out on in its document's viewport.
 */
export interface TurnedFrame {
  readonly width: number;
  readonly height: number;
  readonly inset: Rect;
  readonly quad: Point[] | null;
}

/** How a document lays out one of its frame elements; null for one that lays out no box. */
export type FrameBox = FrameStep | { readonly turned: TurnedFrame } | null;

/** How many frame elements a selector matches in a document and, for exactly one, the element, whether it reads as hidden, and its box. */
interface SelectedFrames {
  readonly count: number;
  readonly only?: { readonly element: Element; readonly hidden: boolean; readonly box: FrameBox };
}

/**
 * What the readers are built over, each under the name `createReaders` takes
 * it by: the factories of the semantic reader and of what it builds on, a
 * locate's matching, the contract's locator and text rules, the selector
 * chain, the DOM helpers, a frame's content inset, and the keys of the two
 * records the preloads keep, which no page function can import.
 */
export interface ReaderParts {
  readonly semantics: typeof createSemanticReader;
  readonly roles: typeof createRoles;
  readonly names: typeof createAccessibleNames;
  readonly modalScope: typeof createModalScope;
  readonly modalOrderKey: string;
  readonly locatorMatch: typeof createLocatorMatch;
  readonly resolver: typeof createResolver;
  readonly textMatching: typeof createTextMatching;
  readonly select: typeof selectChain;
  readonly domHelpers: typeof createDom;
  readonly closedShadowRootsKey: string;
  readonly contentInset: typeof frameContentInset;
}

/**
 * Builds the readers in the page over their parts: the semantic reader is
 * built for each read, the DOM helpers and the modal scope once for the
 * document. Serialized with `toString()`, so it closes over nothing of this
 * module; the builtins it names are the ones the readers' script
 * (`readers.ts`) binds around it, which the document had before its own
 * scripts ran.
 */
export function createReaders({
  semantics,
  roles,
  names,
  modalScope,
  modalOrderKey,
  locatorMatch,
  resolver,
  textMatching,
  select,
  domHelpers,
  closedShadowRootsKey,
  contentInset,
}: ReaderParts) {
  const { matchesText } = textMatching();
  const dom = domHelpers(closedShadowRootsKey);
  const modalScopeOf = modalScope(modalOrderKey, dom);

  /** The semantic reader for one read of this document. */
  const read = (options: ReadOptions) => semantics(options, roles, names, modalScopeOf, dom);

  /** Whether `fn` reads as the native `JSON.stringify`; false when the page broke `Function.prototype.toString`, so it cannot tell. */
  const nativeStringify = (fn: unknown): boolean => {
    if (typeof fn !== 'function') return false;
    try {
      return /^function stringify\(\)\s*\{\s*\[native code\]\s*\}$/.test(Reflect.apply(Function.prototype.toString, fn, []) as string);
    } catch {
      return false;
    }
  };

  /** `data` as `Encoded` carries it: one JSON string when the page left `JSON.stringify` native and added no `toJSON` it would go through, else itself. */
  const encode = <T>(data: T): T | string =>
    nativeStringify(JSON.stringify) && !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype) ? JSON.stringify(data) : data;

  /** Whether `element` reads as hidden to the semantic reader, its `states.hidden`: for an iframe, whether everything inside it is hidden. */
  const hidden = (element: Element, options: ReadOptions): boolean => {
    return element.isConnected ? read(options).hidden(element) : true;
  };

  /** Reads the document's semantic tree within `limits`: the walk's metadata, and the walked elements. */
  const tree = (options: ReadOptions, limits: TreeLimits): Encoded<TreeMetadata> => {
    // A document a navigation just opened has no root yet: it reads as no nodes, which the caller repeats.
    if (document.documentElement === null) return [encode({ nodes: [], ids: [], truncated: false, frames: [] }), []];
    const observation = read(options).tree(document.documentElement, limits);
    const frames = observation.frames.map((frame) => ({ ...frame, box: frameBox(observation.elements[frame.node]!) }));
    return [encode({ nodes: observation.nodes, ids: observation.ids, truncated: observation.truncated, frames }), observation.elements];
  };

  /**
   * Resolves `expression` (as JSON) in the document by the contract's
   * locator rules, matching each element as `createLocatorMatch` does. Every
   * element through open and recorded closed shadow roots is a candidate, in
   * Playwright's match order: a root's light DOM before the content of its
   * shadow roots, each root in turn. `selectors` holds each `selector` of
   * the expression with its chain parts, matched here by `select`; one the
   * page cannot parse answers alone, as an `UnparsedSelector`. In a hidden
   * frame every element is hidden. Answers the node read of each match, and
   * the matches; iframe documents are not entered.
   */
  const locate = (options: ReadOptions, expression: string, selectors: [string, PagePart[]][], frameHidden: boolean): Encoded<RawNodeData[] | UnparsedSelector> => {
    const selections = new Map<string, Set<Element>>();
    for (const [selector, parts] of selectors) {
      const found = select(dom, parts);
      if (typeof found === 'string') return [encode({ selector, reason: found }), []];
      selections.set(selector, new Set(found));
    }
    // A document a navigation just opened has no root yet: nothing in it can match.
    if (document.documentElement === null) return [encode([]), []];
    const nodes: Element[] = [];
    const parents = new Map<Element, Element>();
    const walkRoot = (children: Iterable<Element>, host: Element | undefined): void => {
      const shadows: [Element, ShadowRoot][] = [];
      const walk = (element: Element, parent: Element | undefined): void => {
        nodes.push(element);
        if (parent !== undefined) parents.set(element, parent);
        const shadow = dom.shadowOf(element);
        if (shadow !== null) shadows.push([element, shadow]);
        for (let child = element.firstElementChild; child !== null; child = child.nextElementSibling) walk(child, element);
      };
      for (const child of children) walk(child, host);
      for (const [shadowHost, shadow] of shadows) walkRoot(shadow.children, shadowHost);
    };
    walkRoot([document.documentElement], undefined);
    const reader = read(options);
    const { matches, text } = locatorMatch(reader, options, matchesText, frameHidden);
    // oxlint-disable-next-line e2e/no-unchecked-json -- the expression the driver serialized for this call
    const parsed = JSON.parse(expression) as LocatorExpression;
    const found = resolver<Element>({
      nodes,
      parent: (element) => parents.get(element),
      matches,
      hasText: (element, pattern) => matchesText(text(element), pattern),
      selector: (selector, candidates) => {
        const hits = selections.get(selector);
        return hits === undefined ? [] : candidates.filter((element) => hits.has(element));
      },
      fail: (code, message) => {
        throw new Error(`${code}: ${message}`);
      },
    })(parsed);
    const described = found.map((element) => {
      const node = reader.describe(element);
      return frameHidden ? { ...node, states: { ...node.states, hidden: true } } : node;
    });
    return [encode(described), found];
  };

  /**
   * Whether an element is disabled as the shared reader decides it (its
   * `:disabled` state, and `aria-disabled` on it or inherited by its role),
   * so an action refuses exactly what an observation reports disabled. The
   * element is first retargeted as Playwright's enabled check does: to the
   * button, checkbox, or radio that holds it, or the control its label names.
   * Null for a detached element, or one read while a navigation replaces its
   * document (no root yet), which a locate must find again.
   */
  const disabled = (target: Element, options: ReadOptions): boolean | null => {
    if (!target.isConnected || document.documentElement === null) return null;
    let element = target;
    if (!element.matches('input, textarea, select') && !(element as HTMLElement).isContentEditable) {
      element = element.closest('button, [role=button], [role=checkbox], [role=radio]') ?? element;
      if (!element.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]')) {
        const control = element.closest('label')?.control;
        if (control) element = control;
      }
    }
    return read(options).disabled(element);
  };

  /** Whether `element` is a frame element, of any realm: one adopted from another document is no `HTMLElement` of this window. */
  const isFrame = (element: Element): element is HTMLElement => element.localName === 'iframe' || element.localName === 'frame';

  /** How this document lays out its frame element `element` (`FrameBox`); null for an element that is none. */
  const frameBox = (element: Element): FrameBox => {
    if (!isFrame(element) || element.getClientRects().length === 0) return null;
    const inset = contentInset(element);
    if (dom.turned(element)) {
      const [quad]: (DOMQuad | undefined)[] = 'getBoxQuads' in element && typeof element.getBoxQuads === 'function' ? element.getBoxQuads({ box: 'border', relativeTo: element.ownerDocument }) : [];
      const corners = quad === undefined ? null : [quad.p1, quad.p2, quad.p3, quad.p4].map(({ x, y }) => ({ x, y }));
      return { turned: { width: element.offsetWidth, height: element.offsetHeight, inset, quad: corners } };
    }
    const rect = element.getBoundingClientRect();
    const scale = { x: element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1, y: element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1 };
    return { content: { x: rect.x + inset.x * scale.x, y: rect.y + inset.y * scale.y, width: inset.width * scale.x, height: inset.height * scale.y }, scale };
  };

  /**
   * The iframe and frame elements the chain `parts` matches in this document
   * (`SelectedFrames`): what a locate asks the document about a frame on its
   * way, in one call. A selector the page cannot parse is its error message.
   * The frame's window is not read here: see `contentContext` (`frames.ts`).
   */
  const selectFrame = (parts: PagePart[], options: ReadOptions): SelectedFrames | string => {
    const found = select(dom, parts);
    if (typeof found === 'string') return found;
    const frames = found.filter(isFrame);
    const [only] = frames;
    return only === undefined || frames.length > 1 ? { count: frames.length } : { count: 1, only: { element: only, hidden: hidden(only, options), box: frameBox(only) } };
  };

  return Object.freeze({ tree, locate, disabled, frameBox, selectFrame });
}

/** The readers a document keeps, by name. */
export type Readers = ReturnType<typeof createReaders>;

/** The name of a reader a document keeps (`readerCall`). */
export type ReaderName = keyof Readers;
