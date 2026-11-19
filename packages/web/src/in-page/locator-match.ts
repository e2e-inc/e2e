/**
 * How a locate matches elements. Serialized into the page beside the
 * semantic reader it reads through, so this is one self-contained function
 * under the rule `read-semantics.ts` states.
 */

import type { SemanticQuery, TextMatching } from '@e2e-dev/core/engine';
import type { createSemanticReader } from './read-semantics.ts';

/**
 * Whether an element answers a query of a locate, under one reader, as
 * Playwright's engines match: text queries on the element's joined text,
 * label queries on any of its labels, role queries skipping what is hidden
 * from the accessibility tree. It compares the reader's own reads, and
 * beside them the ones Playwright's engines read differently from the
 * tree: an element's text as the text engine joins it (shadow roots
 * included), whether the role engine counts it hidden
 * (`isElementHiddenForAria`, with the text of a `display: contents` element
 * shown by the reader's own rule, `showsText`), its ARIA states with `mixed`
 * and absent kept apart from false (`getAriaChecked`, `getAriaPressed`,
 * `getAriaExpanded`, `getAriaSelected`), and its level (`getAriaLevel`: a
 * heading tag's before `aria-level`, none without either). Each read is
 * computed when first asked and kept for the rest of the locate (the
 * reader's `memoized`), so a query pays only for what it compares. In a
 * hidden frame (`frameHidden`) every element is hidden.
 */
