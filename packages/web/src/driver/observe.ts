/**
 * Observation and location: the semantic tree assembled from each
 * document's reads with its on-site frames stitched in and placed, masked
 * pixels, and locators resolved in the page by the contract's locator rules.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  sameSite,
  type ComputedStyleProperty,
  type ComputedStyleValues,
  type EngineObserveOptions,
  type EngineSnapshot,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type SemanticNode,
  type ViewportSize,
  withTimeout,
} from '@e2e-dev/core/engine';
import { SECURE_FIELD_SELECTOR, type RawNodeData, type RawObservedNode } from '../in-page/read-node.ts';
import { abortError, isStale, releaseQuietly, unlessStale } from '../errors.ts';
import { childDocuments, inViewport, pageParts, placeInFrame, resolveFrames, scriptedContexts, splitFrames, unparsedSelector, type FramedDocument, type NodeTarget } from './frames.ts';
import { computedStyle, domReady } from '../in-page/document.ts';
import { maskSecureFields, unmaskSecureFields, type AnimationStop } from '../in-page/mask.ts';
import type { FrameBox } from '../in-page/create-readers.ts';
import type { PagePart } from '../in-page/select-chain.ts';
import type { BidiSession } from './session.ts';
import type { ElementRef } from './script.ts';

/** Shared node budget of one observation. */
const MAX_OBSERVED_NODES = 3_000;
/** Nested iframe capture depth; deeper frames stay boundary nodes. */
const MAX_FRAME_DEPTH = 4;
/** Settling is best-effort and spends from the observation's budget. */
const SETTLE_TIMEOUT_MS = 5_000;

