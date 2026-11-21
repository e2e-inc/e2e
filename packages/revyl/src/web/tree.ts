/**
 * Revyl's Maestro web hierarchy as the contract's `SemanticNode` tree. The
 * hierarchy lists every element of the page (frames included) with its own
 * text, its box, and one identifier, but no tag or role, so roles, test ids,
 * placeholders, and CSS selectors come from `maestro_web_query` and are
 * matched back onto the hierarchy in document order.
 */

import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT, type LocatorExpression, type SemanticNode, type ViewportSize } from '@e2e-dev/core/engine';

export interface MaestroBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface MaestroNode {
  readonly attributes: {
    readonly text: string;
    readonly bounds: MaestroBounds;
    readonly 'resource-id'?: string;
    readonly selected?: boolean;
  };
  readonly children: readonly MaestroNode[];
}

/** One hierarchy element and its position, the id the engine mints for it. */
export interface Element {
  readonly id: string;
  readonly node: MaestroNode;
}

/** Input types that are not text entry: each has a role of its own, or none. */
const NOT_TEXT = ['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'hidden'].map((type) => `:not([type="${type}"])`).join('');
/** Input types a `list` (a datalist of suggestions) turns into a combobox. */
const SUGGESTING = ':is(:not([type]), [type="text"], [type="search"], [type="tel"], [type="url"], [type="email"])';

/**
 * The elements HTML gives each ARIA role, as the web engine's reader maps
 * them (`packages/web/src/in-page/read-semantics.ts`), so a role locator
 * resolves alike on `web()` and `revylWeb()`. Each matches only without a
 * `role` attribute, so an explicit role (`<input role="combobox">`) wins; a
 * role not listed is matched by its `role` attribute alone.
 */
const IMPLICIT_ROLES: Readonly<Record<string, readonly string[]>> = {
  button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', 'input[type="image"]', 'input[type="file"]'],
  link: ['a[href]', 'area[href]'],
  textbox: [
    `input${NOT_TEXT}:not([type="number"]):not([type="search"]):not([list])`,
    `input${NOT_TEXT}:not([type="number"])[list]:not(${SUGGESTING})`,
    'textarea',
    '[contenteditable=""]',
    '[contenteditable="true"]',
  ],
  searchbox: ['input[type="search"]:not([list])'],
  spinbutton: ['input[type="number"]'],
  combobox: [`input[list]${SUGGESTING}`, 'select:not([multiple]):not([size])', 'select[size="0"]:not([multiple])', 'select[size="1"]:not([multiple])'],
  listbox: ['select[multiple]', 'select[size]:not([size="0"]):not([size="1"])'],
  checkbox: ['input[type="checkbox"]'],
  radio: ['input[type="radio"]'],
  slider: ['input[type="range"]'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  list: ['ul', 'ol', 'menu'],
  listitem: ['li'],
  navigation: ['nav'],
  main: ['main'],
  complementary: ['aside'],
  banner: ['header:not(:is(article, aside, main, nav, section) header)'],
  contentinfo: ['footer:not(:is(article, aside, main, nav, section) footer)'],
  region: ['section:is([aria-label], [aria-labelledby], [title])'],
  form: ['form:is([aria-label], [aria-labelledby], [title])'],
  article: ['article'],
  figure: ['figure'],
  separator: ['hr'],
  progressbar: ['progress'],
  meter: ['meter'],
  group: ['fieldset', 'details', 'optgroup', 'address'],
  option: ['option'],
  table: ['table'],
  rowgroup: ['thead', 'tbody', 'tfoot'],
  row: ['tr'],
  cell: ['td'],
  columnheader: ['th'],
  dialog: ['dialog'],
  status: ['output'],
};

/**
 * The elements whose hierarchy text is their value (or, empty, their
 * placeholder or aria-label), never content a user reads: text fields,
 * selects, and editing hosts.
 */
const FIELD_SELECTOR = [`input${NOT_TEXT}`, 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]', ...['textbox', 'searchbox', 'spinbutton', 'combobox'].map((role) => `[role="${role}"]`)].join(', ');

/** The fields a tap only focuses: every field but a select or a non-input combobox. */
const TEXT_ENTRY_SELECTOR = [`input${NOT_TEXT}`, 'textarea', '[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]', '[role="searchbox"]', '[role="spinbutton"]'].join(', ');

function roleSelector(role: string): string {
  return [...(IMPLICIT_ROLES[role] ?? []).map((element) => `${element}:not([role])`), `[role=${JSON.stringify(role)}]`].join(', ');
}

/**
 * What an observation marks: the roles the agent acts on, and the fields
 * whose text is a placeholder rather than a value.
 */
export const OBSERVED_MARKS: readonly Mark[] = [
  ...['button', 'link', 'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox', 'checkbox', 'radio', 'slider'].map((role): Mark => ({ kind: 'role', role })),
  { kind: 'field' },
  { kind: 'placeholderShown' },
  { kind: 'secure' },
  { kind: 'state', state: 'checked' },
  { kind: 'state', state: 'disabled' },
];

/** Roles whose hierarchy text is their `value` attribute (`on`), not anything a user reads. */
const TOGGLE_ROLES: ReadonlySet<string> = new Set(['checkbox', 'radio']);

/** Roles whose accessible name is their content; a field's name is its label or identifier. */
const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'listitem', 'option', 'cell', 'columnheader', 'tab', 'menuitem']);

