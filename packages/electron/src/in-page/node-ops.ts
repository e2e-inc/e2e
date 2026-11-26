/**
 * The engine's page-side work on one node, run in its isolated world with
 * the node as its first argument. `devtools.ts` sends `nodeOp` as source text
 * (`toString()`), so it stays one self-contained function: no imports beyond
 * types, nothing referenced outside its body.
 */

/** A page-side check's answer: ok, or why the node cannot take the action yet. */
export type Readiness = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The option `selectOption` names: by label (the default), value, or position. */
export interface WantedOption {
  readonly label?: string;
  readonly value?: string;
  readonly index?: number;
}

/** Every operation `nodeOp` runs, by name. A text node acts through its element. */
export interface NodeOps {
  /** In the document. */
  checkConnected(): Readiness;
  /** In the document, visible, and enabled when `enabled` asks. */
  checkEnabled(enabled: boolean): Readiness;
  /** Whether a click at the viewport point lands on the element, a node inside it, or a label for it. */
  hitTest(x: number, y: number): Readiness;
  scrollIntoView(): void;
  /** Focuses the element; true when it holds focus after. */
  focus(): boolean;
  blur(): void;
  /** A text field or editing host that is enabled and not read-only. */
  checkEditable(): Readiness;
  /**
   * Sets the value of an input that takes no typed text, with its input and
   * change events; null when the value is to be typed instead.
   */
  setValue(value: string): Readiness | null;
  /** Focuses the element and selects its whole content; false when the app moved focus away. */
  selectContents(): boolean;
  deleteSelection(): void;
  /** A checkbox's or radio's checked state, or `aria-checked` on a role that has one; null when it has none (a toggle button's `aria-pressed` is not a checked state, as on the web). */
  readChecked(): boolean | null;
  /** A `<select>` that is enabled and holds the option, enabled. */
  checkSelect(wanted: WantedOption): Readiness;
  selectOption(wanted: WantedOption): Readiness;
  /** An enabled file input. */
  checkFileInput(): Readiness;
  /** Whether the file input takes `count` files: more than one needs `multiple`. */
  takesFiles(count: number): Readiness;
  /** Empties a file input, with its input and change events. */
  clearFiles(): void;
  /** A native radio, or an element with a radio role. */
  isRadio(): boolean;
  /** The focused element under the node, a document or shadow root, through every open shadow root; it stops at a closed root's host. */
  activeUnder(): Element | null;
  /** Whether the node, the focused element, takes typed text, or typed keys as a widget's typeahead. */
  takesText(): boolean;
}

