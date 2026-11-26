/**
 * The DevTools protocol, per window: one `CDPSession` each, the engine's
 * isolated world in its main frame, and the calls that run `in-page/`
 * functions there.
 */

import type { CDPSession, Page } from 'playwright-core';
import { TestError } from '@e2e-dev/core/engine';
import { stale } from './errors.ts';
import { nodeOp, queryAll, type NodeOps } from './in-page/node-ops.ts';
import type { SnapshotDocument } from './tree.ts';

/** The isolated world the engine's own page-side reads run in, apart from the app's globals. */
const WORLD_NAME = '__e2e_electron__';

const NODE_OP = nodeOp.toString();

let objectGroups = 0;

/** A DevTools object group of one call's own: releasing it frees that call's handles and never another's still in use. */
function objectGroup(): string {
  objectGroups += 1;
  return `${WORLD_NAME}${objectGroups}`;
}

/** One DOM snapshot of a window's main document, with the string table its indexes point into. */
export interface DocumentSnapshot {
  readonly document: SnapshotDocument;
  readonly strings: readonly string[];
}

export class DevTools {
  private readonly sessions = new WeakMap<Page, Promise<CDPSession>>();
  private readonly worlds = new WeakMap<Page, Promise<number>>();

  session(page: Page): Promise<CDPSession> {
    let session = this.sessions.get(page);
    if (session === undefined) {
      session = page.context().newCDPSession(page);
      this.sessions.set(page, session);
      session.catch(() => this.sessions.delete(page));
    }
    return session;
  }

  /** Drops the window's isolated world: its document navigated, and the next call makes one in the new document. */
  forgetWorld(page: Page): void {
    this.worlds.delete(page);
  }

  /** Drops the window's session and world: its renderer crashed, and a call pending on them would never settle. */
  forget(page: Page): void {
    this.sessions.delete(page);
    this.worlds.delete(page);
  }

  /** The execution context of the engine's isolated world in the window's main frame, made once per document. */
  private world(page: Page): Promise<number> {
    let world = this.worlds.get(page);
    if (world === undefined) {
      world = (async () => {
        const session = await this.session(page);
        const { frameTree } = await session.send('Page.getFrameTree');
        const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false });
        return executionContextId;
      })();
      this.worlds.set(page, world);
      world.catch(() => this.worlds.delete(page));
    }
    return world;
  }

  /**
   * Runs one of `NodeOps` on a node in the isolated world. The node is
   * resolved fresh from its backend id, so a node the document dropped fails
   * as stale.
   */
  async callOn<K extends keyof NodeOps>(page: Page, backendNodeId: number, name: K, ...args: Parameters<NodeOps[K]>): Promise<ReturnType<NodeOps[K]>> {
    const session = await this.session(page);
    const executionContextId = await this.world(page);
    const group = objectGroup();
    const { object } = await session.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: group });
    if (object.objectId === undefined) throw stale(`node ${backendNodeId} is no longer in the window`);
    try {
      const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: NODE_OP,
        arguments: [{ objectId: object.objectId }, { value: name }, { value: args }],
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  }

  /** Calls a self-contained page function in the isolated world with JSON arguments and returns its JSON result. */
  async evaluate<A extends readonly unknown[], R>(page: Page, fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R> {
    const session = await this.session(page);
    const contextId = await this.world(page);
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /**
   * Whether the element with keyboard focus takes typed text. Page script
   * stops at the host of a closed shadow root; the DevTools protocol reaches
   * into one, so the walk goes on inside until it finds the focused element.
   */
  async focusedTakesText(page: Page): Promise<boolean> {
    const session = await this.session(page);
    const executionContextId = await this.world(page);
    const group = objectGroup();
    const call = async (objectId: string, name: 'activeUnder' | 'takesText', returnByValue: boolean) =>
      (await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: NODE_OP, arguments: [{ objectId }, { value: name }, { value: [] }], objectGroup: group, returnByValue })).result;
    try {
      const { result: document } = await session.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId, objectGroup: group });
      if (document.objectId === undefined) return false;
      const first = await call(document.objectId, 'activeUnder', false);
      if (first.objectId === undefined) return false;
      let active = first.objectId;
      for (;;) {
        const { node } = await session.send('DOM.describeNode', { objectId: active, depth: 1, pierce: true });
        const closed = node.shadowRoots?.find((root) => root.shadowRootType === 'closed');
        if (closed === undefined) break;
        const { object: root } = await session.send('DOM.resolveNode', { backendNodeId: closed.backendNodeId, executionContextId, objectGroup: group });
        if (root.objectId === undefined) break;
        const inner = await call(root.objectId, 'activeUnder', false);
        // Nothing focused inside: the host itself has focus.
        if (inner.objectId === undefined) break;
        active = inner.objectId;
      }
      return (await call(active, 'takesText', true)).value === true;
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  }

  /**
   * The backend ids of the elements a CSS selector matches in the window's
   * document and in each open shadow root (`queryAll`), run in the isolated
   * world.
   */
  async querySelectorAll(page: Page, selector: string): Promise<ReadonlySet<number>> {
    const session = await this.session(page);
    const contextId = await this.world(page);
    const group = objectGroup();
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: `(${queryAll.toString()})(${JSON.stringify(selector)})`,
      contextId,
      objectGroup: group,
    });
    try {
      if (exceptionDetails !== undefined) {
        const reason = (exceptionDetails.exception?.description ?? exceptionDetails.text).split('\n')[0];
        throw new TestError('INVALID_LOCATOR', `${JSON.stringify(selector)} is not a CSS selector: ${reason}`);
      }
      if (result.objectId === undefined) return new Set();
      const { result: entries } = await session.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
      // One round trip per match, sent together: a broad selector on a long list is read on every poll of an expect.
      const described = await Promise.all(
        entries.flatMap((entry) => (/^\d+$/.test(entry.name) && entry.value?.objectId !== undefined ? [session.send('DOM.describeNode', { objectId: entry.value.objectId })] : [])),
      );
      return new Set(described.map(({ node }) => node.backendNodeId));
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  }

  /** One DOM snapshot of the window's main document; undefined while it has none. */
  async snapshot(page: Page): Promise<DocumentSnapshot | undefined> {
    const session = await this.session(page);
    const snapshot = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    const document = snapshot.documents[0];
    return document === undefined ? undefined : { document, strings: snapshot.strings };
  }
}