/** One read document's tree with the element behind each of its ids. */
interface CapturedTree {
  readonly tree: SemanticNode;
  readonly generation: Map<string, NodeTarget>;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

/** Time a `pixelFallback` observation keeps for fresh masked pixels once the semantic read runs out; at most a quarter of what is left. */
const PIXEL_FALLBACK_RESERVE_MS = 2_000;

/**
 * One semantic observation, with masked pixels when asked, taken after the
 * tree so no screenshot mask is ever read into it. Pixels a capture could
 * not produce are left out, as the contract allows; the tree is never. With
 * `pixelFallback`, a semantic read that outlives its share of the budget is
 * abandoned for fresh masked pixels under the stable root alone
 * (`treeUnavailable`), and every ref is retired; the ids the abandoned read
 * was given stay reserved, so none is minted again.
 */
export async function observe(session: BidiSession, timeoutMs: number, signal: AbortSignal, options?: EngineObserveOptions): Promise<EngineSnapshot> {
  const context = session.requireContext();
  const deadline = Date.now() + timeoutMs;
  await unlessStale(session.page.run(domReady, [Math.min(SETTLE_TIMEOUT_MS, timeoutMs / 2)]), undefined);
  const viewport = await session.viewportSize();
  if (options?.pixelFallback !== true) return observeTree(session, context, viewport, deadline, signal, options);
  const semanticDeadline = deadline - Math.min(PIXEL_FALLBACK_RESERVE_MS, (deadline - Date.now()) / 4);
  const abandoned = new AbortController();
  const read = observeTree(session, context, viewport, semanticDeadline, AbortSignal.any([signal, abandoned.signal]), options);
  const timedOut = new EngineError('OPERATION_TIMEOUT', 'the semantic read timed out', { retryable: false });
  try {
    return await withTimeout(read, Math.max(0, semanticDeadline - Date.now()), () => timedOut);
  } catch (cause) {
    if (cause !== timedOut || signal.aborted) throw cause;
    abandoned.abort();
    read.catch(() => undefined);
    session.refs.clear();
    const remaining = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    const fallbackViewport = await session.viewportSize();
    const pixels = await maskedPixels(session, fallbackViewport, remaining, 'finish').catch(() => {
      throw cause;
    });
    return {
      location: await session.currentUrl(),
      root: { ref: { id: ROOT_NODE_ID, revision: '' } },
      viewport: fallbackViewport,
      truncated: true,
      treeUnavailable: true,
      pixels: pixels.pixels,
      maskedRegionCount: pixels.maskedRegionCount,
    };
  }
}

/** The tree read by `deadline` and the masked pixels after it when asked, published unless `signal` ended the read first. */
async function observeTree(
  session: BidiSession,
  context: string,
  viewport: ViewportSize,
  deadline: number,
  signal: AbortSignal,
  options: EngineObserveOptions | undefined,
): Promise<EngineSnapshot> {
  const captured = await captureTree(session, context, [], MAX_OBSERVED_NODES, deadline);
  if (signal.aborted) throw abortError(signal, 'observe');
  const pixels = options?.pixels === true ? await maskedPixels(session, viewport, signal, 'finish').then((value) => value, () => undefined) : undefined;
  if (signal.aborted) throw abortError(signal, 'observe');
  session.refs.publish(captured.generation);
  return {
    location: await session.currentUrl(),
    root: captured.tree,
    viewport,
    ...(captured.truncated ? { truncated: true } : {}),
    ...(pixels === undefined ? {} : { pixels: pixels.pixels, maskedRegionCount: pixels.maskedRegionCount }),
  };
}

/** How long the screen an action left may take for the trace before the step goes without one. */
const TRACE_SCREEN_TIMEOUT_MS = 1_000;

/**
 * Hands the trace the screen an action left, when the attempt keeps one. The
 * screen is read like an observation but never published, so every ref a
 * test or model holds stays valid. The `screen` contract has the engine give
 * up silently on a page that cannot answer within a second: the action
 * already succeeded, and a trace screen never fails it.
 */
export async function traceScreen(session: BidiSession, signal: AbortSignal): Promise<void> {
  const sink = session.attempt.screen;
  if (sink === undefined || signal.aborted || session.context === undefined) return;
  const context = session.context;
  const read = async (): Promise<EngineSnapshot> => {
    const captured = await captureTree(session, context, [], MAX_OBSERVED_NODES, Date.now() + TRACE_SCREEN_TIMEOUT_MS);
    return { location: await session.currentUrl(), root: captured.tree, viewport: await session.viewportSize(), ...(captured.truncated ? { truncated: true } : {}) };
  };
  try {
    sink(await withTimeout(read(), TRACE_SCREEN_TIMEOUT_MS, () => new Error('trace screen timed out')));
  } catch {
    return;
  }
}

/** Reads `properties` of the computed style of the element an observation's `ref` names, without input or actionability waits. */
export async function readStyle(session: BidiSession, ref: NodeRef, properties: readonly ComputedStyleProperty[]): Promise<ComputedStyleValues> {
  const target = session.refs.lookupObserved(ref);
  const style = await session.page.run(computedStyle, [target.element, [...properties]], target.context);
  if (style === null) throw new EngineError('NODE_STALE', 'node is detached; observe again before reading', { retryable: true });
  return style;
}

/**
 * Resolves one expression in the document its frame chain names, by the
 * contract's locator rules run in the page (the `locate` reader), which
 * match each element as Playwright's engines do and answer every `selector`
 * in the same call. A node inside a frame is placed in the top-level
 * viewport.
 */
export async function locate(session: BidiSession, expression: LocatorExpression): Promise<SemanticNode[]> {
  const { chain, frame, matches } = await resolveLocator(session, expression);
  // A sole match keeps its expression, so a ref that turns ambiguous before an action is stale instead of acting on one of them.
  const locator = matches.length === 1 ? { locator: expression } : {};
  return matches.map(({ node, element }) => {
    session.refs.storeLocated(node.ref.id, { element, context: frame.context, ...locator });
    return inViewport(node, frame.boxes, chain);
  });
}

/**
 * Fails as retryable `NODE_STALE` unless the expression that located
 * `target` as its only match still matches that element alone: a second
 * match, or none, means the ref no longer names one element. A target an
 * observation or a many-match locate gave passes as it is.
 */
export async function stillLocated(session: BidiSession, target: NodeTarget): Promise<void> {
  if (target.locator === undefined) return;
  const { matches } = await resolveLocator(session, target.locator);
  if (matches.length === 1 && matches[0]!.element.sharedId === target.element.sharedId) return;
  const now = matches.length === 0 ? 'nothing' : matches.length === 1 ? 'another element' : `${matches.length} elements`;
  throw new EngineError('NODE_STALE', `the located element is no longer its locator's only match: the locator now matches ${now}`, { retryable: true });
}

/** The nodes `expression` matches now, each with its element, and the document its frame chain leads to. */
async function resolveLocator(session: BidiSession, expression: LocatorExpression): Promise<{ chain: string[]; frame: FramedDocument; matches: { node: SemanticNode; element: ElementRef }[] }> {
  const { chain, inner } = splitFrames(expression);
  const options = { testIdAttribute: session.settings.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
  const frame = await resolveFrames(session, chain, options);
  const { metadata: nodes, elements } = await session.page.readEncoded('locate', [options, JSON.stringify(inner), selectorParts(inner), frame.hidden], frame.context);
  if (!Array.isArray(nodes)) throw unparsedSelector(nodes.selector, nodes.reason);
  if (nodes.length !== elements.length) {
    throw new EngineError('ENGINE_FAILURE', 'located reads do not align with their elements', { retryable: false });
  }
  const first = session.refs.reserveIds(nodes.length);
  return { chain, frame, matches: nodes.map((raw, index) => ({ node: toSemanticNode({ id: `n${first + index}`, revision: '' }, raw), element: elements[index]! })) };
}

/** Every `selector` the expression names, with the chain parts the page reads it as (`pageParts`). */
function selectorParts(expression: LocatorExpression): [string, PagePart[]][] {
  const selectors = new Map<string, PagePart[]>();
  const walk = (node: LocatorExpression): void => {
    switch (node.kind) {
      case 'selector':
        selectors.set(node.selector, pageParts(node.selector));
        return;
      case 'query':
        if (node.scope !== undefined) walk(node.scope);
        return;
      case 'filter':
        walk(node.source);
        if (node.has !== undefined) walk(node.has);
        if (node.hasNot !== undefined) walk(node.hasNot);
        return;
      case 'index':
      case 'frame':
        walk(node.source);
        return;
      case 'union':
        walk(node.left);
        walk(node.right);
    }
  };
  walk(expression);
  return [...selectors];
}

/**
 * Reads one document's tree in one call (the reader's metadata as one JSON
 * string, each walked element as its shared id, each iframe with the box
 * its document lays it out in), then each iframe on the app's site, all
 * resolved before the first is read (`childDocuments`), in order and
 * stitched under its boundary node within the node budget and the deadline.
 * An on-site frame left unread marks the tree truncated; a frame whose
 * document went away mid-read, or has none to read yet, shows nothing,
 * which is not truncation; an off-site one stays a boundary node by design.
 */
async function captureTree(session: BidiSession, context: string, framePath: readonly string[], budget: number, deadline: number): Promise<CapturedTree> {
  const { metadata: decoded, elements } = await session.page.readEncoded('tree', [
    { testIdAttribute: session.settings.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR },
    { maxNodes: budget, idSeed: session.refs.reserveIds(budget), nameLimit: OBSERVED_NAME_LIMIT, textLimit: OBSERVED_TEXT_LIMIT },
  ], context);
  const { nodes, ids, frames } = decoded;
  if (!Array.isArray(ids) || ids.length !== nodes.length || elements.length !== nodes.length || !Array.isArray(frames) || frames.some((frame) => elements[frame.node] === undefined)) {
    throw new EngineError('ENGINE_FAILURE', 'observation ids do not align with its nodes', { retryable: false });
  }
  // An empty document is what a navigation in flight looks like; a real page always has nodes, so the capture is worth repeating.
  if (nodes.length === 0) throw new EngineError('NODE_STALE', 'observation produced no nodes', { retryable: true });
  if (framePath.length === 0) ids[0] = ROOT_NODE_ID;
  const generation = new Map<string, NodeTarget>();
  elements.forEach((element, index) => generation.set(ids[index] as string, { element, context }));
  let nodeCount = nodes.length;
  let truncated = decoded.truncated;
  const frameChildren = new Map<number, FrameChild>();
  const children = await childDocuments(session.connection, context, frames.map((frame) => elements[frame.node]!), (url) => isOnSiteFrame(url, session.settings.site));
  for (const [at, { node: index, selector, box }] of frames.entries()) {
    const child = children[at];
    if (child === undefined) continue;
    const remaining = budget - nodeCount;
    if (framePath.length >= MAX_FRAME_DEPTH || remaining <= 0 || Date.now() >= deadline || box === null) {
      truncated = true;
      continue;
    }
    session.frames.enter(child, { element: elements[index]!, context });
    const captured = await unlessStale(captureTree(session, child, [...framePath, selector], remaining, deadline), undefined);
    if (captured === undefined) continue;
    for (const [id, target] of captured.generation) generation.set(id, target);
    frameChildren.set(index, { tree: captured.tree, box });
    nodeCount += captured.nodeCount;
    truncated ||= captured.truncated;
  }
  return { tree: assembleTree(nodes, ids, framePath, frameChildren), generation, nodeCount, truncated };
}

/**
 * A viewport screenshot with every secure field in every document covered,
 * the caret hidden, and animations stopped as `animations` says
 * (`maskSecureFields`): an observation's pixels show them where they come to
 * rest, so two reads of a page compare, and a screenshot kept as evidence
 * holds them where they are, so taking one changes nothing. The capture
 * fails open nowhere: a document that cannot be masked, a frame that
 * appeared or went away, a field that moved while the screenshot was taken,
 * or a capture the browser failed because its document was replaced under
 * it fails it as `NODE_STALE`, retried on a settled page, and any other
 * failure fails it outright.
 */
export async function maskedPixels(session: BidiSession, viewport: ViewportSize, signal: AbortSignal, animations: AnimationStop): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
  for (;;) {
    try {
      return await maskedCapture(session, viewport, animations);
    } catch (cause) {
      if (!isStale(cause)) throw cause;
      if (signal.aborted) throw cause;
      await sleep(RECAPTURE_MS, undefined, { signal });
    }
  }
}

/** Pause before a capture the page's navigation spoiled is taken again. */
const RECAPTURE_MS = 50;

/**
 * One masked capture; stale when a document went away under the masks, or
 * a navigation started or committed in one between masking and unmasking:
 * Firefox snapshots the document its parent process shows, which a
 * navigation can replace while scripts still run in the masked one. A frame
 * document with no script context (`hasScriptContext`) holds nothing to
 * mask; the commit that gives it content is such a navigation, and one that
 * has a script context once the masks come off makes the capture stale too.
 * A document that left under its masks took them off itself as it went
 * (`maskSecureFields`), since the unmask here reaches the one that replaced
 * it. The documents are masked together and unmasked together; when one
 * cannot be masked, every other is answered and has its mask taken off
 * before that failure, the first in document order, fails the capture.
 */
async function maskedCapture(session: BidiSession, viewport: ViewportSize, animations: AnimationStop): Promise<{ pixels: ObservationPixels; maskedRegionCount: number }> {
  const context = session.requireContext();
  const documents = await session.documentContexts(context);
  const masked: string[] = [];
  const token = randomUUID();
  let held = true;
  let navigated = false;
  const watched = new Set(documents);
  const onNavigation = (event: { context: string }): void => {
    if (watched.has(event.context)) navigated = true;
  };
  const offs = [
    session.connection.on('browsingContext.navigationStarted', onNavigation),
    session.connection.on('browsingContext.navigationCommitted', onNavigation),
  ];
  try {
    const scripted = await scriptedContexts(session.connection, documents);
    const bare = documents.filter((each) => !scripted.includes(each));
    const masks = await Promise.allSettled(scripted.map((each) => session.page.run(maskSecureFields, [SECURE_FIELD_SELECTOR, token, animations], each)));
    let count = 0;
    masks.forEach((mask, index) => {
      if (mask.status !== 'fulfilled') return;
      count += mask.value;
      masked.push(scripted[index]!);
    });
    const failed = masks.find((mask) => mask.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    // Firefox fails a capture whose document a navigation already under way replaced mid-snapshot
    // ("Unable to capture screenshot"), so a failed capture is stale when a masked document was replaced.
    const captured = await captureUnlessNavigated(session, context, documents).then((value) => value, (cause: unknown) => ({ failed: cause }));
    held = (await Promise.all(masked.map((each) => session.page.run(unmaskSecureFields, [token], each)))).every(Boolean);
    masked.length = 0;
    const [after, loaded] = await Promise.allSettled([session.documentContexts(context), scriptedContexts(session.connection, bare)]);
    if (after.status === 'rejected') throw after.reason;
    if (loaded.status === 'rejected') throw loaded.reason;
    if (!held || navigated || loaded.value.length > 0 || after.value.length !== documents.length || after.value.some((each, index) => each !== documents[index])) {
      throw new EngineError('NODE_STALE', 'the page changed while its screenshot was masked', { retryable: true, cause: 'failed' in captured ? captured.failed : undefined });
    }
    if ('failed' in captured) throw captured.failed;
    const { data } = captured;
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    const size = readPngSize(bytes) ?? viewport;
    return {
      pixels: { data: bytes, mediaType: 'image/png', width: size.width, height: size.height, scale: viewport.width > 0 ? size.width / viewport.width : 1 },
      maskedRegionCount: count,
    };
  } finally {
    for (const off of offs) off();
    await Promise.all(masked.map((each) => releaseQuietly(session.page.run(unmaskSecureFields, [token], each))));
  }
}

/**
 * How long a failed capture waits for the navigation that may have failed
 * it: the browser can answer the capture before it reports the navigation
 * that started under it.
 */
const NAVIGATION_EVENT_GRACE_MS = 250;

/**
 * Captures the tab's viewport, abandoning the capture as stale the moment a
 * document of `documents` starts navigating: the masks were drawn in the
 * document it replaces, so its pixels could show a field unmasked, and
 * Chromium may never answer a capture whose frame navigated under it. A
 * capture that fails waits `NAVIGATION_EVENT_GRACE_MS` for that navigation,
 * which makes it stale too, before its own failure stands.
 */
async function captureUnlessNavigated(session: BidiSession, context: string, documents: readonly string[]): Promise<{ data: string }> {
  const watched = new Set(documents);
  let off: () => void = () => undefined;
  const navigated = new Promise<never>((_resolve, reject) => {
    off = session.connection.on('browsingContext.navigationStarted', (event) => {
      if (watched.has(event.context)) reject(new EngineError('NODE_STALE', 'the page navigated while its screenshot was taken', { retryable: true }));
    });
  });
  const capture = session.connection.send('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } });
  try {
    return await Promise.race([capture, navigated]);
  } catch (cause) {
    if (isStale(cause)) throw cause;
    const grace = new AbortController();
    await Promise.race([navigated, sleep(NAVIGATION_EVENT_GRACE_MS, undefined, { signal: grace.signal }).catch(() => undefined)]).finally(() => grace.abort());
    throw cause;
  } finally {
    off();
    capture.catch(() => undefined);
    navigated.catch(() => undefined);
  }
}

/**
 * The id of every observation's root: the main document's element under one
 * id the engine mints, stable across observations and navigations, so the
 * harness can address the viewport (`perform(root, swipe)`) from an earlier
 * observation. Outside the `n<number>` space stamped ids and located ids share.
 */
export const ROOT_NODE_ID = 'root';

/**
 * True when a frame document is on the app's site.
 *
 * `about:blank` and `srcdoc` documents inherit their parent's origin, so they
 * are the app's own content (consent managers, editors) and always allowed; the
 * parent frame was already admitted to be captured at all.
 *
 * A `data:` document is *not* admitted, even though its bytes are written by the
 * page that embeds it. It has an opaque origin rather than an inherited one, and
 * navigation admits only http(s) and `about:blank`.
 */
function isOnSiteFrame(url: string, site: string | undefined): boolean {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return true;
  if (site === undefined) return false;
  const protocol = URL.canParse(url) ? new URL(url).protocol : undefined;
  return protocol !== 'data:' && sameSite(url, site);
}

/**
 * Rebuilds the observation tree from the depth-first node list, which holds
 * at least its root, each node with its id. Descendants always follow their
 * parent, so children are complete before a parent is built. Captured child
 * documents attach under their iframe boundary nodes.
 */
export function assembleTree(
  nodes: readonly RawObservedNode[],
  ids: readonly string[],
  framePath: readonly string[],
  frameChildren: ReadonlyMap<number, FrameChild>,
): SemanticNode {
  const childLists: SemanticNode[][] = nodes.map(() => []);
  const built: SemanticNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const raw = nodes[index]!;
    const embedded = frameChildren.get(index);
    // A child document measured its nodes against its own viewport, which
    // starts at the frame element's content box. Placed in that box and
    // clipped to it, every box in the tree is in the top-level viewport's CSS
    // pixels, the space the screenshot and a point tap share, and a child that
    // overflows its frame cannot claim a point over the page around it.
    if (embedded !== undefined) childLists[index]!.unshift(placeTree(embedded.tree, embedded.box));
    const node = toSemanticNode({ id: ids[index]!, revision: '' }, raw, childLists[index]!, framePath);
    built[index] = node;
    if (raw.parent >= 0) childLists[raw.parent]!.unshift(node);
  }
  return built[0]!;
}

/** A child document's tree, and how the document around it lays out the frame that shows it. */
interface FrameChild {
  readonly tree: SemanticNode;
  readonly box: FrameBox;
}

/** The tree a frame's document read, every box placed in the viewport of the document that holds the frame (`placeInFrame`). */
function placeTree(node: SemanticNode, frame: FrameBox): SemanticNode {
  const { rect: _rect, origin: _origin, ...rest } = node;
  return {
    ...rest,
    ...placeInFrame(node, frame),
    ...(node.children === undefined ? {} : { children: node.children.map((child) => placeTree(child, frame)) }),
  };
}

function toSemanticNode(
  ref: NodeRef,
  raw: RawNodeData,
  children: readonly SemanticNode[] = [],
  framePath: readonly string[] = [],
): SemanticNode {
  const states: Record<string, boolean> = {};
  if (raw.states.checked !== null) states['checked'] = raw.states.checked;
  if (raw.states.disabled) states['disabled'] = true;
  if (raw.states.selected !== null) states['selected'] = raw.states.selected;
  if (raw.states.expanded !== null) states['expanded'] = raw.states.expanded;
  if (raw.states.pressed !== null) states['pressed'] = raw.states.pressed;
  if (raw.states.focused) states['focused'] = true;
  if (raw.states.hidden) states['hidden'] = true;
  if (raw.states.secure) states['secure'] = true;
  return {
    ref,
    ...(raw.role !== null ? { role: raw.role } : {}),
    ...(raw.name !== null ? { name: raw.name } : {}),
    ...(raw.text !== null ? { text: raw.text } : {}),
    ...(raw.value !== null ? { value: raw.value } : {}),
    ...(raw.selection !== null ? { selection: raw.selection } : {}),
    ...(raw.testId !== null ? { testId: raw.testId } : {}),
    inputPurpose: raw.inputPurpose,
    states,
    ...(raw.level !== null ? { level: raw.level } : {}),
    attributes: raw.attributes,
    ...(raw.rect !== null ? { rect: raw.rect } : {}),
    ...(raw.origin !== null ? { origin: raw.origin } : {}),
    ...(framePath.length > 0 ? { framePath } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Reads pixel dimensions out of PNG bytes.
 *
 * The dimensions reported with a screenshot must be the dimensions of the bytes
 * the model actually receives: every coordinate it returns is relative to them,
 * so a viewport value that disagrees with the capture displaces every point
 * silently. PNG puts IHDR first, so width and height are at fixed offsets and no
 * decoder is needed.
 */
export function readPngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.byteLength < 24) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
  if (view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
