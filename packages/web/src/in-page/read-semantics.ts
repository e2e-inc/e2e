/**
 * The in-page semantic reader: what of the document shows, how each node is
 * projected, and the walk. The driver serializes it with `toString()` and
 * runs it inside the page (`readers.ts` builds the readers a document keeps
 * from its source), so it must stay one self-contained function: no imports
 * beyond types, no module-scope references, every constant inside the body.
 * That is why it has a file of its own, and why what it builds on reaches it
 * as an argument: the role computation (`roles.ts`), the name computation
 * (`accessible-name.ts`), the modal dialog on top (`modal-dialogs.ts`), and
 * the DOM helpers (`dom.ts`).
 */

import type { createAccessibleNames } from './accessible-name.ts';
import type { Dom } from './dom.ts';
import type { createModalScope } from './modal-dialogs.ts';
import type { createRoles } from './roles.ts';
import type { RawNodeData, RawObservation, RawObservedFrame, RawObservedNode, TreeLimits } from './read-node.ts';

/**
 * Builds the semantic reader for one read of a document: it keeps what it
 * reads of an element (`memoized`) and the page may change between two
 * calls, so each call into the page builds its own, over the role
 * computation `roles` and the name computation `accessibleNames`, both built
 * here for the read, the document's modal scope `modalScopeOf`, and the DOM
 * helpers `dom`. Must stay self-contained: no outer captures beyond its
 * arguments.
 *
 * `tree` walks the document for one agent observation. The other methods
 * read one element as a locate matches and reports it (`locator-match.ts`).
 * The two project nodes differently; those differences are data (see
 * `Projection` below), not scattered branches.
 */
