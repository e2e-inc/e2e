/**
 * The semantic reader's accessible-name computation: accname 1.2 over
 * HTML-AAM's native sources, as Playwright's role selector reads a name.
 * Serialized into the page with the reader that builds it, so this is one
 * self-contained function under the rule `read-semantics.ts` states.
 */

/** What the name computation reads through the reader that builds it: each is the reader's function of that name, `shadowRootOf` its `dom.shadowOf`. */
interface NameFacts {
  readonly implicitRole: (el: Element) => string | null;
  readonly explicitRole: (el: Element) => string | null;
  readonly isHidden: (el: Element) => boolean;
  readonly isEditingHost: (el: Element) => boolean;
  readonly shadowRootOf: (el: Element) => ShadowRoot | null;
  readonly styleOf: (el: Element) => CSSStyleDeclaration | undefined;
  readonly memoized: <T>(compute: (el: Element) => T) => (el: Element) => T;
}

/** Builds the name computation over one reader's facts; `secureFieldSelector` matches the fields whose value no name may carry. */
export const createAccessibleNames = (
  { implicitRole, explicitRole, isHidden, isEditingHost, shadowRootOf, styleOf, memoized }: NameFacts,
  secureFieldSelector: string,
) => {
  /** Input types whose accessible name falls back to the placeholder (HTML-AAM 4.1.1). */
  const PLACEHOLDER_NAMED_INPUT_TYPES = ['text', 'password', 'number', 'search', 'tel', 'email', 'url'];

  /**
   * State of one accname walk. `inReference` is set inside an aria-labelledby
   * traversal, where a nested reference is not followed (accname 2B);
   * `hiddenAllowed` when that traversal began at a hidden target, whose whole
   * subtree then counts (2A); `visited` holds every element already read, so a
   * descendant that references its ancestor, or two that reference each other,
   * contribute once. `accessible` is set for an accessible name, which reads
   * CSS generated content (`::before`, `::after`) and an embedded control's
   * value as accname does, and unset for label text, which Playwright's
   * `getByLabel` reads without either. `fromContent` is set while reading
   * the content of an element accname names from content, where a
   * descendant adds its own content only when its role allows it
   * (`addsContentToName`).
   */
  interface NameWalk {
    readonly inReference: boolean;
    readonly hiddenAllowed: boolean;
    readonly visited: Set<Element>;
    readonly accessible: boolean;
    readonly fromContent: boolean;
  }

  /** A walk from the top, with the elements that may not contribute again already visited. */
  const nameWalk = (visited: readonly Element[], accessible: boolean, fromContent = false): NameWalk => ({
    inReference: false,
    hiddenAllowed: false,
    visited: new Set(visited),
    accessible,
    fromContent,
  });

  /**
   * Private-use code points: icon-font glyphs (Font Awesome's `\f090`) that
   * render as a picture and read as nothing a person could type. Each one
   * becomes a space once a name is computed, so `<button><i class="fa
   * fa-sign-in"></i> Login</button>` is the button "Login" and the role
   * locator, which tolerates them where a name has a space or begins or
   * ends, finds it by that.
   */
  const ICON_GLYPHS = /\p{Co}/gu;

  /** A computed name or label as the tree reports it: each icon glyph a space, whitespace collapsed. */
  const withoutGlyphs = (name: string): string => {
    const spaced = name.replace(ICON_GLYPHS, ' ');
    return spaced === name ? name : spaced.replace(/\s+/g, ' ').trim();
  };

  /**
   * An element's name as the tree reports it. A name of icon glyphs alone
   * (`<button title="Delete"><i class="fa fa-trash"></i></button>`, which the
   * browser names by the glyph) falls back to the element's `title`, the
   * word a person hovering it reads, else to no name.
   */
  const reportedName = (el: Element, name: string | null): string | null => {
    if (name === null) return null;
    const shown = withoutGlyphs(name);
    if (shown !== '' || shown === name) return shown;
    const title = (el.getAttribute('title') ?? '').trim();
    return title === '' ? null : title;
  };

  /**
   * The text a `content` value contributes, as Playwright's role selector
   * reads it: its strings and `attr()` values, or only the alternative text
   * after a `/`. Contributing anything else (an image, a counter, a quote)
   * makes it contribute nothing.
   */
  const contentTextOf = (el: Element, value: string): string | null => {
    const tokens: string[] = [];
    const token = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-\w]+\((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*\)|\/|[-\w]+)/gy;
    let match: RegExpExecArray | null;
    let end = 0;
    while ((match = token.exec(value)) !== null) {
      tokens.push(match[1]!);
      end = token.lastIndex;
    }
    if (value.slice(end).trim() !== '') return null;
    let text = '';
    for (const part of tokens.slice(tokens.lastIndexOf('/') + 1)) {
      const attribute = /^attr\(\s*([-\w]+)\s*\)$/.exec(part);
      if (attribute !== null) text += el.getAttribute(attribute[1]!) ?? '';
      else if (part.startsWith('"') || part.startsWith("'")) {
        text += part.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_all, hex: string | undefined, char: string | undefined) =>
          hex === undefined ? char! : String.fromCodePoint(Number.parseInt(hex, 16)));
      } else return null;
    }
    return text;
  };

  /**
   * What an element's `::before` or `::after` adds to a name (accname 2F.ii):
   * its content's text, spaced like a block when the pseudo element is not
   * inline; empty when it shows nothing.
   */
  const generatedContentOf = (el: Element, pseudo: '::before' | '::after'): string => {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el, pseudo);
    if (style === undefined || style.display === 'none' || style.visibility === 'hidden') return '';
    const value = style.content;
    if (value === '' || value === 'none' || value === 'normal') return '';
    const text = contentTextOf(el, value);
    if (text === null) return '';
    return style.display === 'inline' ? text : ` ${text} `;
  };

  /** An element's `::before` contribution, once per read: nested named-from-content roles walk the same descendants again. */
  const beforeContentOf = memoized((el: Element) => generatedContentOf(el, '::before'));
  /** An element's `::after` contribution, once per read. */
  const afterContentOf = memoized((el: Element) => generatedContentOf(el, '::after'));

  /** True for a subtree the name computation drops: aria-hidden, or hidden by style as innerText leaves it out. */
  const isNameHidden = (el: Element, style: CSSStyleDeclaration | undefined): boolean =>
    (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true' ||
    (style !== undefined && (style.display === 'none' || style.visibility === 'hidden'));

  /** `alt` of an element HTML-AAM names by it: an `<img>` or an `<input type="image">`. */
  const altOf = (el: Element): string | null => {
    const named = el instanceof HTMLImageElement || (el instanceof HTMLInputElement && el.type === 'image');
    const alt = named ? el.getAttribute('alt') : null;
    return alt !== null && alt.trim() !== '' ? alt.trim() : null;
  };

  /**
   * The `<title>` child an SVG element is named by (SVG-AAM), as Playwright
   * reads it: `<svg><title>Close</title></svg>` is the image "Close". An svg
   * marked `presentation` or `none` takes no name of its own from it, though
   * the title still names a link or button around it.
   */
  const svgTitleOf = (el: Element): string | null => {
    if (!(el instanceof SVGElement)) return null;
    const title = Array.from(el.children).find((child) => child instanceof SVGTitleElement);
    const text = (title?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
  };

  /**
   * True for a referenced target accname 2A reads whole: hidden itself, or
   * under an `aria-hidden` ancestor, which excludes it from the tree as
   * surely as its own attribute would.
   */
  const isReferenceHidden = (el: Element): boolean => isHidden(el) || el.closest('[aria-hidden="true" i]') !== null;

  /**
   * The element an id names for `el`, looked up in `el`'s own tree: an IDREF
   * resolves in the tree scope it is written in, so a shadow tree's ids are
   * its own and `getElementById` on the document never sees them. A root of
   * either kind answers for its tree once the reader holds the element.
   */
  const referencedElementOf = (el: Element, id: string): Element | null => {
    const root = el.getRootNode();
    return root instanceof Document || root instanceof DocumentFragment ? root.getElementById(id) : null;
  };

  /**
   * Each aria-labelledby target's contribution (accname 2B), in attribute
   * order, unnamed targets dropped; null when the targets' joined text is
   * empty, so the element names itself. The join is untrimmed, as Playwright
   * reads it: a target holding only whitespace, or two unnamed targets, end
   * the computation with no names. A hidden target is read whole, as a screen
   * reader reads it, and a reference inside a target is not followed, so this
   * is null inside a reference traversal too.
   */
  const referencedNamesOf = (el: Element, walk: NameWalk): string[] | null => {
    if (walk.inReference) return null;
    const ids = (el.getAttribute('aria-labelledby') ?? '').trim();
    if (ids === '') return null;
    const contributions: string[] = [];
    for (const id of ids.split(/\s+/)) {
      const target = referencedElementOf(el, id);
      if (target === null) continue;
      contributions.push(
        contentNameOf(target, styleOf(target), {
          inReference: true,
          hiddenAllowed: isReferenceHidden(target),
          visited: walk.visited,
          accessible: walk.accessible,
          fromContent: false,
        }),
      );
    }
    if (contributions.join(' ') === '') return null;
    return contributions.map((text) => text.replace(/\s+/g, ' ').trim()).filter((name) => name !== '');
  };

  /**
   * What an embedded control contributes to a name computed through another
   * element (accname 2C), by the rules Playwright's role selector applies, so
   * `<button>Flash the screen <input value="3"> times</button>` is the button
   * "Flash the screen 3 times": a textbox or searchbox its current value (an
   * editable element its text), a combobox or listbox its selected options'
   * names (a native select with none selected its first option, a text field
   * with none its value), and a range widget its `aria-valuetext`, else its
   * `aria-valuenow`, else its `value` attribute. A menu contributes nothing,
   * and neither does a secure field, whose value no name may carry. Null for
   * any other element, and for one its own `aria-labelledby` names, which is
   * named, not embedded.
   */
  const embeddedControlNameOf = (el: Element, walk: NameWalk): string | null => {
    const role = implicitRole(el);
    if (role === null) return null;
    if (el.id !== '' && (el.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/).indexOf(el.id) !== -1) return null;
    if (el.matches(secureFieldSelector)) return '';
    if (role === 'textbox' || role === 'searchbox') {
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? '';
    }
    if (role === 'combobox' || role === 'listbox') {
      let selected: Element[];
      if (el instanceof HTMLSelectElement) {
        selected = Array.from(el.selectedOptions);
        if (selected.length === 0 && el.options.length > 0) selected.push(el.options[0]!);
      } else {
        const listbox = role === 'combobox' ? ariaOwnedOf(el).find((owned) => implicitRole(owned) === 'listbox') : el;
        selected = listbox === undefined
          ? []
          : ariaOwnedOf(listbox).filter((owned) => owned.getAttribute('aria-selected') === 'true' && implicitRole(owned) === 'option');
      }
      if (selected.length === 0 && el instanceof HTMLInputElement) return el.value;
      return selected.map((option) => contentNameOf(option, styleOf(option), walk)).join(' ');
    }
    if (role === 'progressbar' || role === 'scrollbar' || role === 'slider' || role === 'spinbutton' || role === 'meter') {
      if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext') ?? '';
      if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow') ?? '';
      return el.getAttribute('value') ?? '';
    }
    return role === 'menu' ? '' : null;
  };

  /**
   * Every element under `el` and every element its `aria-owns` names, with
   * theirs: what a composite widget owns, as Playwright's role selector
   * collects a combobox's listbox and a listbox's options.
   */
  const ariaOwnedOf = (el: Element): Element[] => {
    const owned = Array.from(el.querySelectorAll('*'));
    for (const id of (el.getAttribute('aria-owns') ?? '').trim().split(/\s+/)) {
      const target = id === '' ? null : referencedElementOf(el, id);
      if (target !== null) owned.push(target, ...Array.from(target.querySelectorAll('*')));
    }
    return owned;
  };

  /**
   * What one element contributes to a name computed through another: as an
   * aria-labelledby target (accname 2B) or as a descendant read for name from
   * content (2F). Its own references, else its value as an embedded control,
   * its `aria-label`, its `alt`, its children, then its `title`. So
   * `<button><img alt="Search"></button>` is the button "Search", an icon
   * whose only child is
   * `<svg aria-labelledby="t"><title id="t">Close</title></svg>` is "Close",
   * and a hidden `<span>` a button references still names it. Any other form
   * control's content is its value, not label text, so it contributes nothing.
   * The title is the fallback only for empty content, untrimmed as Playwright
   * reads it: the spaces a block-level child adds count, so a flex container's
   * blockified icon keeps the container's `title` out of the name, the name
   * `getByRole` then fails to match.
   */
  const contentNameOf = (el: Element, style: CSSStyleDeclaration | undefined, walk: NameWalk): string => {
    if (walk.visited.has(el)) return '';
    walk.visited.add(el);
    if (!walk.hiddenAllowed && isNameHidden(el, style)) return '';
    const referenced = referencedNamesOf(el, walk);
    if (referenced !== null) return referenced.join(' ');
    const embedded = walk.accessible ? embeddedControlNameOf(el, walk) : null;
    if (embedded !== null) return embedded;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const alternative = altOf(el) ?? svgTitleOf(el);
    if (alternative !== null) return alternative;
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    if (walk.fromContent && !addsContentToName(el)) return excludedDescendantNameOf(el, walk);
    const content = childrenNameOf(el, walk);
    if (content !== '') return content;
    const title = el.getAttribute('title');
    return title === null ? '' : title.trim();
  };

  /**
   * True when a descendant adds its own content to a name from content, as
   * Playwright's `allowsNameFromContent` reads it: no role, a role named from
   * content, or a text or structure role. So a tree item holding its child
   * `group` is named by its own label, and a tab by its text without its
   * `status` badge.
   */
  const addsContentToName = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    const role = explicitRole(el) === null && tag in PLAYWRIGHT_TAG_ROLES ? PLAYWRIGHT_TAG_ROLES[tag] ?? null : implicitRole(el);
    return role === null || ACCNAME_CONTENT_ROLES.has(role) || CONTENT_DESCENDANT_ROLES.has(role);
  };

  /**
   * Tags whose role Playwright reads differently from `implicitRole` in a way
   * that decides whether they add their content: an `<address>` has none, so
   * its text counts, and a `<blockquote>`, `<math>`, or `<search>` has one
   * that is not named from content.
   */
  const PLAYWRIGHT_TAG_ROLES: Readonly<Record<string, string | null>> = {
    address: null,
    blockquote: 'blockquote',
    math: 'math',
    search: 'search',
  };

  /**
   * What a descendant that adds no content of its own adds to a name from
   * content instead: a fieldset its legend, a figure its figcaption, read
   * whole, and anything else its title.
   */
  const excludedDescendantNameOf = (el: Element, walk: NameWalk): string => {
    const caption = namingChildOf(el);
    if (caption !== undefined) return contentNameOf(caption, styleOf(caption), { ...walk, fromContent: false });
    return el.getAttribute('title')?.trim() ?? '';
  };

  /**
   * The children's contributions joined as Playwright's role selector joins
   * them: a space on each side of a block-level child and of a `<br>`, none
   * around an inline one. `<img alt="Search">Go` reads "SearchGo" and
   * `<div>A</div><div>B</div>` reads "A B", so the name a role query matched
   * is the name the node reports. An accessible name wraps them in the
   * element's generated content, so `<button class="next">Go</button>` with
   * `.next::after { content: " \2192" }` is the button "Go →".
   */
  const childrenNameOf = (el: Element, walk: NameWalk): string => {
    let out = walk.accessible ? beforeContentOf(el) : '';
    for (const child of contentChildrenOf(el)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? '';
        continue;
      }
      if (!(child instanceof Element)) continue;
      const style = styleOf(child);
      const token = contentNameOf(child, style, walk);
      const block = child.tagName === 'BR' || (style?.display ?? 'inline') !== 'inline';
      out += block ? ` ${token} ` : token;
    }
    return walk.accessible ? out + afterContentOf(el) : out;
  };

  /**
   * The nodes a name from content reads under an element, in the order the
   * page composes them: a `<slot>` reads what is assigned to it, and a host
   * reads its light children (a slotted one skipped, its slot reads it) and
   * then its shadow tree, so `<button>` whose text lives behind a shadow root
   * is named by that text as Playwright's role selector names it. Which light
   * children are slotted is read from the root's slots, not from each child's
   * `assignedSlot`: a closed root hides that property from the outside while
   * the tracked root's slots still list their assigned nodes.
   */
  const contentChildrenOf = (el: Element): ChildNode[] => {
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes();
      if (assigned.length > 0) return assigned as ChildNode[];
    }
    const shadow = shadowRootOf(el);
    if (shadow === null) return Array.from(el.childNodes);
    const slotted = new Set<Node>();
    for (const slot of Array.from(shadow.querySelectorAll('slot'))) {
      for (const node of slot.assignedNodes()) slotted.add(node);
    }
    const own = Array.from(el.childNodes).filter((child) => !slotted.has(child));
    return own.concat(Array.from(shadow.childNodes));
  };

  /**
   * Text for an accessible name from an element's own content (accname 2F):
   * its descendants' contributions, hidden and aria-hidden subtrees dropped (a
   * required-field marker, a decorative glyph), whitespace collapsed. The
   * element's own attributes are `accessibleName`'s business; this reads what
   * is inside it. `accessible` reads CSS generated content and embedded
   * controls' values too, as an accessible name does and label text does not.
   * `named` is the element the text names when that is not `el` (a control
   * read through its `<label>`), which never contributes to its own name.
   * `fromContent` when accname names `el` from its content, so each
   * descendant's role decides whether its content counts.
   */
  const nameTextOf = (el: Element, accessible: boolean, named: Element = el, fromContent = false): string => {
    if (isNameHidden(el, styleOf(el))) return '';
    if (NAME_OPAQUE_TAGS.has(el.tagName)) return '';
    return childrenNameOf(el, nameWalk([el, named], accessible, fromContent)).replace(/\s+/g, ' ').trim();
  };

  const NAME_OPAQUE_TAGS: ReadonlySet<string> = new Set(['TEXTAREA', 'SELECT', 'INPUT', 'SCRIPT', 'STYLE']);

  /** Roles accname names from their content (2F), the list Playwright's role selector uses. */
  const ACCNAME_CONTENT_ROLES: ReadonlySet<string> = new Set([
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
  ]);

  /**
   * Text and structure roles whose content a descendant adds to a name from
   * content, besides `ACCNAME_CONTENT_ROLES` (Playwright's
   * `allowsNameFromContent`).
   */
  const CONTENT_DESCENDANT_ROLES: ReadonlySet<string> = new Set([
    'caption', 'code', 'contentinfo', 'definition', 'deletion', 'emphasis', 'insertion', 'list', 'listitem',
    'mark', 'none', 'paragraph', 'presentation', 'region', 'row', 'rowgroup', 'section', 'strong',
    'subscript', 'superscript', 'table', 'term', 'time',
  ]);

  /** Roles the tree also names from their content, so a list row or a message reads as one line (`accessibleName`'s `rowContent`). */
  const ROW_CONTENT_ROLES: ReadonlySet<string> = new Set(['listitem', 'status', 'alert']);

  /** HTML-AAM: the child element that names its parent when nothing ARIA does. */
  const NAMING_CHILD_TAGS: Readonly<Record<string, string>> = { fieldset: 'legend', figure: 'figcaption', table: 'caption' };

  /** The `<legend>`, `<figcaption>`, or `<caption>` child that names a fieldset, figure, or table (`NAMING_CHILD_TAGS`). */
  const namingChildOf = (el: Element): Element | undefined => {
    const captionTag = NAMING_CHILD_TAGS[el.tagName.toLowerCase()];
    return captionTag === undefined ? undefined : Array.from(el.children).find((child) => child.tagName.toLowerCase() === captionTag);
  };

  /** The `<label>` elements associated with a labelable element (button, input, meter, output, progress, select, textarea). */
  const associatedLabels = (el: Element): readonly HTMLLabelElement[] => {
    const labels = (el as Element & { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
    return labels === undefined || labels === null ? [] : Array.from(labels);
  };

  /**
   * Every label a person or a tool may call this control by: its `aria-label`,
   * each `aria-labelledby` target, and each associated `<label>`, read as an
   * accessible name (aria-hidden dropped). Null for an element with none. A
   * label query matches any one of them, as Playwright's `getByLabel` does,
   * rather than the combined or overridden name.
   */
  const labelsOf = (el: Element): string[] | null => {
    const labels: string[] = [];
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') labels.push(ariaLabel.trim());
    for (const name of referencedNamesOf(el, nameWalk([], false)) ?? []) labels.push(name);
    for (const label of associatedLabels(el)) {
      const text = nameTextOf(label, false);
      if (text !== '') labels.push(text);
    }
    const shown = labels.map(withoutGlyphs).filter((label) => label !== '');
    return shown.length === 0 ? null : shown;
  };

  /**
   * The element's accessible name (accname 1.2 over HTML-AAM's native
   * sources), null for none. `rowContent` also names a list row, a status,
   * or an alert from its content (`ROW_CONTENT_ROLES`).
   */
  const accessibleName = (el: Element, rowContent: boolean): string | null => {
    // accname reads a labelledby reference (2B) before the element's own aria-label (2C).
    const referenced = referencedNamesOf(el, nameWalk([], true));
    if (referenced !== null) return referenced.join(' ');
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();
    const labels = associatedLabels(el);
    if (labels.length > 0) {
      const joined = labels
        .map((label) => nameTextOf(label, true, el))
        .join(' ')
        .trim();
      if (joined !== '') return joined;
    }
    const role = implicitRole(el);
    const alternative = altOf(el) ?? (role === 'presentation' || role === 'none' ? null : svgTitleOf(el));
    if (alternative !== null) return alternative;
    const caption = namingChildOf(el);
    const captionText = caption === undefined ? '' : nameTextOf(caption, true);
    if (captionText !== '') return captionText;
    if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
      if (el.value.trim() !== '') return el.value.trim();
      // HTML-AAM: a submit or reset button with no value reads its default label.
      if (el.type === 'submit') return 'Submit';
      if (el.type === 'reset') return 'Reset';
    }
    if (role !== null && (ACCNAME_CONTENT_ROLES.has(role) || (rowContent && ROW_CONTENT_ROLES.has(role)))) {
      const text = nameTextOf(el, true, el, ACCNAME_CONTENT_ROLES.has(role));
      if (text !== '') return text;
    }
    const title = el.getAttribute('title');
    if (title !== null && title.trim() !== '') return title.trim();
    // HTML-AAM names an unlabeled text control by its placeholder, after the
    // title: a bare search box is `textbox "Search…"`, not an anonymous field.
    if (isPlaceholderNamed(el)) {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();
      const ariaPlaceholder = el.getAttribute('aria-placeholder');
      if (ariaPlaceholder !== null && ariaPlaceholder.trim() !== '') return ariaPlaceholder.trim();
      if (isEditingHost(el)) return editorPlaceholderOf(el);
    }
    return null;
  };

  /**
   * The controls a placeholder may name: text-like inputs and textareas
   * (HTML-AAM 4.1.1), and the textbox and searchbox roles `aria-placeholder`
   * applies to, an editing host among them.
   */
  const isPlaceholderNamed = (el: Element): boolean => {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return PLACEHOLDER_NAMED_INPUT_TYPES.indexOf(el.type) !== -1;
    const role = implicitRole(el);
    return role === 'textbox' || role === 'searchbox';
  };

  /**
   * The placeholder a rich-text editor paints from `data-placeholder`, the one
   * convention its frameworks share: Quill sets it on the host; ProseMirror
   * and TipTap set it on the first empty block and drop it once the document
   * has content, as the painted hint goes.
   */
  const editorPlaceholderOf = (host: Element): string | null => {
    const own = host.getAttribute('data-placeholder');
    if (own !== null && own.trim() !== '') return own.trim();
    for (const block of Array.from(host.querySelectorAll('[data-placeholder]'))) {
      if ((block.textContent ?? '').trim() !== '') continue;
      const placeholder = block.getAttribute('data-placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return placeholder.trim();
    }
    return null;
  };

  return { accessibleName, reportedName, labelsOf };
};
