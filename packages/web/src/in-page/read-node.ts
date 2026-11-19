/**
 * The wire types of the in-page semantic reader. The reader itself lives in
 * `in-page/read-semantics.ts` and is serialized into the page.
 */

/**
 * The one definition of a secure field.
 *
 * It is a selector rather than a predicate because it has to be applied from
 * two sides that cannot share code: the in-page reader matches elements
 * against it to mark nodes `secure`, and the engine hands the same string to
 * the screenshot masker. One string means the tree's redaction and the image's
 * redaction cannot describe different sets of elements, which is what the
 * runner's pixel-clearance check relies on.
 */
export const SECURE_FIELD_SELECTOR = 'input[type="password" i]';

export interface RawNodeData {
  role: string | null;
  name: string | null;
  text: string | null;
  value: string | null;
  /** Text selected inside the focused field or editing host; null when unfocused, collapsed, or secure. */
  selection: string | null;
  inputPurpose: 'username' | 'password' | 'one-time-code' | 'generic-secret' | 'none';
  states: {
    checked: boolean | null;
    disabled: boolean;
    selected: boolean | null;
    expanded: boolean | null;
    pressed: boolean | null;
    focused: boolean;
    hidden: boolean;
    secure: boolean;
  };
  /** Heading level of a heading: `aria-level`, else the digit of `h1` through `h6`; null for anything else. */
  level: number | null;
  attributes: Record<string, string>;
  /** Value of the project's test-id attribute, when the element carries one. */
  testId: string | null;
  /** The element's box in its document's viewport; null when it lays out no box (`display: none`). */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** The element's padding-box corner in the same viewport, when a border puts it past `rect`'s; null otherwise. */
  origin: { x: number; y: number } | null;
}

/** One observed node plus its position in the flattened depth-first tree. */
export interface RawObservedNode extends RawNodeData {
  /** Index of the nearest included ancestor, or -1 for the root. */
  parent: number;
}

/** One `<iframe>` element the walk listed. */
export interface RawObservedFrame {
  /** Index of the iframe's node in `nodes`. */
  node: number;
  /** The selector that names the element in its document (`frameSelectorOf`), published as the frame's step of a `framePath`. */
  selector: string;
}

/** One walked document. */
export interface RawObservation {
  nodes: RawObservedNode[];
  /** The iframes among `nodes`, in walk order. */
  frames: RawObservedFrame[];
  /** True when the node budget stopped the walk before the document was read whole. */
  truncated: boolean;
  /** Live element handles positionally aligned with `nodes`. */
  elements: Element[];
  /**
   * Node ids positionally aligned with `nodes`. An id is stamped on the element
   * the first time an observation includes it and read back on every later
   * one, so the same element keeps the same id for as long as it lives in the
   * document: two looks at an unchanged screen name its nodes identically, and
   * an update can list exactly what changed. A re-created element (a framework
   * re-mount, a new document) is a new node and gets a fresh id.
   */
  ids: string[];
}

/** What bounds one tree walk. */
export interface TreeLimits {
  readonly maxNodes: number;
  /**
   * First numeric id available to nodes seen for the first time. The caller
   * reserves maxNodes ids before execution, so an abandoned reader cannot
   * collide with later captures or locator resolution.
   */
  readonly idSeed: number;
  /** Cuts each node's name at this length; the caller owns the contract value. */
  readonly nameLimit: number;
  /** Cuts each node's text at this length; the caller owns the contract value. */
  readonly textLimit: number;
}