/** One CSS query the projection needs, and what a match tells it. */
export type Mark =
  | { readonly kind: 'role'; readonly role: string; readonly level?: number }
  | { readonly kind: 'testId'; readonly value: string; readonly attribute: string }
  | { readonly kind: 'placeholder'; readonly value: string }
  | { readonly kind: 'placeholderShown' }
  | { readonly kind: 'field' }
  | { readonly kind: 'secure' }
  | { readonly kind: 'labelShown'; readonly label: string }
  | { readonly kind: 'focus' }
  | { readonly kind: 'textEntry' }
  | { readonly kind: 'state'; readonly state: 'checked' | 'disabled' }
  | { readonly kind: 'selector'; readonly selector: string };

export function markSelector(mark: Mark): string {
  switch (mark.kind) {
    case 'role':
      if (mark.role === 'heading' && mark.level !== undefined) return `h${mark.level}:not([role]), [role="heading"][aria-level="${mark.level}"]`;
      return roleSelector(mark.role);
    case 'testId':
      return `[${mark.attribute}=${JSON.stringify(mark.value)}]`;
    case 'placeholder':
      return `[placeholder=${JSON.stringify(mark.value)}]`;
    case 'placeholderShown':
      return ':placeholder-shown';
    case 'secure':
      return 'input[type="password"]';
    case 'focus':
      return ':focus';
    case 'textEntry':
      return TEXT_ENTRY_SELECTOR;
    case 'field':
      return FIELD_SELECTOR;
    case 'labelShown':
      return `:is(input, textarea)[aria-label=${JSON.stringify(mark.label)}]`;
    case 'state':
      return `:${mark.state}, [aria-${mark.state}="true"]`;
    case 'selector':
      return mark.selector;
  }
}

/** Whether a mark's answer can change while the hierarchy does not: a state, the focus, or a test's own CSS. */
export function isVolatile(mark: Mark): boolean {
  return mark.kind === 'state' || mark.kind === 'focus' || mark.kind === 'selector';
}

function markKey(mark: Mark): string {
  return JSON.stringify(mark);
}

