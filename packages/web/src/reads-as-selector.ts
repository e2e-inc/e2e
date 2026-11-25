/**
 * The selector engine that keeps a role query's matches to the ones the
 * reader agrees with. Playwright's `getByRole` and the reader, which follows
 * Chrome, can disagree on a landmark's scope and on a `disabled` state, such as
 * an element's own `aria-disabled` on a role Playwright skips;
 * appended to the query (`<query> >> e2e-reads-as=<json>`), it makes a locator
 * find what its matchers then read.
 */

import { readSemanticsFunction } from './in-page/read-semantics.ts';

/** Playwright selector engine name; `e2e-reads-as=<json>` keeps the matches that read as the body says. */
export const READS_AS_SELECTOR_ENGINE = 'e2e-reads-as';

/** What a match must read as, and the reader's options. */
interface ReadsAsSelectorBody {
  readonly role?: string;
  readonly disabled?: boolean;
  readonly testIdAttribute: string;
  readonly secureFieldSelector: string;
}

/** The selector step for one role query; the body is JSON, kept whole by Playwright's selector parser. */
export function readsAsSelector(body: ReadsAsSelectorBody): string {
  return `${READS_AS_SELECTOR_ENGINE}=${JSON.stringify(body)}`;
}

/**
 * The engine behind `e2e-reads-as=<json>`: each query root is a match of the
 * query before it, kept when the reader agrees, so the query's matches keep
 * their order. Each state is read alone, so a name the reader cannot compute
 * does not cost the answer, and an editing host keeps its tag's role. A read
 * that throws keeps the match: a scope, `has`, or `nth` reads nodes the final
 * `e2e-read` step never reaches, so throwing would fail a query main answers.
 */
export const READS_AS_SELECTOR_ENGINE_SOURCE = `() => {
  const read = (${readSemanticsFunction.toString()});
  // From the prototype chain, since a form's field named \`nodeType\` replaces it on the form.
  const { getPrototypeOf, getOwnPropertyDescriptor } = ({}).constructor;
  const nodeTypeOf = (node) => {
    for (let proto = getPrototypeOf(node); proto !== null; proto = getPrototypeOf(proto)) {
      const descriptor = getOwnPropertyDescriptor(proto, 'nodeType');
      if (descriptor !== undefined && descriptor.get !== undefined) return descriptor.get.call(node);
    }
    return node.nodeType;
  };
  const queryAll = (root, selector) => {
    if (nodeTypeOf(root) !== 1) return [];
    const body = JSON.parse(selector);
    const reader = { testIdAttribute: body.testIdAttribute, secureFieldSelector: body.secureFieldSelector };
    const reads = (kind, expected) => {
      try {
        return read(root, { ...reader, mode: { kind } }) === expected;
      } catch {
        return true;
      }
    };
    if (body.role !== undefined && !reads('ariaRole', body.role)) return [];
    if (body.disabled !== undefined && !reads('disabled', body.disabled)) return [];
    return [root];
  };
  return { queryAll, query: (root, selector) => queryAll(root, selector)[0] ?? null };
}`;