/** Runs one of `NodeOps` on `node`. */
export function nodeOp<K extends keyof NodeOps>(node: Node, name: K, args: Parameters<NodeOps[K]>): ReturnType<NodeOps[K]> {
  const element = node instanceof Element ? node : node.parentElement;
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'password', 'email', 'search', 'tel', 'url', 'number']);
  /** Input types whose value is set rather than typed. */
  const SET_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  /** Roles whose `aria-checked` is a checked state, as the web reads them. */
  const CHECKED_ROLES = new Set(['checkbox', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'switch', 'treeitem']);
  /** Widgets that take typed keys as typeahead: a key moves to the item it starts. */
  const TYPEAHEAD_ROLES = new Set(['listbox', 'option', 'tree', 'treeitem', 'menu', 'menubar', 'menuitem', 'combobox', 'grid', 'gridcell', 'radiogroup', 'tablist', 'tab']);
  /** Of those, the ones that also take typed text: digits a key at a time. */
  const TYPED_PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
  /** A node the document dropped fails as one: the harness locates it again, where a reason would only wait out the deadline. */
  const gone = (): never => {
    throw new Error('Node is detached: it is no longer in the document');
  };

  const attached = (): Element => {
    if (element === null) throw new Error('Node is detached');
    return element;
  };
  /** An input's type as the browser reads it (an unknown type is `text`); another element's type attribute. */
  const typeOf = (target: Element): string => (target instanceof HTMLInputElement ? target.type : (target.getAttribute('type') ?? '').toLowerCase());
  /**
   * Whether the element is disabled, as Chromium's tree and Playwright read
   * it: its nearest form control's :disabled (a disabled fieldset disables its
   * controls, not a link in it), or the nearest aria-disabled attribute above
   * it saying true (a nearer aria-disabled="false" enables it again).
   */
  const isDisabled = (target: Element): boolean => {
    const control = target.closest('button, input, select, textarea, option, optgroup');
    if (control?.matches(':disabled') === true) return true;
    return target.closest('[aria-disabled]')?.getAttribute('aria-disabled')?.toLowerCase() === 'true';
  };
  /** Whether the element holds focus within its own document or shadow root. */
  const holdsFocus = (target: Element): boolean => {
    const root = target.getRootNode();
    return (root instanceof Document || root instanceof ShadowRoot) && root.activeElement === target;
  };
  /**
   * The index of the option `wanted` names, or a reason it cannot be chosen. A
   * label matches an option's label, which is its text unless it has a label
   * attribute: then its text never matches, as on the web.
   */
  const findOption = (select: HTMLSelectElement, wanted: WantedOption): { readonly index: number } | Readiness => {
    const options = [...select.options];
    const byLabel = options.findIndex((option) => option.label === wanted.label);
    let index: number;
    if (wanted.index !== undefined) index = wanted.index >= 0 && wanted.index < options.length ? wanted.index : -1;
    else if (wanted.value !== undefined) index = options.findIndex((option) => option.value === wanted.value);
    else index = byLabel >= 0 ? byLabel : options.findIndex((option) => !option.hasAttribute('label') && option.text.trim() === wanted.label);
    const option = options[index];
    if (option === undefined) return { ok: false, reason: `no option matches ${JSON.stringify(wanted)}; the options are ${options.map((each) => JSON.stringify(each.label)).join(', ')}` };
    // :disabled covers an option a disabled group holds.
    if (option.matches(':disabled')) return { ok: false, reason: `option ${JSON.stringify(option.label)} is disabled` };
    return { index };
  };
  const fire = (target: Element): void => {
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const ops: NodeOps = {
    checkConnected() {
      return element?.isConnected === true ? { ok: true } : gone();
    },
    checkEnabled(enabled) {
      if (element?.isConnected !== true) return gone();
      if (enabled && isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (element.closest('[inert]') !== null) return { ok: false, reason: 'it is inert (a modal or the app blocks it)' };
      if (getComputedStyle(element).visibility !== 'visible') return { ok: false, reason: 'it is not visible' };
      return { ok: true };
    },
    hitTest(x, y) {
      if (element?.isConnected !== true) return gone();
      const root = element.getRootNode();
      const hit = (root instanceof ShadowRoot ? root : document).elementFromPoint(x, y);
      if (hit === null) return { ok: false, reason: 'its centre is outside the window' };
      // Walk up from the hit through slots, parents, and shadow hosts: Node.contains stops at a slot and a shadow root.
      for (let at: Node | null = hit; at !== null; at = at instanceof Element && at.assignedSlot !== null ? at.assignedSlot : (at.parentNode ?? (at instanceof ShadowRoot ? at.host : null))) {
        if (at === element) return { ok: true };
      }
      if (hit instanceof HTMLLabelElement && (hit.control === element || hit.contains(element))) return { ok: true };
      return { ok: false, reason: `another element (${hit.tagName.toLowerCase()}${hit.id === '' ? '' : `#${hit.id}`}) would receive the click` };
    },
    scrollIntoView() {
      element?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    },
    focus() {
      const target = attached();
      if (target instanceof HTMLElement || target instanceof SVGElement) target.focus();
      return holdsFocus(target);
    },
    blur() {
      const target = attached();
      if (target instanceof HTMLElement || target instanceof SVGElement) target.blur();
    },
    checkEditable() {
      if (element?.isConnected !== true) return gone();
      const type = typeOf(element);
      const field = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && (TEXT_INPUT_TYPES.has(type) || SET_VALUE_TYPES.has(type))) ? element : undefined;
      if (field === undefined && !(element instanceof HTMLElement && element.isContentEditable)) return { ok: false, reason: 'it is not a text field' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (element.closest('[inert]') !== null) return { ok: false, reason: 'it is inert (a modal or the app blocks it)' };
      if (field?.readOnly === true) return { ok: false, reason: 'it is read-only' };
      return { ok: true };
    },
    setValue(value) {
      if (!(element instanceof HTMLInputElement)) return null;
      const type = typeOf(element);
      const refused: Readiness = { ok: false, reason: `the ${type} input does not take ${JSON.stringify(value)}` };
      if (type === 'number' && value.trim() !== '' && Number.isNaN(Number(value))) return refused;
      if (!SET_VALUE_TYPES.has(type)) return null;
      // As Playwright's fill: the value trimmed, a color in the lower case the input keeps, a range clamped by the input.
      const set = type === 'color' ? value.trim().toLowerCase() : value.trim();
      if (type !== 'range') {
        // Tried on a detached input of the same type first: the field would sanitize a malformed value to "" and lose what it held.
        const probe = element.ownerDocument.createElement('input');
        probe.type = type;
        probe.value = set;
        if (probe.value !== set) return refused;
      }
      element.focus();
      element.value = set;
      fire(element);
      return { ok: true };
    },
    selectContents() {
      const target = attached();
      if (target instanceof HTMLElement) target.focus();
      if (!holdsFocus(target)) return false;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select();
        return true;
      }
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      const selection = target.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    },
    deleteSelection() {
      attached().ownerDocument.execCommand('delete');
    },
    readChecked() {
      const target = attached();
      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) return target.checked;
      if (!CHECKED_ROLES.has(target.getAttribute('role') ?? '')) return null;
      const aria = target.getAttribute('aria-checked');
      // A mixed checkbox is not checked: check() clicks it.
      return aria === 'true' ? true : aria === 'false' || aria === 'mixed' ? false : null;
    },
    checkSelect(wanted) {
      if (element?.isConnected !== true) return gone();
      if (!(element instanceof HTMLSelectElement)) return { ok: false, reason: 'it is not a <select>' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (!element.checkVisibility({ visibilityProperty: true })) return { ok: false, reason: 'it is not visible' };
      const found = findOption(element, wanted);
      return 'index' in found ? { ok: true } : found;
    },
    selectOption(wanted) {
      if (!(element instanceof HTMLSelectElement)) return { ok: false, reason: 'it is not a <select>' };
      const found = findOption(element, wanted);
      if (!('index' in found)) return found;
      element.focus();
      element.selectedIndex = found.index;
      fire(element);
      return { ok: true };
    },
    checkFileInput() {
      if (element?.isConnected !== true) return gone();
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') return { ok: false, reason: 'it is not a file input' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      return { ok: true };
    },
    takesFiles(count) {
      const input = attached();
      if (count > 1 && input instanceof HTMLInputElement && !input.multiple) return { ok: false, reason: `the file input takes one file, not ${count}: it has no multiple attribute` };
      return { ok: true };
    },
    clearFiles() {
      const input = attached();
      if (!(input instanceof HTMLInputElement) || input.files === null || input.files.length === 0) return;
      input.value = '';
      fire(input);
    },
    isRadio() {
      const target = attached();
      return (target instanceof HTMLInputElement && target.type === 'radio') || ['radio', 'menuitemradio'].includes(target.getAttribute('role') ?? '');
    },
    activeUnder() {
      let active = node instanceof Document || node instanceof ShadowRoot ? node.activeElement : null;
      while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
      return active;
    },
    takesText() {
      const active = attached();
      if (active.tagName === 'IFRAME' || active.tagName === 'WEBVIEW') return true;
      if (active instanceof HTMLElement && active.isContentEditable) return true;
      if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled;
      if (TYPEAHEAD_ROLES.has(active.getAttribute('role') ?? '')) return true;
      // A date or time input takes typed digits; a range or color picker takes none.
      if (active instanceof HTMLInputElement) return (TEXT_INPUT_TYPES.has(typeOf(active)) || TYPED_PICKER_TYPES.has(typeOf(active))) && !active.readOnly && !active.disabled;
      return false;
    },
  };
  // TypeScript cannot tie `args` to the method `name` picks; `NodeOps` holds the two together for callers.
  const run = ops[name] as (...values: Parameters<NodeOps[K]>) => ReturnType<NodeOps[K]>;
  return run.apply(ops, args);
}

/**
 * The backend-resolvable elements a CSS selector matches in the document and
 * in each open shadow root, one root at a time as `querySelectorAll` does. It
 * never enters a frame. Sent as source text: self-contained.
 */
export function queryAll(selector: string): Element[] {
  const found: Element[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) visit(element.shadowRoot);
  };
  visit(document);
  return found;
}

/** Resolves after the next frame renders, or at once in a hidden window, which renders none. Sent as source text: self-contained. */
export function nextFrame(): Promise<void> {
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** The window's inner size in CSS pixels. Sent as source text: self-contained. */
export function viewportSize(): { readonly width: number; readonly height: number } {
  return { width: innerWidth, height: innerHeight };
}