export const createSemanticReader = (
  options: { testIdAttribute: string; secureFieldSelector: string },
  roles: typeof createRoles,
  accessibleNames: typeof createAccessibleNames,
  modalScopeOf: ReturnType<typeof createModalScope>,
  dom: Dom,
) => {
  const SKIP_TAGS = [
    'script',
    'style',
    'noscript',
    'template',
    'head',
    'meta',
    'link',
    'title',
    'base',
    'param',
    'source',
    'track',
    'col',
    'colgroup',
    'frame',
    'frameset',
    'object',
    'embed',
    // Next.js App Router's route announcer echoes the title on a hydration
    // schedule of its own, which an observation must not read as an alert.
    'next-route-announcer',
  ];
  const OPAQUE_TAGS = ['svg', 'math', 'canvas', 'video', 'audio'];
  /** Options listed under one select; a country picker's tail is not worth the tokens. */
  const MAX_SELECT_OPTIONS = 60;

  /**
   * Per-node memo for the facts several passes need. A tree walk asks for
   * an element's role, name, and direct text from `isInteresting`, `describe`,
   * and the empty-box test; each is a pure function of the element for the
   * duration of one read, and `innerText` in particular forces layout.
   */
  const memoized = <N, T>(compute: (node: N) => T): ((node: N) => T) => {
    const cache = new Map<N, T>();
    return (node) => {
      if (cache.has(node)) return cache.get(node) as T;
      const value = compute(node);
      cache.set(node, value);
      return value;
    };
  };

  const { explicitRole, implicitRole, isEditingHost } = roles(memoized, OPAQUE_TAGS);

  /** Rendered text as a person sees it: innerText, aria-hidden glyphs included. */
  const textOf = (el: Element): string => {
    if (el instanceof HTMLElement) return el.innerText;
    return el.textContent ?? '';
  };

  /** Computed style of any element, SVG included, or undefined in a document with no view. */
  const styleOf = (el: Element): CSSStyleDeclaration | undefined =>
    el.ownerDocument.defaultView?.getComputedStyle(el);

  /**
   * Text owned directly by an element, excluding descendant elements. An
   * element with `content-visibility: hidden` renders none of it, as its
   * `innerText` reads empty, so it owns none.
   */
  const directTextOf = memoized((el: Element): string => {
    if (styleOf(el)?.getPropertyValue('content-visibility') === 'hidden') return '';
    let out = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  });

  /**
   * Elements whose content is not text in a line: a form control's options
   * or value, a picture, a frame, a drawn surface. Like a line break, each
   * separates the words around it.
   */
  const LINE_BREAKING_TAGS = [...SKIP_TAGS, ...OPAQUE_TAGS, 'iframe', 'img', 'input', 'select', 'textarea', 'br'];

  /**
   * True when an element's text flows in its parent's line: a visible
   * inline-level box (`inline`, `inline-block`, `ruby`), or `display:
   * contents`, whose children lay out as the parent's own. Visible as the
   * walk reads it (`isHidden`): a box with no size shows no words. A slot
   * has no box and shows the nodes assigned to it, so only its visibility
   * counts: a hidden one hides the text they inherit it with, and a child
   * that shows itself again is listed on its own.
   */
  const flowsInLine = memoized((el: Element): boolean => {
    if (LINE_BREAKING_TAGS.indexOf(el.tagName.toLowerCase()) !== -1 || isEditingHost(el)) return false;
    const style = styleOf(el);
    if (style === undefined || hidesSubtree(el, style)) return false;
    if (el instanceof HTMLSlotElement ? style.visibility !== 'visible' : isHidden(el, style)) return false;
    return isInlineLevel(style);
  });

  /** True for a box laid out in its parent's line, or for `display: contents`, which lays out none of its own. */
  const isInlineLevel = (style: CSSStyleDeclaration): boolean =>
    style.display.startsWith('inline') || style.display.startsWith('ruby') || style.display === 'contents';

  /**
   * The nodes an element renders in its place, as the walk reaches them: a
   * shadow host's shadow tree (a closed one through the record), a slot's
   * assigned nodes or else its fallback content, any other element's children.
   */
  const renderedChildrenOf = (el: Element): Node[] => {
    const shadow = dom.shadowOf(el);
    if (shadow !== null) return Array.from(shadow.childNodes);
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes();
      if (assigned.length > 0) return assigned;
    }
    return Array.from(el.childNodes);
  };

  /**
   * An element's rendered text with each inline descendant's text in place.
   * Anything else in the line reads as a space, except a hidden inline
   * element (a `<wbr>`, a zero-size span), which shows nothing.
   */
  const lineRunOf = (el: Element): string => {
    let out = '';
    for (const child of renderedChildrenOf(el)) {
      if (child.nodeType === 3) out += child.nodeValue ?? '';
      if (child.nodeType !== 1) continue;
      const inner = child as Element;
      if (flowsInLine(inner)) {
        out += lineRunOf(inner);
        continue;
      }
      const style = styleOf(inner);
      if (style === undefined || hidesSubtree(inner, style)) continue;
      const breaking = LINE_BREAKING_TAGS.indexOf(inner.tagName.toLowerCase()) !== -1;
      if (breaking || !isInlineLevel(style) || !isHidden(inner, style)) out += ' ';
    }
    return out;
  };

  /**
   * True when an element with no role still says it can be acted on: it is
   * focusable through `tabindex`, it has a click handler set as an attribute
   * or a property (`onclick`), or it is an `<a>` with no `href`, which an app
   * wires up by script. Such an element stays listed inside a line, so it
   * keeps an id to act on. A handler added with `addEventListener` leaves
   * nothing the page can read.
   */
  const offersAction = memoized((el: Element): boolean => {
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && /^\s*[-+]?\d/.test(tabindex)) return true;
    if (el.tagName.toLowerCase() === 'a' || el.hasAttribute('onclick')) return true;
    return el instanceof HTMLElement && el.onclick !== null;
  });

  /** The element that holds focus, through every shadow root on the way, read once for the read. */
  const focusedElement = dom.activeElement();

  /**
   * The text selected inside a focused field: the slice between an input's or
   * textarea's selection ends, or the document selection when it lies within
   * an editing host. Null for a collapsed caret, so a node with no selection
   * reads exactly as before.
   */
  const selectedTextOf = (el: Element): string | null => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start === null || end === null || start === end) return null;
      return el.value.slice(Math.min(start, end), Math.max(start, end));
    }
    if (!isEditingHost(el)) return null;
    const selection = el.ownerDocument.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    if (!el.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
    const text = selection.toString();
    return text === '' ? null : text;
  };

  /**
   * True for a text node its parent, a `display: contents` element of
   * `style`, shows: one that lays out to a box a person can see, where the
   * browser renders the parent (`isUnrendered`) and in the parent's
   * `visibility`. A range's box reflects neither: Chromium lays one out for
   * text in content it skips.
   */
  const showsText = (node: Node, style: CSSStyleDeclaration): boolean => {
    if (style.visibility !== 'visible' || isUnrendered(node.parentElement!)) return false;
    const range = node.ownerDocument!.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /**
   * True for content a closed `<details>` folds away: anything under it in
   * the flat tree that is not in its first `<summary>` child, so what is
   * slotted into a `<details>` of a shadow root folds with it, and so does
   * the shadow tree of a host under one. Every closed `<details>` on the way
   * up is asked, so a summary's own controls stay visible while the closed
   * body's do not, nested `<details>` and their summaries included.
   * Memoized, so siblings under one ancestor share the walk up.
   */
  const isInClosedDetails = memoized((el: Element): boolean => {
    const parent = flatParentOf(el);
    if (parent === null) return false;
    if (parent instanceof HTMLDetailsElement && !parent.open && parent.querySelector(':scope > summary') !== el) return true;
    return isInClosedDetails(parent);
  });

  /**
   * True when an ancestor in the flat tree has `content-visibility: hidden`:
   * it keeps its own box and skips rendering everything under it, slotted
   * and shadow content included, as `checkVisibility()` reads it. Memoized,
   * so siblings under one ancestor share the walk up.
   */
  const isSkippedContent = memoized((el: Element): boolean => {
    const parent = flatParentOf(el);
    if (parent === null) return false;
    return styleOf(parent)?.getPropertyValue('content-visibility') === 'hidden' || isSkippedContent(parent);
  });

  /**
   * True for content the browser renders none of, whatever its own style:
   * what a `content-visibility: hidden` ancestor skips (`isSkippedContent`)
   * and what a closed `<details>` folds away (`isInClosedDetails`).
   */
  const isUnrendered = (el: Element): boolean => isSkippedContent(el) || isInClosedDetails(el);

  /**
   * Render visibility, the one Playwright's `toBeVisible` and `toBeHidden`
   * read, so a semantic `hidden` state and the platform's own filter agree:
   * `display: none` or a `visibility` other than `visible` on any element (an
   * SVG included), content the browser renders none of (`isUnrendered`), and
   * a box with no width or no height. `aria-hidden` is not in it: it removes
   * a node from the accessibility tree (`hidesSubtree`, a role query) while
   * the node still paints, as a spinner marked decorative does. `display:
   * contents` generates no box of its own while every child still paints
   * (Shopify's one-page checkout form is one), so such an element is shown
   * when some child element or text is (`showsText`), and hidden when
   * nothing under it is: text under a hidden one is hidden, where Playwright
   * calls it visible.
   */
  const isHidden = (el: Element, style = styleOf(el)): boolean => {
    if (style === undefined || isUnrendered(el)) return true;
    if (style.display === 'contents') {
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        if (child instanceof Element && !isHidden(child)) return false;
        if (child.nodeType === Node.TEXT_NODE && showsText(child, style)) return false;
      }
      return true;
    }
    if (style.display === 'none' || style.visibility !== 'visible') return true;
    const rect = el.getBoundingClientRect();
    return !(rect.width > 0 && rect.height > 0);
  };

  /**
   * True for a checkbox or radio hidden only by having no box, under a shown
   * label of its own that draws it, as in Element Plus. Chrome's tree keeps
   * such an input, and without it the model reads the label text with no
   * checked state. A tap clicks the label in its place (`labelStandIn` in
   * `actionability.ts`), which needs a box (so not `display: contents`) and
   * refuses when the label's centre lands on a link or other control. This
   * rule is stricter: a label that is one, or holds one anywhere, does not
   * count.
   */
  const isDrawnByLabel = (el: Element, style: CSSStyleDeclaration | undefined): boolean => {
    if (!(el instanceof HTMLInputElement) || (el.type !== 'checkbox' && el.type !== 'radio')) return false;
    if (style?.visibility !== 'visible' || isSkippedContent(el)) return false;
    const INTERACTIVE = 'a,button,input,select,textarea,summary,[contenteditable],[role="button"],[role="link"]';
    return Array.from(el.labels ?? []).some(
      (label) =>
        styleOf(label)?.display !== 'contents' &&
        !isHidden(label) &&
        !label.matches(INTERACTIVE) &&
        !Array.from(label.querySelectorAll(INTERACTIVE)).some((inner) => inner !== el),
    );
  };

  /**
   * What takes the element and everything under it out of the tree walk: an
   * `aria-hidden` or inert subtree, which the accessibility tree drops though
   * it may paint (`isInert`), and `display: none` or a closed `<details>`
   * body, which no descendant can undo. A `visibility` other than `visible`
   * is not in it, since a descendant may set `visibility: visible` and paint
   * again; nor is a box with no size: a zero-height `<html>` or wrapper still
   * shows the fixed, absolute, and overflowing descendants laid out past its
   * edges. The walk goes on through both and only the element itself stays
   * unlisted.
   */
  const hidesSubtree = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true' ||
    isInert(el) ||
    style === undefined ||
    style.display === 'none' ||
    isInClosedDetails(el);

  /**
   * Inert content takes no input and is hidden from assistive technology, as
   * Chrome's tree drops it, though it still paints: listing it would hand the
   * agent controls that ignore every action. Inertness follows the flat tree,
   * so a light child slotted into an inert slot of a closed root counts:
   * Chromium computes it as the inherited `interactivity: inert`, and a
   * browser without that property (Firefox) has it read from the `inert`
   * attributes up the flat tree. A modal dialog's inertness of the rest of the
   * page is in neither; the walk reads it from the dialog (`createModalScope`).
   */
  const isInert = memoized((el: Element): boolean => {
    if (el.hasAttribute('inert') || styleOf(el)?.getPropertyValue('interactivity') === 'inert') return true;
    const parent = flatParentOf(el);
    return parent !== null && isInert(parent);
  });

  /** An element's parent in the flat tree (`dom.parentOf`), kept for the read: a closed root's slots are searched once per element. */
  const flatParentOf = memoized(dom.parentOf);

  /** A closed select has no option boxes; explicit exclusions still remove choices it does not offer. */
  const isOfferedOption = (option: HTMLOptionElement): boolean => {
    if (isSkippedContent(option)) return false;
    for (let current: Element | null = option; current !== null && current.tagName.toLowerCase() !== 'select'; current = dom.parentOrHostOf(current)) {
      if (hidesSubtree(current, styleOf(current))) return false;
    }
    return true;
  };

  /** Smallest side, in CSS pixels, an empty box must have to be worth reporting. */
  const MIN_BOX_SIDE = 12;

  /** True when a computed style paints something a person can see. */
  const hasPaint = (style: CSSStyleDeclaration): boolean => {
    if (style.backgroundImage !== 'none' && style.backgroundImage !== '') return true;
    // A fully transparent color serializes with a zero alpha component.
    const background = style.backgroundColor;
    if (background !== '' && background !== 'transparent' && !/,\s*0\)$/.test(background)) {
      return true;
    }
    if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') return true;
    const sides = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    const styles = ['borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle'];
    for (let index = 0; index < sides.length; index += 1) {
      const width = parseFloat(style[sides[index]! as 'borderTopWidth']);
      const kind = style[styles[index]! as 'borderTopStyle'];
      if (width > 0 && kind !== 'none' && kind !== 'hidden') return true;
    }
    return false;
  };

  /**
   * True when an element is an empty painted rectangle: no children, no text,
   * no role, no name — and yet plainly visible, because it has a border, an
   * outline, or a background of its own.
   *
   * This is the one element class defined by being empty. A drop zone, a canvas,
   * a chart placeholder, a colour swatch: a person sees a rectangle and can aim
   * at it, so a tree that omits it cannot describe the page it is describing.
   * `dragTo` in particular has no usable destination without it.
   *
   * The size floor and the paint requirement are what keep this from admitting
   * every layout div: a spacer, a clearfix, or a zero-alpha wrapper paints
   * nothing and is not something anyone can point at.
   */
  const isVisibleEmptyBox = memoized((el: Element): boolean => {
    const style = styleOf(el);
    if (style === undefined) return false;
    if (el.children.length > 0) return false;
    const explicit = (el.getAttribute('role') ?? '').trim();
    if (explicit !== '') return false;
    if (directTextOf(el) !== '') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_BOX_SIDE || rect.height < MIN_BOX_SIDE) return false;
    return hasPaint(style);
  });

  /**
   * Reduces a link target to origin and path, dropping userinfo, query, and
   * fragment, which routinely carry tokens. A dropped query or fragment
   * leaves `?…` or `#…` behind, so the value never reads as the whole
   * target when it is not; a URL path never holds a literal `…`, since the
   * URL parser percent-encodes it. `mailto:` and `tel:` keep their scheme in
   * place of an origin; `blob:` keeps its inner URL, reduced the same way, or
   * becomes `blob:…` when that has no origin. Any other scheme with no
   * origin (`data:`, `javascript:`) carries its payload as its path, a whole
   * file or script, so it is reduced to `scheme:…`. The path is whole
   * otherwise: the harness bounds what it renders after redaction, and marks
   * what it cuts.
   */
  const originAndPath = (value: string, base: string): string => {
    const elided = (query: boolean, fragment: boolean): string => `${query ? '?…' : ''}${fragment ? '#…' : ''}`;
    try {
      const url = new URL(value, base);
      const rest = `${url.pathname}${elided(url.search !== '', url.hash !== '')}`;
      if (url.protocol === 'blob:') {
        const inner = URL.canParse(url.pathname) ? new URL(url.pathname) : null;
        return inner === null || inner.origin === 'null' ? 'blob:…' : `blob:${inner.origin}${inner.pathname}${elided(url.search !== '', url.hash !== '')}`;
      }
      if (url.origin !== 'null') return `${url.origin}${rest}`;
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') return `${url.protocol}${rest}`;
      return `${url.protocol}…`;
    } catch {
      const [beforeFragment = '', ...fragment] = value.split('#');
      const [path = '', ...query] = beforeFragment.split('?');
      return `${path}${elided(query.join('?') !== '', fragment.join('#') !== '')}`;
    }
  };

  /** Attributes that name an element rather than describe where it sits. */
  const NAMING_ATTRIBUTES = [options.testIdAttribute, 'name'];

  /** Every root of the document, the shadow roots under it included (`dom.roots`), read once for the selectors this read derives. */
  let searchedRoots: (Document | ShadowRoot)[] | undefined;

  /**
   * An attribute selector that names one element alone, when it has one: the
   * only match in the document and every shadow root under it, the roots a
   * selector chain searches, so a frame in a shadow root is named like any
   * other, and never by what an element across a shadow boundary shares.
   * Recorded closed roots count too, though no chain searches them: a match
   * there only costs the element its name.
   *
   * A test ID names an element by definition; a form control's `name` names it
   * because the server reads it, which is also why it outlives redesigns. Ids
   * are deliberately absent: a framework that mints them per render
   * (`#firstName-aepj7PyFWSmXAkB8bb91h`) would make every selector single-use.
   */
  const namedSelectorOf = (el: Element): string | null => {
    for (const attribute of NAMING_ATTRIBUTES) {
      const value = el.getAttribute(attribute);
      if (value === null || value === '') continue;
      const selector = `[${attribute}="${value.replace(/["\\]/g, '\\$&')}"]`;
      searchedRoots ??= dom.roots();
      let matches = 0;
      try {
        for (const root of searchedRoots) matches += root.querySelectorAll(selector).length;
      } catch {
        continue;
      }
      if (matches === 1) return selector;
    }
    return null;
  };

  /**
   * The selector an observation names one iframe by, published as the
   * `framePath` of every node inside it, which a `frame` step of a locator
   * resolves again: what names the element, else positions counted down from
   * the nearest ancestor something names, else from `body`. A shadow root's
   * child is counted among the root's children under the root's host, which
   * the selector chain's `>` crosses, so the path of a frame in an open
   * shadow root leads to it too. A frame in a closed root is listed and
   * entered like any other, but no chain searches a closed root, so its path
   * does not lead back to it: a `frameLocator` stops there. This is the one
   * place a selector is derived: each `namedSelectorOf` probe queries every
   * root, and no runner consumes a per-node selector, so neither projection
   * pays for one.
   */
  const frameSelectorOf = (el: Element): string => {
    const named = namedSelectorOf(el);
    if (named !== null) return named;
    const parts: string[] = [];
    for (let current = el; current.tagName.toLowerCase() !== 'html'; ) {
      const parent = dom.parentOrHostOf(current);
      if (parent === null || current.parentNode === null) break;
      const index = Array.prototype.indexOf.call(current.parentNode.children, current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      const anchor = namedSelectorOf(parent);
      if (anchor !== null) return `${anchor} > ${parts.join(' > ')}`;
      current = parent;
    }
    return parts.join(' > ');
  };

  /**
   * The role both projections report for one element. A tree walk and a
   * locate's re-read have to agree: the runner acts on a node it selected
   * from an observation by re-reading that node and requiring the same
   * signature, so a role only the walk attached would make it unactionable.
   */
  const roleOf = (el: Element, tag: string): string | null => {
    const implicit = implicitRole(el);
    if (implicit !== null) return implicit;
    if (tag === 'iframe') return 'iframe';
    return isVisibleEmptyBox(el) ? 'box' : null;
  };

  /**
   * The roles WAI-ARIA 1.2 lets `aria-disabled` apply to, the same list
   * Playwright's `toBeDisabled` consults. Widgets and the composites that hold
   * them; a plain container or text takes no disabled state.
   */
  const ARIA_DISABLED_ROLES = [
    'application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem', 'scrollbar',
    'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox',
    'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem',
  ];

  /**
   * What the nearest `aria-disabled` on the element or above it says
   * (WAI-ARIA: the state applies to every descendant), across shadow
   * boundaries, `false` cutting the chain. Memoized so a subtree under one
   * disabled ancestor costs one walk, not one per node.
   */
  const ariaDisabledInChain = memoized((el: Element): boolean => {
    const attribute = (el.getAttribute('aria-disabled') ?? '').toLowerCase();
    if (attribute === 'true') return true;
    if (attribute === 'false') return false;
    const parent = dom.parentOrHostOf(el);
    return parent === null ? false : ariaDisabledInChain(parent);
  });

  /**
   * The disabled state a person meets, not the attribute the element carries.
   * `:disabled` is the browser's answer for a form control: its own attribute,
   * a disabled fieldset above it (except inside that fieldset's first legend),
   * a disabled optgroup. An `aria-disabled="true"` on the element counts for
   * any role; inherited from an ancestor, it reaches the roles the state
   * applies to, as Playwright reads it.
   */
  const isDisabled = (el: Element): boolean => {
    if (el.matches(':disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const role = implicitRole(el);
    return role !== null && ARIA_DISABLED_ROLES.indexOf(role) !== -1 && ariaDisabledInChain(el);
  };

  const names = accessibleNames({ implicitRole, explicitRole, isHidden, isEditingHost, shadowRootOf: dom.shadowOf, styleOf, memoized }, options.secureFieldSelector);

  /**
   * How a read projects one node, expressed as data: `describe` reads every
   * difference between the two reads off these fields and never asks which
   * read it serves. The tree's is the model-bound projection: bounded line
   * text (`lineTextOf`), a bounded attribute projection, hrefs reduced to
   * origin+path, the root document named by its title, a list row, a
   * status, or an alert named from its content, no value on a checkbox,
   * a radio, or a select's option, whose value attribute is an app token
   * its checked or selected state already says more than, and no node
   * hidden. A locate's is the full locator-read surface (`LOCATOR`).
   */
  interface Projection {
    /** The attributes kept beside the `aria-` ones; null keeps all. */
    readonly attributes: readonly string[] | null;
    /** Where text, an editor's value, and a selection are cut; `Infinity` cuts nothing. */
    readonly textLimit: number;
    /** Where a name is cut; `Infinity` cuts nothing. */
    readonly nameLimit: number;
    readonly redactHref: boolean;
    readonly documentRoot: boolean;
    /** Whether a checkbox, a radio, and a select's option report their value attribute. */
    readonly choiceValue: boolean;
    /**
     * Whether a node reports that it is hidden. The walk lists what shows,
     * and beside it only what it lists on purpose (the root whatever its
     * box, a closed select's options, a control its label draws), so
     * nothing in a tree is.
     */
    readonly hiddenState: boolean;
    readonly text: (el: Element) => string;
    readonly name: (el: Element) => string | null;
  }

  const describe = (el: Element, projection: Projection, style = styleOf(el)): RawNodeData => {
    const tag = el.tagName.toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();

    let value: string | null = null;
    let checked: boolean | null = null;
    let selectedState: boolean | null = null;
    if (el instanceof HTMLInputElement) {
      // A checkbox or radio submits its value attribute (`on` by default)
      // whatever its checked state, so a locator read reports both.
      const checkable = el.type === 'checkbox' || el.type === 'radio';
      if (checkable) checked = el.checked;
      if (!checkable || projection.choiceValue) value = el.value;
    } else if (el instanceof HTMLTextAreaElement) {
      value = el.value;
    } else if (el instanceof HTMLSelectElement) {
      value = el.value;
    } else if (el instanceof HTMLOptionElement) {
      selectedState = el.selected;
      // Only a select's option is a choice with a token; a datalist's value is the text it suggests.
      if (projection.choiceValue || el.closest('select') === null) value = el.value;
    } else if (isEditingHost(el)) {
      // An editor's document is its value, as a textarea's text is: kept as
      // rendered, spaces and newlines included. An empty editor renders
      // `<p><br></p>`, which innerText reads as a newline, so a document with
      // no text nodes, or with only markup whitespace that renders as that one
      // newline, is an empty value; typed spaces are text nodes and stay. The
      // zero-width no-break space Slate and Quill pad an empty line with
      // renders nothing, so it is no text either. Cut like text in the
      // model-bound projection.
      const rendered = textOf(el).replace(/﻿/g, '');
      const text = (el.textContent ?? '').replace(/﻿/g, '');
      value = (text === '' || (text.trim() === '' && rendered === '\n') ? '' : rendered).slice(0, projection.textLimit);
    }
    // A native control's state is the control's, as Playwright reads it: a
    // stale aria-checked on a checkbox or aria-selected on an option says
    // nothing about what the browser will submit. ARIA fills in only where the
    // element has no native state.
    if (checked === null) {
      const ariaChecked = el.getAttribute('aria-checked');
      if (ariaChecked !== null) checked = ariaChecked === 'true';
    }
    if (selectedState === null) {
      const ariaSelected = el.getAttribute('aria-selected');
      if (ariaSelected !== null) selectedState = ariaSelected.toLowerCase() === 'true';
    }

    const disabled = isDisabled(el);

    const ariaExpanded = el.getAttribute('aria-expanded');
    const ariaPressed = el.getAttribute('aria-pressed');
    // Matched against the shared selector rather than re-derived from tag and
    // type, so this node's `secure` flag and the screenshot mask agree by
    // construction.
    const secure = el.matches(options.secureFieldSelector);
    const selection = focusedElement === el && !secure ? (selectedTextOf(el)?.slice(0, projection.textLimit) ?? null) : null;

    let inputPurpose: RawNodeData['inputPurpose'] = 'none';
    if (secure) inputPurpose = 'password';
    else if (autocomplete === 'username') inputPurpose = 'username';
    else if (autocomplete === 'current-password' || autocomplete === 'new-password') {
      inputPurpose = 'password';
    } else if (autocomplete === 'one-time-code') inputPurpose = 'one-time-code';

    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of Array.from(el.attributes)) {
      if (
        projection.attributes === null ||
        projection.attributes.indexOf(attribute.name) !== -1 ||
        attribute.name.startsWith('aria-')
      ) {
        if (secure && attribute.name === 'value') continue;
        // Observations expose href origin and path only: query strings and
        // fragments routinely carry tokens.
        if (projection.redactHref && attribute.name === 'href') {
          attributes[attribute.name] = originAndPath(attribute.value, el.ownerDocument.baseURI);
          continue;
        }
        attributes[attribute.name] = attribute.value;
      }
    }

    const text = (secure ? '' : projection.text(el)).slice(0, projection.textLimit);

    let name = projection.name(el)?.slice(0, projection.nameLimit) ?? null;
    const isDocumentRoot = projection.documentRoot && tag === 'html';
    if (isDocumentRoot) name = el.ownerDocument.title;

    // No layout box at all (`display: none`, an empty `display: contents`) is
    // no rect, as Playwright's `boundingBox()` answers null; a box with no
    // size, or one `visibility: hidden` keeps, is still a rect.
    const rect = el.getClientRects().length === 0 ? null : el.getBoundingClientRect();
    const borderLeft = Number.parseFloat(style?.borderLeftWidth ?? '') || 0;
    const borderTop = Number.parseFloat(style?.borderTopWidth ?? '') || 0;
    const role = isDocumentRoot ? 'document' : roleOf(el, tag);
    let level: number | null = null;
    if (role === 'heading') {
      const ariaLevel = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
      if (Number.isInteger(ariaLevel) && ariaLevel > 0) level = ariaLevel;
      else if (/^h[1-6]$/.test(tag)) level = Number(tag.slice(1));
      // HTML-AAM: a role="heading" element with no aria-level is level 2.
      else level = 2;
    }

    return {
      role,
      name,
      text,
      value: secure ? null : value,
      selection,
      inputPurpose,
      states: {
        checked,
        disabled,
        selected: selectedState,
        expanded: ariaExpanded === null ? null : ariaExpanded === 'true',
        pressed: ariaPressed === null ? null : ariaPressed === 'true',
        focused: focusedElement === el,
        hidden: projection.hiddenState && isHidden(el, style),
        secure,
      },
      level,
      attributes,
      testId: el.getAttribute(options.testIdAttribute),
      rect: rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      origin: rect === null || (borderLeft === 0 && borderTop === 0) ? null : { x: rect.x + borderLeft, y: rect.y + borderTop },
    };
  };

  /**
   * The name a locate compares, as Playwright's locators read it: the
   * accessible name, which a list row, a status, or an alert does not take
   * from its content, else the first label of an element it leaves unnamed
   * (a hidden control), as `getByLabel` finds it.
   */
  const locatorName = memoized((el: Element): string | null =>
    names.reportedName(el, names.accessibleName(el, false)) ?? names.labelsOf(el)?.[0] ?? null);

  /** A locate's projection: the full locator-read surface, nothing bounded or redacted. */
  const LOCATOR: Projection = {
    attributes: null,
    textLimit: Infinity,
    nameLimit: Infinity,
    redactHref: false,
    documentRoot: false,
    choiceValue: true,
    hiddenState: true,
    text: textOf,
    name: locatorName,
  };

  /**
   * Walks the document under `root` for one agent observation: every node
   * worth showing a model, in the model-bound projection, with live element
   * handles and node ids aligned with the flattened list.
   */
  const tree = (root: Element, limits: TreeLimits): RawObservation => {
    /**
     * The text an element owns, read as a person reads its line: its own text
     * with every inline descendant's text in place, so `<p>Read our <a>privacy
     * policy</a> for details.</p>` reads as the whole sentence while the link
     * stays a node of its own. Block-level descendants are nodes of their own
     * and only separate words. An element with no text of its own owns none: a
     * wrapper of elements leaves them to say what they say (`ownsLine`).
     */
    const lineTextOf = memoized((el: Element): string =>
      ownsLine(el) ? lineRunOf(el).replace(/\s+/g, ' ').trim() : '');

    /**
     * True when an element reads its own line: it has text of its own, or it
     * offers an action inside an ancestor's line, where its words are what a
     * person aims at.
     */
    const ownsLine = (el: Element): boolean => directTextOf(el) !== '' || (offersAction(el) && isReadInLine(el));

    /**
     * True when an element's text is already read in an ancestor's line
     * (`lineTextOf`), so the element has nothing to add on text alone. A line
     * longer than the walk's text bound is cut, so its inline descendants
     * stay listed and nothing past the cut is lost.
     */
    const isReadInLine = memoized((el: Element): boolean => {
      const parent = flatParentOf(el);
      if (parent === null || !flowsInLine(el)) return false;
      if (!ownsLine(parent)) return isReadInLine(parent);
      const fits = lineTextOf(parent).length <= limits.textLimit;
      return fits && !isHidden(parent);
    });

    /** The accessible name as the tree reads it: a list row, a status, or an alert takes it from its content too. */
    const accessibleName = memoized((el: Element): string | null => names.accessibleName(el, true));
    const projection: Projection = {
      attributes: ['type', 'autocomplete', 'href', 'role', 'placeholder'],
      textLimit: limits.textLimit,
      nameLimit: limits.nameLimit,
      redactHref: true,
      documentRoot: true,
      choiceValue: false,
      hiddenState: false,
      text: lineTextOf,
      name: (el) => names.reportedName(el, accessibleName(el)),
    };

    const nodes: RawObservedNode[] = [];
    const frames: RawObservedFrame[] = [];
    const elements: Element[] = [];
    const ids: string[] = [];
    let nextId = limits.idSeed;
    let truncated = false;

    // The id lives on the element itself under a registry symbol: invisible to
    // application code (no attribute, no enumerable property), gone with the
    // element, and readable by every later observation of the same document.
    const REF_KEY = Symbol.for('e2e.observation.ref');
    const stamp = (el: Element): string => {
      const carrier = el as Element & { [REF_KEY]?: string };
      let id = carrier[REF_KEY];
      if (id === undefined) {
        id = `n${String(nextId)}`;
        nextId += 1;
        carrier[REF_KEY] = id;
      }
      return id;
    };

    const include = (el: Element, parent: number, style = styleOf(el)): number => {
      const data = describe(el, projection, style);
      nodes.push({ ...data, parent });
      elements.push(el);
      ids.push(stamp(el));
      return nodes.length - 1;
    };

    /** True when a node carries semantics worth sending to a model. */
    const isInteresting = (el: Element): boolean => {
      if (el.hasAttribute(options.testIdAttribute)) return true;
      const role = implicitRole(el);
      if (role !== null && role !== 'presentation' && role !== 'none') return true;
      if (accessibleName(el) !== null) return true;
      if (offersAction(el) && isReadInLine(el)) return lineTextOf(el) !== '';
      return directTextOf(el) !== '' && !isReadInLine(el);
    };

    const walk = (el: Element, parent: number): void => {
      if (truncated) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.indexOf(tag) !== -1) return;
      // Read once and share: `isHidden` and the empty-box test both need it, and
      // this walk already pays one `getComputedStyle` per node.
      const style = styleOf(el);
      if (hidesSubtree(el, style)) return;
      // Outside an open modal dialog everything is inert (`createModalScope`); the
      // dialog's ancestors are walked to reach it and list nothing of their own.
      const place = modal === undefined ? 'inside' : modal.placeOf(el);
      if (place === 'outside') return;
      const hidden = isHidden(el, style);
      // The two elements listed by a rule of their own carry nothing a person
      // sees past their edges: a frame with no box shows none of its document,
      // and a select with none offers no options.
      if (hidden && (tag === 'iframe' || tag === 'select')) return;

      // Iframes are emitted as boundary nodes and never entered: their content
      // lives in another document, which the engine captures per frame and
      // stitches under this node.
      if (tag === 'iframe') {
        if (nodes.length >= limits.maxNodes) {
          truncated = true;
          return;
        }
        frames.push({ node: include(el, parent, style), selector: frameSelectorOf(el) });
        return;
      }

      let nextParent = parent;
      const drawnByLabel = hidden && isDrawnByLabel(el, style);
      // An empty painted rectangle carries no semantics to be "interesting" by and
      // is still something a person sees and aims at; `roleOf` names it `box`.
      if (place !== 'ancestor' && (!hidden || drawnByLabel) && (isInteresting(el) || isVisibleEmptyBox(el))) {
        if (nodes.length >= limits.maxNodes) {
          truncated = true;
          return;
        }
        nextParent = include(el, parent, style);
      }
      // A closed select paints none of its options, so the hidden test would
      // drop every one of them, and a model shown `combobox "Category"` alone
      // has to guess the labels it may pick. The options are what the control
      // offers, so they are listed under it, bounded like any long list.
      if (tag === 'select') {
        let offered = 0;
        for (const option of Array.from((el as HTMLSelectElement).options)) {
          if (offered >= MAX_SELECT_OPTIONS) break;
          if (!isOfferedOption(option)) continue;
          offered += 1;
          if (nodes.length >= limits.maxNodes) {
            truncated = true;
            return;
          }
          include(option, nextParent, styleOf(option));
        }
        return;
      }
      if (OPAQUE_TAGS.indexOf(tag) !== -1) return;
      // The element keeps its box, and nothing under it renders (`isSkippedContent`).
      if (style?.getPropertyValue('content-visibility') === 'hidden') return;
      for (const child of Array.from(el.children)) walk(child, nextParent);
      // A shadow root is part of what the user sees, so it is part of what the
      // model is shown. Walking the host's light children and its shadow tree
      // double-counts nothing: slotted elements are light children, and the shadow
      // tree holds the `<slot>` placeholders rather than copies of them. A closed
      // root is unreachable from `shadowRoot`, so it comes from the record the
      // context's init script kept when the page attached it.
      const shadow = dom.shadowOf(el);
      if (shadow !== null) {
        for (const child of Array.from(shadow.children)) walk(child, nextParent);
      }
    };

    // Read before the walk: the page behind a modal dialog comes first in tree
    // order, and would otherwise spend the node budget the dialog needs.
    const modal = modalScopeOf(flatParentOf);
    // The root is the document the screen shows, listed whatever its own box: a
    // page of fixed controls leaves `<html>` with no height of its own.
    include(root, -1);
    if (isInert(root)) return { nodes, frames, elements, ids, truncated };
    for (const child of Array.from(root.children)) walk(child, 0);

    return { nodes, frames, elements, ids, truncated };
  };

  return {
    /** The element's `states.hidden`. */
    hidden: (el: Element): boolean => isHidden(el),
    /** The element's `states.disabled`. */
    disabled: isDisabled,
    /** Whether the element's role is `role`; the empty-box role is computed only when asked for. */
    hasRole: (el: Element, role: string): boolean => {
      const implicit = implicitRole(el);
      if (implicit !== null) return implicit === role;
      if (el.localName === 'iframe') return role === 'iframe';
      return role === 'box' && isVisibleEmptyBox(el);
    },
    /** The name a role query compares. */
    name: locatorName,
    /** The labels a label query compares (`labelsOf`); a secure field withholds its value, never its labels. */
    labels: names.labelsOf,
    /** The element as a node read, in a locate's projection. */
    describe: (el: Element): RawNodeData => describe(el, LOCATOR),
    tree,
    /** The helpers a locate's matching shares with this read (`locator-match.ts`), handed over as `NameFacts` are. */
    memoized,
    styleOf,
    parentOrHostOf: dom.parentOrHostOf,
    showsText,
  };
};