/** The marks resolving `expression` needs: the field marks, its roles, exact test ids and placeholders, and CSS selectors. */
export function marksFor(expression: LocatorExpression, testIdAttribute: string): Mark[] {
  const marks = new Map<string, Mark>();
  const add = (mark: Mark): void => void marks.set(markKey(mark), mark);
  // A field's hierarchy text is its value or placeholder, never its content, so
  // every resolution marks fields: unmarked, a field's value matches getByText.
  add({ kind: 'field' });
  add({ kind: 'placeholderShown' });
  // A password field's text is its value: it is marked so the value is never reported.
  add({ kind: 'secure' });
  // The hierarchy reports no element state, so every resolution asks for it,
  // and for the toggles that carry it, whatever the locator names.
  for (const role of TOGGLE_ROLES) add({ kind: 'role', role });
  add({ kind: 'state', state: 'checked' });
  add({ kind: 'state', state: 'disabled' });
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'query': {
        const { query } = node;
        if (query.kind === 'role' && query.value.kind === 'string') {
          add(query.level === undefined ? { kind: 'role', role: query.value.value } : { kind: 'role', role: query.value.value, level: query.level });
        }
        if (query.kind === 'testId' && query.value.kind === 'string' && query.value.exact) add({ kind: 'testId', value: query.value.value, attribute: testIdAttribute });
        if (query.kind === 'placeholder' && query.value.kind === 'string' && query.value.exact) add({ kind: 'placeholder', value: query.value.value });
        if (node.scope !== undefined) walk(node.scope);
        return;
      }
      case 'filter':
        walk(node.source);
        if (node.has !== undefined) walk(node.has);
        if (node.hasNot !== undefined) walk(node.hasNot);
        return;
      case 'index':
        return walk(node.source);
      case 'selector':
        return add({ kind: 'selector', selector: node.selector });
      case 'frame':
        return walk(node.source);
      case 'union':
        walk(node.left);
        return walk(node.right);
    }
  };
  walk(expression);
  return [...marks.values()];
}

/**
 * The marks that find fields showing their aria-label because they are
 * empty: Revyl reads an empty field with no placeholder as its aria-label.
 * One per text a shown field marked by `matched` shows, so a match counts
 * only for a field whose own text is that label.
 */
export function labelShownMarks(elements: readonly Element[], matched: ReadonlyArray<readonly [Mark, readonly MaestroNode[]]>): Mark[] {
  const fields = new Set<string>();
  const placeholders = new Set<string>();
  for (const [mark, matches] of matched) {
    const ids = matchElements(elements, matches);
    for (const id of ids) (mark.kind === 'placeholderShown' ? placeholders : mark.kind === 'field' ? fields : undefined)?.add(id);
  }
  // A password field's text is its value, and a label query would send it to
  // Revyl as a selector; it is never asked about.
  const secure = secureNodes(elements, matched);
  // A hidden field (no size) is left out: its value is rarely asserted, and
  // a page keeps many, as a list keeps an edit field per row.
  const shown = (node: MaestroNode): boolean => node.attributes.bounds.right > node.attributes.bounds.left && node.attributes.bounds.bottom > node.attributes.bounds.top;
  const labels = elements.flatMap((element) =>
    fields.has(element.id) && !placeholders.has(element.id) && !secure.has(element.node) && element.node.attributes.text !== '' && shown(element.node)
      ? [element.node.attributes.text]
      : [],
  );
  return [...new Set(labels)].map((label) => ({ kind: 'labelShown', label }));
}

/**
 * The password fields of a read, failing closed. The password query and the
 * hierarchy are separate reads, so a field that moved or changed between
 * them matches no element; then every element showing that answer's text is
 * treated as the field, so its text is never reported.
 */
export function secureNodes(elements: readonly Element[], matched: ReadonlyArray<readonly [Mark, readonly MaestroNode[]]>): Set<MaestroNode> {
  const answers = matched.flatMap(([mark, matches]) => (mark.kind === 'secure' ? matches : []));
  const ids = matchElements(elements, answers);
  const unmatched = new Set(answers.filter((answer) => !elements.some((element) => ids.has(element.id) && sameAttributes(element.node, answer))).map((answer) => answer.attributes.text).filter((text) => text !== ''));
  return new Set(elements.filter((element) => ids.has(element.id) || unmatched.has(element.node.attributes.text)).map((element) => element.node));
}