export const createLocatorMatch = (
  reader: ReturnType<typeof createSemanticReader>,
  options: { readonly testIdAttribute: string; readonly secureFieldSelector: string },
  matchesText: TextMatching['matchesText'],
  frameHidden: boolean,
) => {
  const { memoized, styleOf, parentOrHostOf, showsText } = reader;
  const joinedTextOf = memoized((root: Element | ShadowRoot): string => {
    let full = '';
    const skipped = root.nodeType === 1 && (['SCRIPT', 'NOSCRIPT', 'STYLE'].indexOf(root.nodeName) !== -1 || (document.head !== null && document.head.contains(root)));
    if (!skipped) {
      if (root.nodeName === 'INPUT' && ['submit', 'button', 'reset'].indexOf((root as HTMLInputElement).type) !== -1) {
        full = (root as HTMLInputElement).value;
      } else {
        for (let child = root.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType === 3) full += child.nodeValue ?? '';
          else if (child.nodeType === 1) full += joinedTextOf(child as Element);
        }
        const shadow = root.nodeType === 1 ? (root as Element).shadowRoot : null;
        if (shadow !== null) full += joinedTextOf(shadow);
      }
    }
    return full;
  });
  const belongsHidden = memoized((el: Element): boolean => {
    if (el.parentElement !== null && el.parentElement.shadowRoot !== null && el.assignedSlot === null) return true;
    if (styleOf(el)?.display === 'none' || (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') return true;
    const parent = parentOrHostOf(el);
    return parent !== null && belongsHidden(parent);
  });
  const hiddenForAria = memoized((el: Element): boolean => {
    if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].indexOf(el.nodeName) !== -1) return true;
    const style = styleOf(el);
    if (style === undefined) return true;
    const slot = el.nodeName === 'SLOT';
    if (style.display === 'contents' && !slot) {
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1 && !hiddenForAria(child as Element)) return false;
        if (child.nodeType === 3 && showsText(child, style)) return false;
      }
      return true;
    }
    const option = el.nodeName === 'OPTION' && el.closest('select') !== null;
    const styleVisible = (typeof el.checkVisibility !== 'function' || el.checkVisibility()) && style.visibility === 'visible';
    if (!option && !slot && !styleVisible) return true;
    return belongsHidden(el);
  });
  const CHECKED_ROLES = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
  const EXPANDED_ROLES = ['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'row', 'rowheader', 'tab', 'treeitem', 'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch'];
  const SELECTED_ROLES = ['gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
  const ariaState = (el: Element, attribute: string): boolean | 'mixed' => {
    const value = el.getAttribute(attribute);
    return value === 'true' ? true : value === 'mixed' ? 'mixed' : false;
  };
  /** The element's text as Playwright's text engine joins it: its shadow roots included, whitespace collapsed. */
  const text = (el: Element): string => joinedTextOf(el).replace(/\u200b/g, '').trim().replace(/\s+/g, ' ');
  /** The element's ARIA states, read for `role`: `mixed` and absent kept apart from false. */
  const states = (el: Element, role: string) => {
    const input = el instanceof HTMLInputElement ? el : null;
    let checked: boolean | 'mixed' = false;
    if (input !== null && input.indeterminate) checked = 'mixed';
    else if (input !== null && (input.type === 'checkbox' || input.type === 'radio')) checked = input.checked;
    else if (CHECKED_ROLES.indexOf(role) !== -1) checked = ariaState(el, 'aria-checked');
    let expanded: boolean | null = null;
    if (el instanceof HTMLDetailsElement) expanded = el.open;
    else if (EXPANDED_ROLES.indexOf(role) !== -1 && el.hasAttribute('aria-expanded')) expanded = el.getAttribute('aria-expanded') === 'true';
    return {
      checked,
      pressed: role === 'button' ? ariaState(el, 'aria-pressed') : false,
      expanded,
      selected: el instanceof HTMLOptionElement ? el.selected : SELECTED_ROLES.indexOf(role) !== -1 && (el.getAttribute('aria-selected') ?? '').toLowerCase() === 'true',
    };
  };
  /** The level a role query compares, as Playwright reads it: a heading tag's, else a whole `aria-level` of at least 1, else none. */
  const level = (el: Element): number | null => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return Number(tag.slice(1));
    const attribute = el.getAttribute('aria-level');
    const value = attribute === null ? Number.NaN : Number(attribute);
    return Number.isInteger(value) && value >= 1 ? value : null;
  };
  /** The value a display-value query compares: an input's (but a checkbox's or radio's), a textarea's, or a select's; null for a secure field and anything else. */
  const displayValue = (el: Element): string | null =>
    el.matches('input:not([type="checkbox" i]):not([type="radio" i]), textarea, select') && !el.matches(options.secureFieldSelector)
      ? (el as HTMLInputElement).value
      : null;
  /** Whether `element` answers `query`. */
  const matches = (element: Element, query: SemanticQuery): boolean => {
    if (query.visible === true && (frameHidden || reader.hidden(element))) return false;
    switch (query.kind) {
      case 'role': {
        if (query.value.kind !== 'string' || frameHidden || !reader.hasRole(element, query.value.value)) return false;
        if (query.name !== undefined && !matchesText(reader.name(element) ?? '', query.name)) return false;
        if (hiddenForAria(element)) return false;
        const wanted = query.states ?? {};
        if (wanted.checked !== undefined || wanted.pressed !== undefined || wanted.expanded !== undefined || wanted.selected !== undefined) {
          const found = states(element, query.value.value);
          if (wanted.checked !== undefined && found.checked !== wanted.checked) return false;
          if (wanted.pressed !== undefined && found.pressed !== wanted.pressed) return false;
          if (wanted.expanded !== undefined && found.expanded !== wanted.expanded) return false;
          if (wanted.selected !== undefined && found.selected !== wanted.selected) return false;
        }
        if (wanted.disabled !== undefined && reader.disabled(element) !== wanted.disabled) return false;
        return query.level === undefined || level(element) === query.level;
      }
      case 'text':
        return matchesText(text(element), query.value);
      case 'label':
        return (reader.labels(element) ?? []).some((label) => matchesText(label, query.value));
      case 'displayValue': {
        const value = displayValue(element);
        return value !== null && matchesText(value, query.value);
      }
      case 'placeholder': {
        const placeholder = element.getAttribute('placeholder');
        return placeholder !== null && matchesText(placeholder, query.value);
      }
      case 'testId': {
        const testId = element.getAttribute(options.testIdAttribute);
        return testId !== null && matchesText(testId, query.value);
      }
    }
  };
  return { matches, text };
};
