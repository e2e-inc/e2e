/**
 * The semantic reader's role computation: an element's ARIA role, the first
 * one its `role` attribute names that ARIA knows, else the one HTML-AAM gives
 * its tag, read as Playwright's role selector reads it. Serialized into the
 * page with the reader that builds it, so this is one self-contained function
 * under the rule `read-semantics.ts` states.
 */

/**
 * Builds the role computation for one read: `memoized` is the reader's
 * per-node memo, and `opaqueTags` the drawn and embedded surfaces the reader
 * never walks into, none of which a `contenteditable` makes an editing host.
 */
export const createRoles = (
  memoized: <T>(compute: (el: Element) => T) => (el: Element) => T,
  opaqueTags: readonly string[],
) => {
  /** Concrete WAI-ARIA roles, excluding abstract roles that cannot label an element. */
  const ARIA_ROLES = [
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
    'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition',
    'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form',
    'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link',
    'list', 'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math',
    'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none',
    'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region',
    'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
    'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
    'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip',
    'tree', 'treegrid', 'treeitem',
  ];
  /** ARIA uses the first recognized token, then native semantics if none is recognized. */
  const explicitRole = memoized((el: Element): string | null =>
    (el.getAttribute('role') ?? '').split(/[ \t\n\f\r]+/).find((role) => ARIA_ROLES.indexOf(role) !== -1) ?? null);

  /**
   * True when an element carries a name of its own (HTML-AAM: `aria-label`,
   * `aria-labelledby`, or `title`). A `<form>` or `<section>` is a landmark
   * only when named; unnamed, it is a plain container.
   */
  const hasOwnName = (el: Element): boolean =>
    ['aria-label', 'aria-labelledby', 'title'].some((attribute) => (el.getAttribute(attribute) ?? '').trim() !== '');

  const SECTIONING_SCOPE = [
    'article', 'aside', 'main', 'nav', 'section',
    ...['article', 'complementary', 'main', 'navigation', 'region'].map((role) => `[role~="${role}"]`),
  ].join(', ');

  /**
   * True when a `<header>` or `<footer>` is the page's, not an article's or a
   * section's: only then is it the `banner` or `contentinfo` landmark.
   * HTML-AAM scopes it to sectioning content and to the ARIA roles that stand
   * for it, so a `<div role="article">` scopes it like an `<article>`.
   */
  const isPageLevel = (el: Element): boolean => {
    for (let candidate: Element | null = el; candidate !== null;) {
      if (candidate.closest(SECTIONING_SCOPE) !== null) return false;
      const root = candidate.getRootNode();
      candidate = root instanceof ShadowRoot ? root.host : null;
    }
    return true;
  };

  /**
   * Tags a `contenteditable` never makes an editing host. A drawn or embedded
   * surface and a void element hold no DOM text to edit; a native control (a
   * link, a button, a form field) has a role and a value of its own, so a fill
   * reaches it as what it is. Chromium reports `isContentEditable` on all of
   * them regardless.
   */
  const NON_HOST_TAGS = [...opaqueTags, 'iframe', 'img', 'hr', 'br', 'wbr', 'area', 'a', 'button', 'input', 'textarea', 'select'];

  /**
   * The root of a contenteditable region: editable itself, under a parent that
   * is not. A rich-text editor (ProseMirror, TipTap, Lexical, Slate) renders
   * its document as such a host with block children; the host is the control
   * a person types into and the blocks are its content, so only the host is a
   * textbox, whatever its tag: an `<article contenteditable>` is the editor,
   * not an article. A canvas made editable to collect keystrokes is a drawn
   * field the keyboard reaches, not a textbox; see `NON_HOST_TAGS`.
   */
  const isEditingHost = (el: Element): boolean =>
    el instanceof HTMLElement &&
    el.isContentEditable &&
    NON_HOST_TAGS.indexOf(el.tagName.toLowerCase()) === -1 &&
    !(el.parentElement instanceof HTMLElement && el.parentElement.isContentEditable);

  const NAME_PROHIBITED_ROLES = [
    'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph', 'presentation', 'strong',
    'subscript', 'superscript',
  ];
  /** Global ARIA attributes, each with the roles it does not count on, as Playwright lists them. */
  const GLOBAL_ARIA_ATTRIBUTES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['aria-atomic', []],
    ['aria-busy', []],
    ['aria-controls', []],
    ['aria-current', []],
    ['aria-describedby', []],
    ['aria-details', []],
    ['aria-dropeffect', []],
    ['aria-flowto', []],
    ['aria-grabbed', []],
    ['aria-hidden', []],
    ['aria-keyshortcuts', []],
    ['aria-label', NAME_PROHIBITED_ROLES],
    ['aria-labelledby', NAME_PROHIBITED_ROLES],
    ['aria-live', []],
    ['aria-owns', []],
    ['aria-relevant', []],
    ['aria-roledescription', ['generic']],
  ];

  /** Playwright's implicit role for the tags whose role some global ARIA attributes do not count on. */
  const NAME_PROHIBITED_TAG_ROLES: Readonly<Record<string, string>> = {
    caption: 'caption', code: 'code', del: 'deletion', em: 'emphasis', ins: 'insertion', p: 'paragraph',
    strong: 'strong', sub: 'subscript', sup: 'superscript',
  };

  /** True when the element carries a global ARIA attribute that counts on `role`. */
  const hasGlobalAriaAttribute = (el: Element, role: string | null): boolean =>
    GLOBAL_ARIA_ATTRIBUTES.some(([name, prohibited]) =>
      (role === null || prohibited.indexOf(role) === -1) && el.hasAttribute(name));

  /** True when `tabindex` parses as a number, as Playwright reads it. */
  const hasTabIndex = (el: Element): boolean => !Number.isNaN(Number(String(el.getAttribute('tabindex'))));

  /** Whether a person can focus the element, as Playwright decides presentational-role conflicts. */
  const isFocusable = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea', 'option', 'optgroup'].indexOf(tag) !== -1 && el.matches(':disabled')) {
      return false;
    }
    if (hasTabIndex(el) || ['button', 'details', 'select', 'textarea'].indexOf(tag) !== -1) return true;
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
    return tag === 'input' && !(el as HTMLInputElement).hidden;
  };

  /**
   * WAI-ARIA presentational-role conflict resolution: `presentation` or
   * `none` is ignored on a focusable element or one with a global ARIA
   * attribute, and the tag's role stands.
   */
  const hasPresentationConflict = (el: Element): boolean =>
    isFocusable(el) || hasGlobalAriaAttribute(el, NAME_PROHIBITED_TAG_ROLES[el.tagName.toLowerCase()] ?? null);

  const implicitRole = memoized((el: Element): string | null => {
    const explicit = explicitRole(el);
    if (explicit !== null && !((explicit === 'presentation' || explicit === 'none') && hasPresentationConflict(el))) {
      // The vocabulary spells ARIA's `img` as `image`.
      return explicit === 'img' ? 'image' : explicit;
    }
    // Ahead of the tag: an editor's host is the control, whatever landmark or
    // structure its tag would otherwise be.
    if (isEditingHost(el)) return 'textbox';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    switch (tag) {
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'button':
        return 'button';
      // HTML-AAM: a select that shows several rows is a listbox; only a
      // one-row drop-down is a combobox.
      case 'select':
        return el.hasAttribute('multiple') || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return el.getAttribute('alt') === '' && !el.getAttribute('title') && !hasGlobalAriaAttribute(el, null) && !hasTabIndex(el)
          ? 'presentation'
          : 'image';
      // An inline icon is a picture whether or not anything names it, as
      // Playwright reads it; Chrome ignores an unnamed one.
      case 'svg':
        return 'image';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'header':
        return isPageLevel(el) ? 'banner' : null;
      case 'footer':
        return isPageLevel(el) ? 'contentinfo' : null;
      case 'section':
        return hasOwnName(el) ? 'region' : null;
      case 'form':
        return hasOwnName(el) ? 'form' : null;
      case 'article':
        return 'article';
      case 'figure':
        return 'figure';
      case 'hr':
        return 'separator';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      // HTML-AAM: `<menu>` is a list; only `role="menu"` is a menu.
      case 'menu':
        return 'list';
      case 'fieldset':
      case 'details':
      case 'optgroup':
      case 'address':
        return 'group';
      case 'option':
        return 'option';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'li':
        return 'listitem';
      case 'ul':
      case 'ol':
        return 'list';
      case 'table':
        return 'table';
      // Rows and cells carry the structure a table's controls belong to: a
      // "Delete" button means one thing per row, and only the row says which.
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return 'rowgroup';
      case 'tr':
        return 'row';
      // A grid's cells are the interactive kind, as Playwright reads them.
      case 'td': {
        const table = el.closest('table');
        const tableRole = table === null ? null : explicitRole(table);
        return tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';
      }
      case 'th': {
        const scope = (el.getAttribute('scope') ?? '').toLowerCase();
        if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
        if (scope === 'col' || scope === 'colgroup') return 'columnheader';
        const previous = el.previousElementSibling;
        const next = el.nextElementSibling;
        if (previous === null && next === null) {
          const row = el.parentElement;
          const table = row?.tagName.toLowerCase() === 'tr' ? row.closest('table') : null;
          return table !== null && (table as HTMLTableElement).rows.length <= 1 ? null : 'columnheader';
        }
        if (previous?.tagName.toLowerCase() === 'th' && next?.tagName.toLowerCase() === 'th') return 'columnheader';
        const hasDataNeighbor = [previous, next].some((cell) =>
          cell?.tagName.toLowerCase() === 'td' && ((cell.textContent ?? '').trim() !== '' || cell.children.length > 0));
        return hasDataNeighbor ? 'rowheader' : 'columnheader';
      }
      case 'dialog':
        return 'dialog';
      case 'output':
        return 'status';
      case 'input':
        // HTML-AAM: a text field with suggestions from a datalist is a combobox.
        // `list` resolves the attribute to a datalist element, null for anything else.
        // The `type` property, not the attribute: a type the browser does not know is `text`.
        if ((el as HTMLInputElement).list !== null && ['text', 'search', 'tel', 'url', 'email'].indexOf((el as HTMLInputElement).type) !== -1) return 'combobox';
        switch (type) {
          case 'button':
          case 'submit':
          case 'reset':
          case 'image':
          // A file input is its picker button, as Chrome and Playwright read it.
          case 'file':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'range':
            return 'slider';
          case 'number':
            return 'spinbutton';
          case 'search':
            return 'searchbox';
          case 'hidden':
            return null;
          default:
            return 'textbox';
        }
      default:
        return null;
    }
  });

  return { explicitRole, implicitRole, isEditingHost };
};
