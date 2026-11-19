/**
 * Nested documents. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, and the document holding a frame reads how it lays
 * the frame out (the `frameBox` reader, and the `tree` reader for each
 * iframe it lists), so a box measured inside the child can be placed in the
 * top-level viewport the pointer and the screenshot share.
 */

import { EngineError, TestError, type LocatorExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { ChromiumCdp } from './cdp.ts';
import type { BrowserTraits } from '../browsers.ts';
import { unlessStale } from '../errors.ts';
import { compose, IDENTITY, invert, rectToQuad, scaleThenTranslate, type Point, type Projection } from './projection.ts';
import { chainParts, cssChains } from './selector-tokens.ts';
import type { FrameBox, ReadOptions, TurnedFrame } from '../in-page/create-readers.ts';
import type { PagePart } from '../in-page/select-chain.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, WindowRef, type ElementRef } from './script.ts';
import type { BidiSession } from './session.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
  /** The expression that located the element as its only match, which an action checks still matches it alone. */
  readonly locator?: LocatorExpression;
}

type Rect = NonNullable<SemanticNode['rect']>;

/** A node's box, and the point an offset into the node is measured from. */
type Box = Pick<SemanticNode, 'rect' | 'origin'>;

/** `rect` cut to `bounds`; undefined when nothing of it is inside. */
function clipTo(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * A node box a frame's document measured against its own viewport, in the
 * viewport of the document that holds the frame: `rect` scaled and shifted
 * by the frame's content box and clipped to it, and none when nothing of it
 * is inside the frame, or the frame lays out no box or is turned. `origin`
 * is scaled and shifted but never clipped, and a clip that moves the box's
 * corner keeps the unclipped corner as `origin`, so an offset into the node
 * lands where it would at the top level.
 */
export function placeInFrame(box: Box, frame: FrameBox): Box {
  if (box.rect === undefined || frame === null || 'turned' in frame) return {};
  const { content, scale } = frame;
  const at = (point: Point): Point => ({ x: content.x + point.x * scale.x, y: content.y + point.y * scale.y });
  const rect = clipTo({ ...at(box.rect), width: box.rect.width * scale.x, height: box.rect.height * scale.y }, content);
  if (rect === undefined) return {};
  const origin = at(box.origin ?? box.rect);
  return origin.x === rect.x && origin.y === rect.y ? { rect } : { rect, origin };
}

/**
 * The `>>` chain parts of `selector` as the page reads them. Only the CSS and
 * XPath engines are supported, and only the last part may capture; anything
 * else is `INVALID_LOCATOR`.
 */
export function pageParts(selector: string): PagePart[] {
  const parts = chainParts(selector);
  if (parts.slice(0, -1).some((part) => part.capture)) {
    throw new TestError('INVALID_LOCATOR', 'a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead');
  }
  return parts.map((part): PagePart => {
    if (part.engine === 'css') return { engine: 'css', body: part.body, chains: cssChains(part.body) };
    if (part.engine === 'xpath') return { engine: 'xpath', body: part.body };
    throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: the ${part.engine}= engine is not supported`);
  });
}

/** An iframe element's window, which serializes as its browsing context. Runs in the page. */
function contentWindow(element: HTMLIFrameElement): Window | null {
  return element.contentWindow;
}

/**
 * The sandbox realm the engine reads a frame's window in. Read in the page's
 * own world, `contentWindow` creates the script context of a document the
 * frame has run no script in yet, its first, empty one. Chromium keeps that
 * context for the document the frame then loads and runs no preload again,
 * so the app's init scripts never run against that document, and the
 * listeners a preload added hear none of its events. Read in a sandbox, the
 * window leaves the frame's own world alone.
 */
const FRAME_SANDBOX = 'e2e-frames';

/** The browsing context of an iframe element's window, read in the frames sandbox; undefined for a frame with no window. */
async function windowContext(connection: BidiConnection, frame: NodeTarget): Promise<string | undefined> {
  const window = await callFunction(connection, frame.context, contentWindow, [frame.element], { sandbox: FRAME_SANDBOX });
  return window instanceof WindowRef ? window.context : undefined;
}

/**
 * The child browsing context of an iframe element, or undefined when it has
 * no document to read yet: no window, or a window whose document has no
 * script context of its own (`hasScriptContext`).
 */
async function contentContext(connection: BidiConnection, frame: NodeTarget): Promise<string | undefined> {
  const child = await windowContext(connection, frame);
  return child !== undefined && (await hasScriptContext(connection, child)) ? child : undefined;
}

/**
 * The child browsing context each of `iframes` shows, in their order, for a
 * read of the document `context` shows that enters the frames `admits` lets
 * in by URL. Every frame is resolved before any is read: the windows are
 * asked at once, the URLs come from one tree of `context`, and only an
 * admitted frame is asked for its script context (`hasScriptContext`).
 * Undefined for a frame with no window, one not admitted, one with no
 * document to read yet, and one that went away meanwhile.
 */
export async function childDocuments(connection: BidiConnection, context: string, iframes: readonly ElementRef[], admits: (url: string) => boolean): Promise<(string | undefined)[]> {
  if (iframes.length === 0) return [];
  const [windows, tree] = await Promise.all([
    Promise.all(iframes.map((element) => unlessStale(windowContext(connection, { element, context }), undefined))),
    unlessStale(connection.send('browsingContext.getTree', { root: context, maxDepth: 1 }), undefined),
  ]);
  const shown = new Set(windows);
  const admitted = (tree?.contexts[0]?.children ?? []).filter((child) => shown.has(child.context) && admits(child.url)).map((child) => child.context);
  const readable = new Set(await scriptedContexts(connection, admitted));
  return windows.map((child) => (child !== undefined && readable.has(child) ? child : undefined));
}

/**
 * The script context of the document `context` shows: the default realm of
 * its window, by its id; undefined when the document has none of its own.
 * Chromium gives a frame's first, empty document none until a script reaches
 * into it or the frame's first navigation commits, and every document after
 * it one before its content. Without one, nothing was written into the
 * document, and a call into it would wait for the document the frame loads
 * next.
 */
async function scriptContext(connection: BidiConnection, context: string): Promise<string | undefined> {
  const { realms } = await connection.send('script.getRealms', { context, type: 'window' });
  return realms.find((realm) => realm.type === 'window' && realm.sandbox === undefined)?.realm;
}

/** Whether the document `context` shows has a script context of its own (`scriptContext`). */
async function hasScriptContext(connection: BidiConnection, context: string): Promise<boolean> {
  return (await scriptContext(connection, context)) !== undefined;
}

/**
 * The script context (`scriptContext`) of the document each of `contexts`
 * shows, in their order; undefined for a document that has none. A context
 * that went away since it was listed (a frame the page removed, a tab that
 * closed) has no document, so it has none either.
 */
export async function documentRealms(connection: BidiConnection, contexts: readonly string[]): Promise<(string | undefined)[]> {
  return Promise.all(contexts.map((each) => unlessStale(scriptContext(connection, each), undefined)));
}

/** Those of `contexts` whose document a call can be made into: the ones with a script context (`documentRealms`), in their order. */
export async function scriptedContexts(connection: BidiConnection, contexts: readonly string[]): Promise<string[]> {
  const realms = await documentRealms(connection, contexts);
  return contexts.filter((_each, index) => realms[index] !== undefined);
}

/** The iframe that holds each child context the surface entered, by child context. */
export class FrameRegistry {
  private readonly holders = new Map<string, NodeTarget>();

  /** `read` asks the document that holds a frame how it lays the frame out (the `frameBox` reader). */
  constructor(private readonly read: (frame: NodeTarget) => Promise<FrameBox>) {}

  /** Records that `child` is the document of `frame`. */
  enter(child: string, frame: NodeTarget): void {
    this.holders.set(child, frame);
  }

  /** The iframes from the top-level document down to `context`, outermost first; empty for the top level. */
  chain(context: string): NodeTarget[] {
    const chain: NodeTarget[] = [];
    for (let holder = this.holders.get(context); holder !== undefined; holder = this.holders.get(holder.context)) {
      chain.unshift(holder);
    }
    return chain;
  }

  /**
   * Each iframe holding `context`, outermost first, as the map from the
   * viewport of the document it shows to the viewport of its own document,
   * the documents read at once. A frame turned by a rotation or a 3D
   * transform maps through the quad the browser lays its border box out on
   * (`turnedFrameMap`). Null when a frame on the way lays out no box, or the
   * browser reports no quad for a turned one.
   */
  async frameMaps(connection: BidiConnection, context: string, traits: BrowserTraits): Promise<Projection[] | null> {
    const chain = this.chain(context);
    const boxes: NonNullable<FrameBox>[] = [];
    for (const box of await Promise.all(chain.map((frame) => this.read(frame)))) {
      if (box === null) return null;
      boxes.push(box);
    }
    const sessions = traits.cdp && boxes.some((box) => 'turned' in box) ? await Promise.all(chain.map((frame) => ChromiumCdp.forContext(connection, frame.context))) : undefined;
    const maps: Projection[] = [];
    let root: Projection = IDENTITY;
    for (const [index, box] of boxes.entries()) {
      if (index > 0) root = sessions !== undefined && sessions[index]!.session !== sessions[index - 1]!.session ? IDENTITY : compose(root, maps[index - 1]!);
      const map = 'turned' in box ? await turnedFrameMap(chain[index]!, box.turned, sessions?.[index], root) : scaleThenTranslate(box.content, box.scale);
      if (map === undefined) return null;
      maps.push(map);
    }
    return maps;
  }

  /** Forgets every frame, when the documents that held them are gone. */
  clear(): void {
    this.holders.clear();
  }
}

/** The corners of a quad, top-left first and clockwise. */
type Quad = readonly [Point, Point, Point, Point];

/**
 * The map from the viewport of the document a turned frame shows to the
 * viewport of the frame's own document: its content inset, then the quad
 * its border box lays out on. Chromium reports the quad (CDP
 * `DOM.getContentQuads`) in the viewport of the frame's local root, the
 * outermost document its process renders, which `root` maps the frame's
 * document into, for the node chromium-bidi's shared id ends in
 * (`f.<frame>.d.<document>.e.<backend node id>`); Firefox reports it in the
 * frame's document (`getBoxQuads`, behind `layout.css.getBoxQuads.enabled`).
 * Undefined when the browser reports none.
 */
async function turnedFrameMap(frame: NodeTarget, box: TurnedFrame, cdp: ChromiumCdp | undefined, root: Projection): Promise<Projection | undefined> {
  let quad = box.quad === null ? null : quadOf(box.quad);
  let toDocument: Projection | undefined = IDENTITY;
  if (cdp !== undefined) {
    const backendNodeId = Number(/\.e\.(\d+)$/.exec(frame.element.sharedId)?.[1]);
    if (!Number.isInteger(backendNodeId)) return undefined;
    const [flat] = (await cdp.send('DOM.getContentQuads', { backendNodeId })).quads;
    quad = flat === undefined ? null : quadOf([0, 2, 4, 6].map((at) => ({ x: flat[at]!, y: flat[at + 1]! })));
    toDocument = invert(root);
  }
  if (quad === null || toDocument === undefined) return undefined;
  const border = rectToQuad(box.width, box.height, quad);
  if (border === undefined) return undefined;
  return compose(toDocument, compose(border, scaleThenTranslate(box.inset, { x: 1, y: 1 })));
}

/** The quad whose corners `points` lists, top-left first and clockwise; null unless there are four. */
function quadOf(points: readonly Point[]): Quad | null {
  const [p0, p1, p2, p3] = points;
  return points.length === 4 && p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined ? [p0, p1, p2, p3] : null;
}

/** The `INVALID_LOCATOR` of a selector the page could not parse, with the page's `reason`. */
export function unparsedSelector(selector: string, reason: string): TestError {
  return new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${reason}`);
}

/** The document a frame chain leads to. */
export interface FramedDocument {
  readonly context: string;
  /** Whether a frame on the way reads as hidden, and so everything inside it. */
  readonly hidden: boolean;
  /** How each frame on the way is laid out, outermost first. */
  readonly boxes: readonly FrameBox[];
}

/**
 * The document the innermost frame of `selectors` shows, each selector
 * matched in the document of the one before it (the `selectFrame` reader):
 * `FRAME_NOT_FOUND` (retryable, a frame loads) when one matches nothing or
 * has no document yet, `FRAME_AMBIGUOUS` when one matches more than one
 * iframe. Every frame on the way is recorded in the session's registry.
 */
export async function resolveFrames(session: BidiSession, selectors: readonly string[], options: ReadOptions): Promise<FramedDocument> {
  let context = session.requireContext();
  let hidden = false;
  const boxes: FrameBox[] = [];
  for (const selector of selectors) {
    const found = await session.page.reader('selectFrame', [pageParts(selector), options], context);
    if (typeof found === 'string') throw unparsedSelector(selector, found);
    if (found.count === 0) throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    if (found.only === undefined) throw new EngineError('FRAME_AMBIGUOUS', `${found.count} frames match ${selector}`, { retryable: false });
    const frame = { element: found.only.element, context };
    const child = await contentContext(session.connection, frame);
    if (child === undefined) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no document yet`, { retryable: true });
    session.frames.enter(child, frame);
    context = child;
    hidden ||= found.only.hidden;
    boxes.push(found.only.box);
  }
  return { context, hidden, boxes };
}

/**
 * A locator expression split at its frames in one walk: the selectors of the
 * frames it descends through, outermost first, and the expression the
 * innermost frame's document answers, its `frame` steps removed. A union
 * whose branches, or a `has` or `hasNot` whose locator, names another frame
 * chain than its source is `UNSUPPORTED_CAPABILITY`.
 */
export function splitFrames(expression: LocatorExpression): { chain: string[]; inner: LocatorExpression } {
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((selector, index) => selector === b[index]);
  switch (expression.kind) {
    case 'frame': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain: [expression.selector, ...chain], inner };
    }
    case 'query': {
      if (expression.scope === undefined) return { chain: [], inner: expression };
      const { chain, inner } = splitFrames(expression.scope);
      return { chain, inner: { ...expression, scope: inner } };
    }
    case 'filter': {
      const source = splitFrames(expression.source);
      const inners: { has?: LocatorExpression; hasNot?: LocatorExpression } = {};
      for (const key of ['has', 'hasNot'] as const) {
        const filter = expression[key];
        if (filter === undefined) continue;
        const { chain, inner } = splitFrames(filter);
        if (chain.length > 0 && !same(chain, source.chain)) {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'an inner has or hasNot locator must belong to the same frame as the locator it filters', { retryable: false });
        }
        inners[key] = inner;
      }
      return { chain: source.chain, inner: { ...expression, source: source.inner, ...inners } };
    }
    case 'index': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain, inner: { ...expression, source: inner } };
    }
    case 'union': {
      const left = splitFrames(expression.left);
      const right = splitFrames(expression.right);
      if (!same(left.chain, right.chain)) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'locator.or requires both branches in the same document', { retryable: false });
      }
      return { chain: left.chain, inner: { ...expression, left: left.inner, right: right.inner } };
    }
    case 'selector':
      return { chain: [], inner: expression };
  }
}

/**
 * A node read inside a frame chain, in the top-level viewport: its box
 * placed through each frame holding it, innermost first (`placeInFrame`),
 * and its frame path set. A node of the top-level document is as it is.
 */
export function inViewport(node: SemanticNode, frames: readonly FrameBox[], framePath: readonly string[]): SemanticNode {
  if (framePath.length === 0) return node;
  const { rect: _rect, origin: _origin, ...rest } = node;
  return { ...rest, ...frames.reduceRight<Box>(placeInFrame, node), framePath };
}