/** Every element in document order, each with its child-index path as its id. */
export function flatten(root: MaestroNode): Element[] {
  const elements: Element[] = [];
  const visit = (node: MaestroNode, id: string): void => {
    elements.push({ id, node });
    node.children.forEach((child, index) => visit(child, `${id}.${index}`));
  };
  visit(root, 'e0');
  return elements;
}

/**
 * The ids of `matches` in `elements`. Both lists are in document order, so
 * each match takes the next element with the same text, box, and identifier.
 * The query and the hierarchy are separate reads: a match whose element
 * changed between them (an animation, a countdown) finds none and is
 * skipped, and the matches after it still find theirs.
 */
export function matchElements(elements: readonly Element[], matches: readonly MaestroNode[]): Set<string> {
  const ids = new Set<string>();
  let cursor = 0;
  for (const match of matches) {
    for (let index = cursor; index < elements.length; index += 1) {
      const element = elements[index];
      if (element !== undefined && sameAttributes(element.node, match)) {
        ids.add(element.id);
        cursor = index + 1;
        break;
      }
    }
  }
  return ids;
}

export function sameAttributes(a: MaestroNode, b: MaestroNode): boolean {
  const x = a.attributes;
  const y = b.attributes;
  return (
    x.text === y.text &&
    x['resource-id'] === y['resource-id'] &&
    x.bounds.left === y.bounds.left &&
    x.bounds.top === y.bounds.top &&
    x.bounds.right === y.bounds.right &&
    x.bounds.bottom === y.bounds.bottom
  );
}

/** What the CSS queries found, by element id. */
export interface MarkedElements {
  readonly marks: ReadonlyMap<string, readonly Mark[]>;
  /**
   * The exact test ids a locator asked for. Only an element whose
   * `testIdAttribute` holds one carries it as its test id; an element whose
   * identifier merely equals it (a label's `for`, a field's `name`) does not.
   */
  readonly testIds: ReadonlySet<string>;
  /** The password fields, from `secureNodes`: their text is never reported. */
  readonly secure: ReadonlySet<MaestroNode>;
}

export const ROOT_ID = 'root';

/**
 * The semantic tree under one stable root. An element with no text, no
 * identifier, and no mark is left out and its children take its place, so
 * the layout wrappers of a page do not crowd the observation.
 */
export function project(elements: readonly Element[], marked: MarkedElements, viewport: ViewportSize, observed: boolean): SemanticNode {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const limits = { name: observed ? OBSERVED_NAME_LIMIT : Infinity, text: observed ? OBSERVED_TEXT_LIMIT : Infinity, secure: marked.secure };
  const build = (element: Element): SemanticNode[] => {
    const children = element.node.children.flatMap((_, index) => {
      const child = byId.get(`${element.id}.${index}`);
      return child === undefined ? [] : build(child);
    });
    const marks = marked.marks.get(element.id) ?? [];
    const attributes = element.node.attributes;
    const text = collapse(attributes.text);
    const identifier = attributes['resource-id'];
    if (text === '' && identifier === undefined && marks.length === 0) return children;
    return [semanticNode(element, marks, text, children, marked.testIds, limits)];
  };
  const body = elements[0];
  return {
    ref: { id: ROOT_ID, revision: '' },
    role: 'document',
    rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    children: body === undefined ? [] : build(body),
  };
}

/** How much of a name or text a projection keeps, and the password fields whose text it never reports. */
interface Limits {
  readonly name: number;
  readonly text: number;
  readonly secure: ReadonlySet<MaestroNode>;
}

