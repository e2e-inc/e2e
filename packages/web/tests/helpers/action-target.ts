/** The node an action lands on and the caller it runs for, for tests that run each case for both callers. */

import type { LocatorExpression, NodeRef } from '@e2e-dev/core/engine';
import { bySelector, type WebSession } from './web-session.ts';

/** The callers the engine acts for: a test's deterministic step, and the agent acting on what it observed. */
export const KINDS = ['test', 'agent'] as const;

/** The caller an action runs for and the node it acts on. */
export interface Target {
  readonly origin: (typeof KINDS)[number];
  readonly ref: NodeRef;
}

/** The one node `selector` (or an expression) locates in `session`'s page, acted on for `kind`. */
export async function targetOf(session: WebSession, kind: (typeof KINDS)[number], selector: string | LocatorExpression): Promise<Target> {
  const [node, ...rest] = await session.locate(typeof selector === 'string' ? bySelector(selector) : selector);
  if (node === undefined || rest.length > 0) throw new Error(`expected one node for ${JSON.stringify(selector)}`);
  return { origin: kind, ref: node.ref };
}