function semanticNode(element: Element, marks: readonly Mark[], text: string, children: SemanticNode[], testIds: ReadonlySet<string>, limits: Limits): SemanticNode {
  const { bounds, selected } = element.node.attributes;
  const identifier = element.node.attributes['resource-id'];
  const roleMark = marks.find((mark): mark is Extract<Mark, { kind: 'role' }> => mark.kind === 'role' && mark.level === undefined) ??
    marks.find((mark): mark is Extract<Mark, { kind: 'role' }> => mark.kind === 'role');
  const role = roleMark?.role;
  const level = marks.find((mark): mark is Extract<Mark, { kind: 'role' }> => mark.kind === 'role' && mark.level !== undefined)?.level;
  const testId =
    marks.find((mark): mark is Extract<Mark, { kind: 'testId' }> => mark.kind === 'testId')?.value ??
    (identifier !== undefined && testIds.has(identifier) ? undefined : identifier);
  const placeholderShown = marks.some((mark) => mark.kind === 'placeholderShown');
  const placeholder =
    marks.find((mark): mark is Extract<Mark, { kind: 'placeholder' }> => mark.kind === 'placeholder')?.value ?? (placeholderShown && text !== '' ? text : undefined);
  const field = marks.some((mark) => mark.kind === 'field');
  const name = role === undefined ? (field ? identifier : undefined) : NAME_FROM_CONTENT.has(role) ? collapse(nameText(element.node, limits.secure)) || identifier : identifier;
  const secure = limits.secure.has(element.node);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const hidden = width <= 0 || height <= 0;
  const toggle = role !== undefined && TOGGLE_ROLES.has(role);
  const hasValue = field && !toggle;
  // Revyl reads an empty field as its placeholder, else its aria-label: a
  // field showing either one has no value.
  const emptyField = placeholderShown || marks.some((mark) => mark.kind === 'labelShown' && mark.label === element.node.attributes.text);
  const checked = marks.some((mark) => mark.kind === 'state' && mark.state === 'checked');
  const disabled = marks.some((mark) => mark.kind === 'state' && mark.state === 'disabled');
  return {
    ref: { id: element.id, revision: '' },
    ...(role === undefined ? {} : { role }),
    ...(name === undefined || name === '' ? {} : { name: name.slice(0, limits.name) }),
    ...(text === '' || hasValue || toggle || secure ? {} : { text: text.slice(0, limits.text) }),
    ...(hasValue && text !== '' && !emptyField && !secure ? { value: text.slice(0, limits.text) } : {}),
    ...(secure ? { inputPurpose: 'password' as const } : {}),
    ...(testId === undefined ? {} : { testId }),
    ...(level === undefined ? {} : { level }),
    ...(placeholder === undefined && identifier === undefined
      ? {}
      : { attributes: { ...(placeholder === undefined ? {} : { placeholder }), ...(identifier === undefined ? {} : { 'resource-id': identifier }) } }),
    states: { hidden, ...(selected === true ? { selected: true } : {}), ...(toggle ? { checked } : {}), ...(disabled ? { disabled: true } : {}), ...(secure ? { secure: true } : {}) },
    rect: { x: bounds.left, y: bounds.top, width: Math.max(0, width), height: Math.max(0, height) },
    ...(children.length === 0 ? {} : { children }),
  };
}

/**
 * The text an accessible name is built from: the node's own text and its
 * descendants', leaving out the own text of a descendant with no size
 * (`display: none`, whose children have no size either), as Chrome's name
 * does, and any password field.
 */
function nameText(node: MaestroNode, secure: ReadonlySet<MaestroNode>): string {
  const shown = (current: MaestroNode): boolean => current.attributes.bounds.right > current.attributes.bounds.left && current.attributes.bounds.bottom > current.attributes.bounds.top;
  // A descendant with no size keeps its children: a `display: contents`
  // wrapper has none, yet what it wraps shows. Its own text is left out.
  const walk = (current: MaestroNode, own: boolean): string =>
    secure.has(current) ? '' : [own ? current.attributes.text : '', ...current.children.map((child) => walk(child, shown(child)))].join(' ');
  return walk(node, true);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
