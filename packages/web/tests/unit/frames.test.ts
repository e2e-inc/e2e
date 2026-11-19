/**
 * Nested documents on the BiDi driver: the frame chain a locate resolves,
 * the expression a frame's document answers, and boxes placed in the
 * top-level viewport.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from '@e2e-dev/core/engine';
import { childDocuments, FrameRegistry, inViewport, pageParts, resolveFrames, scriptedContexts, splitFrames, placeInFrame } from '../../src/driver/frames.ts';
import { project, type Projection } from '../../src/driver/projection.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import type { FrameBox } from '../../src/in-page/create-readers.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';
import { unopened } from '../helpers/session-fake.ts';
import { ElementRef } from '../../src/driver/script.ts';

/** An exact string pattern. */
const text = (value: string) => ({ kind: 'string' as const, value, exact: true });
const note: LocatorExpression = { kind: 'query', query: { kind: 'label', value: text('Note') } };

const OPTIONS = { testIdAttribute: 'data-testid', secureFieldSelector: 'input' };

/** A number as BiDi serializes it. */
const number = (value: number) => ({ type: 'number', value });

/** A box of numbers as BiDi serializes it. */
const numbers = (values: Record<string, number>) => ({ type: 'object', value: Object.entries(values).map(([key, value]) => [key, number(value)]) });

/** One iframe a document holds: its element, its window when it has one, whether it is hidden, and whether its document has no script context of its own yet. */
interface ScriptedFrame {
  readonly element: string;
  readonly window?: string;
  readonly hidden?: boolean;
  readonly bare?: boolean;
}

/**
 * A session whose tab is `top`, on a peer that scripts the frame lookup per
 * context (the iframes it matches and, for exactly one, the element, whether
 * it is hidden, and a 100 by 100 content box at (10, 20)), each iframe's
 * `contentWindow`, which it answers in a sandbox realm alone, and the realms
 * of each window: its own, or for a bare document only the sandbox's.
 */
async function frames(iframes: Record<string, ScriptedFrame[]>): Promise<{ fake: FakeBidi; session: BidiSession }> {
  const bare = new Set(Object.values(iframes).flat().filter((frame) => frame.bare === true).map((frame) => frame.window));
  const fake = new FakeBidi().on('script.callFunction', (params) => {
    const target = params['target'] as { context: string; sandbox?: string };
    const found = iframes[target.context] ?? [];
    const [element] = params['arguments'] as { sharedId?: string }[];
    if (element?.sharedId !== undefined) {
      const window = target.sandbox === undefined ? undefined : found.find((frame) => frame.element === element.sharedId)?.window;
      return { result: { type: 'success', realm: 'r', result: window === undefined ? { type: 'null' } : { type: 'window', value: { context: window } } } };
    }
    const [only] = found;
    const value: unknown[] = [['count', number(found.length)]];
    if (only !== undefined && found.length === 1) {
      value.push(['only', { type: 'object', value: [
        ['element', { type: 'node', sharedId: only.element }],
        ['hidden', { type: 'boolean', value: only.hidden === true }],
        ['box', { type: 'object', value: [['content', numbers({ x: 10, y: 20, width: 100, height: 100 })], ['scale', numbers({ x: 1, y: 1 })]] }],
      ] }]);
    }
    return { result: { type: 'success', realm: 'r', result: { type: 'object', value } } };
  });
  fake
    .on('script.getRealms', (params) => {
      const context = String(params['context']);
      return { result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context, ...(bare.has(context) ? { sandbox: 'e2e-frames' } : {}) }] } };
    })
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.create', { result: { context: 'top' } });
  const session = unopened(fake, 'chromium', 'fresh', { settings: { viewport: null } });
  await session.openUserContext(new AbortController().signal);
  await session.ensureContext();
  return { fake, session };
}

describe('resolveFrames', () => {
  it('walks each selector into the document of the frame before it and records the chain', async () => {
    const { fake, session } = await frames({ top: [{ element: 'outer', window: 'outer-doc' }], 'outer-doc': [{ element: 'inner', window: 'inner-doc' }] });
    const step = { content: { x: 10, y: 20, width: 100, height: 100 }, scale: { x: 1, y: 1 } };
    await expect(resolveFrames(session, ['#outer', '#inner'], OPTIONS)).resolves.toEqual({ context: 'inner-doc', hidden: false, boxes: [step, step] });
    expect(session.frames.chain('inner-doc')).toEqual([
      { element: new ElementRef('outer'), context: 'top' },
      { element: new ElementRef('inner'), context: 'outer-doc' },
    ]);
    expect(session.frames.chain('top')).toEqual([]);
    expect(fake.commands('script.callFunction')).toHaveLength(4);
  });

  it('reads a document as hidden when a frame on the way is', async () => {
    const { session } = await frames({ top: [{ element: 'outer', window: 'outer-doc', hidden: true }], 'outer-doc': [{ element: 'inner', window: 'inner-doc' }] });
    await expect(resolveFrames(session, ['#outer', '#inner'], OPTIONS)).resolves.toMatchObject({ context: 'inner-doc', hidden: true });
    await expect(resolveFrames(session, [], OPTIONS)).resolves.toEqual({ context: 'top', hidden: false, boxes: [] });
  });

  it('is retryable FRAME_NOT_FOUND for no match or no document and FRAME_AMBIGUOUS for two', async () => {
    await expect(resolveFrames((await frames({})).session, ['#editor'], OPTIONS)).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', retryable: true });
    await expect(resolveFrames((await frames({ top: [{ element: 'a' }] })).session, ['#editor'], OPTIONS)).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', retryable: true });
    const unloaded = await frames({ top: [{ element: 'a', window: 'a-doc', bare: true }] });
    await expect(resolveFrames(unloaded.session, ['#editor'], OPTIONS)).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', message: 'frame #editor has no document yet', retryable: true });
    expect(unloaded.session.frames.chain('a-doc')).toEqual([]);
    await expect(resolveFrames((await frames({ top: [{ element: 'a' }, { element: 'b' }] })).session, ['iframe'], OPTIONS)).rejects.toMatchObject({ code: 'FRAME_AMBIGUOUS' });
  });
});

/** One iframe of the document `top`: its window's context, the URL the tree lists it under, its realms, and where the peer answers that it is gone. */
interface ChildFrame {
  readonly window?: string;
  readonly url?: string;
  readonly bare?: boolean;
  readonly gone?: 'window' | 'realms';
}

/** A peer whose document `top` holds `iframes` by element id, and the documents `childDocuments` reads for them, admitting `http://app.test`. */
async function children(iframes: Record<string, ChildFrame>): Promise<{ fake: FakeBidi; documents: (string | undefined)[] }> {
  const byWindow = new Map(Object.values(iframes).map((frame) => [frame.window, frame]));
  const fake = new FakeBidi()
    .on('script.callFunction', (params) => {
      const [element] = params['arguments'] as { sharedId: string }[];
      const frame = iframes[element!.sharedId]!;
      if (frame.gone === 'window') return { error: 'no such node' };
      return { result: { type: 'success', realm: 'r', result: frame.window === undefined ? { type: 'null' } : { type: 'window', value: { context: frame.window } } } };
    })
    .on('browsingContext.getTree', () => ({
      result: { contexts: [{ context: 'top', url: 'http://app.test/', children: Object.values(iframes).flatMap((frame) => (frame.url === undefined ? [] : [{ context: frame.window, url: frame.url, children: null }])) }] },
    }))
    .on('script.getRealms', (params) => {
      const frame = byWindow.get(String(params['context']))!;
      if (frame.gone === 'realms') return { error: 'no such frame' };
      return { result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context: frame.window, ...(frame.bare === true ? { sandbox: 'e2e-frames' } : {}) }] } };
    });
  const documents = await childDocuments(fake.connection, 'top', Object.keys(iframes).map((id) => new ElementRef(id)), (url) => new URL(url).origin === 'http://app.test');
  return { fake, documents };
}

describe('childDocuments', () => {
  it('asks nothing about a document with no iframes', async () => {
    const { fake, documents } = await children({});
    expect(documents).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it('asks every window in the frames sandbox, one tree, and a script context of the admitted frames alone', async () => {
    const { fake, documents } = await children({
      app: { window: 'app-doc', url: 'http://app.test/a' },
      ad: { window: 'ad-doc', url: 'http://ads.test/' },
      empty: { window: 'empty-doc', url: 'http://app.test/e', bare: true },
      windowless: {},
    });
    expect(documents).toEqual(['app-doc', undefined, undefined, undefined]);
    expect(fake.commands('script.callFunction').map((command) => command.params['target'])).toEqual(Array.from({ length: 4 }, () => ({ context: 'top', sandbox: 'e2e-frames' })));
    expect(fake.commands('browsingContext.getTree').map((command) => command.params)).toEqual([{ root: 'top', maxDepth: 1 }]);
    expect(fake.commands('script.getRealms').map((command) => command.params['context'])).toEqual(['app-doc', 'empty-doc']);
  });

  it('leaves out only the frame that went away, whichever answer says so', async () => {
    const { fake, documents } = await children({
      detached: { gone: 'window' },
      first: { window: 'first-doc', url: 'http://app.test/1' },
      unlisted: { window: 'unlisted-doc' },
      closed: { window: 'closed-doc', url: 'http://app.test/c', gone: 'realms' },
      last: { window: 'last-doc', url: 'http://app.test/2' },
    });
    expect(documents).toEqual([undefined, 'first-doc', undefined, undefined, 'last-doc']);
    expect(fake.commands('script.getRealms').map((command) => command.params['context'])).toEqual(['first-doc', 'closed-doc', 'last-doc']);
  });

  it('reads no frame of a document that went away before its tree was read', async () => {
    const fake = new FakeBidi()
      .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'window', value: { context: 'child' } } } })
      .on('browsingContext.getTree', { error: 'no such frame' });
    await expect(childDocuments(fake.connection, 'top', [new ElementRef('frame')], () => true)).resolves.toEqual([undefined]);
    expect(fake.commands('script.getRealms')).toEqual([]);
  });

  it('fails on an answer that is no gone frame', async () => {
    const fake = new FakeBidi().on('script.callFunction', { error: 'unknown error', message: 'renderer crashed' });
    await expect(childDocuments(fake.connection, 'top', [new ElementRef('frame')], () => true)).rejects.toThrow('renderer crashed');
  });
});

describe('scriptedContexts', () => {
  /** A peer that answers the realms of each context as `answers` has them: its own window realm, a sandbox realm alone, or an error. */
  function realmsOf(answers: Record<string, 'own' | 'sandbox' | { readonly error: string; readonly message?: string }>): FakeBidi {
    return new FakeBidi().on('script.getRealms', (params) => {
      const context = String(params['context']);
      const answer = answers[context]!;
      if (typeof answer === 'object') return answer;
      return { result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context, ...(answer === 'sandbox' ? { sandbox: 'e2e-frames' } : {}) }] } };
    });
  }

  it('lists the contexts that take a call, in their order, without one that has no script context of its own', async () => {
    const fake = realmsOf({ top: 'own', empty: 'sandbox', frame: 'own' });
    await expect(scriptedContexts(fake.connection, ['top', 'empty', 'frame'])).resolves.toEqual(['top', 'frame']);
  });

  it('leaves out a context that went away since it was listed, as the browser answers for a frame the page removed', async () => {
    const fake = realmsOf({ top: 'own', removed: { error: 'no such frame', message: 'Context removed not found' }, frame: 'own' });
    await expect(scriptedContexts(fake.connection, ['top', 'removed', 'frame'])).resolves.toEqual(['top', 'frame']);
  });

  it('fails on an answer that is no gone context', async () => {
    const fake = realmsOf({ top: 'own', frame: { error: 'unknown error', message: 'renderer crashed' } });
    await expect(scriptedContexts(fake.connection, ['top', 'frame'])).rejects.toThrow('renderer crashed');
  });
});

/** A registry holding `inner-doc` in `inner`, held by `outer` in the top document, whose documents read each frame's box as `boxes` has it by shared id. */
function nested(boxes: Record<string, FrameBox>, ids: { outer: string; inner: string } = { outer: 'outer', inner: 'inner' }): FrameRegistry {
  const registry = new FrameRegistry((frame) => Promise.resolve(boxes[frame.element.sharedId]!));
  registry.enter('outer-doc', { element: new ElementRef(ids.outer), context: 'top' });
  registry.enter('inner-doc', { element: new ElementRef(ids.inner), context: 'outer-doc' });
  return registry;
}

/** The corners of the axis-aligned quad at `x`, `y` sized `width` by `height`, flattened as CDP's `DOM.getContentQuads` reports them. */
function flatQuad(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

/** A frame turned in a 100 by 100 border box with no inset, whose quad only CDP reports. */
const TURNED: FrameBox = { turned: { width: 100, height: 100, inset: { x: 0, y: 0, width: 100, height: 100 }, quad: null } };

/** A Chromium peer where CDP places `outer` at (100, 50) and `inner` at `innerQuad`, and `sessions` names each document's CDP session. */
function turnedChromium(innerQuad: number[], sessions: Record<string, string>): FakeBidi {
  return new FakeBidi()
    .on('goog:cdp.getSession', (params) => ({ result: { session: sessions[String(params['context'])] } }))
    .on('goog:cdp.sendCommand', (params) => {
      const { backendNodeId } = params['params'] as { backendNodeId: number };
      return { result: { result: { quads: [backendNodeId === 11 ? flatQuad(100, 50, 100, 100) : innerQuad] }, session: params['session'] } };
    });
}

/** `nested()` with both frames turned, and element ids that carry CDP backend node ids, as chromium-bidi mints them. */
function nestedChromium(): FrameRegistry {
  return nested({ 'f.A.d.B.e.11': TURNED, 'f.C.d.D.e.22': TURNED }, { outer: 'f.A.d.B.e.11', inner: 'f.C.d.D.e.22' });
}

/** Where `maps`, innermost last, take `point` in the top-level viewport. */
function toTop(maps: readonly Projection[], point: { x: number; y: number }): { x: number; y: number } {
  return maps.reduceRight((at, map) => project(map, at), point);
}

describe('FrameRegistry.frameMaps', () => {
  it('reads a turned frame’s quad in the viewport of its process’s outermost document', async () => {
    const fake = turnedChromium(flatQuad(110, 70, 100, 100), { top: 'page', 'outer-doc': 'page' });
    const maps = await nestedChromium().frameMaps(fake.connection, 'inner-doc', BROWSER_TRAITS.chromium);
    expect(toTop(maps!, { x: 5, y: 5 })).toEqual({ x: 115, y: 75 });
  });

  it('reads it in the frame’s own document when another process renders that document', async () => {
    const fake = turnedChromium(flatQuad(10, 20, 100, 100), { top: 'page', 'outer-doc': 'oopif' });
    const maps = await nestedChromium().frameMaps(fake.connection, 'inner-doc', BROWSER_TRAITS.chromium);
    expect(toTop(maps!, { x: 5, y: 5 })).toEqual({ x: 115, y: 75 });
  });

  it('maps an unturned chain by each frame’s content box and scale, without CDP', async () => {
    const fake = new FakeBidi();
    const registry = nested({ outer: { content: { x: 100, y: 50, width: 200, height: 200 }, scale: { x: 0.5, y: 0.5 } }, inner: { content: { x: 10, y: 20, width: 100, height: 100 }, scale: { x: 1, y: 1 } } });
    const maps = await registry.frameMaps(fake.connection, 'inner-doc', BROWSER_TRAITS.chromium);
    expect(toTop(maps!, { x: 4, y: 4 })).toEqual({ x: 107, y: 62 });
    expect(fake.sent).toEqual([]);
  });

  it('maps nothing through a frame that lays out no box', async () => {
    const registry = nested({ outer: null, inner: { content: { x: 10, y: 20, width: 100, height: 100 }, scale: { x: 1, y: 1 } } });
    await expect(registry.frameMaps(new FakeBidi().connection, 'inner-doc', BROWSER_TRAITS.chromium)).resolves.toBeNull();
  });
});

describe('splitFrames', () => {
  const framed: LocatorExpression = { kind: 'frame', selector: '#editor', source: note };

  it('lists the frames outermost first and drops the frame steps wherever they sit', () => {
    expect(splitFrames(framed)).toEqual({ chain: ['#editor'], inner: note });
    expect(splitFrames({ kind: 'frame', selector: '#outer', source: framed })).toEqual({ chain: ['#outer', '#editor'], inner: note });
    expect(splitFrames({ kind: 'index', index: 'first', source: framed })).toEqual({ chain: ['#editor'], inner: { kind: 'index', index: 'first', source: note } });
    expect(splitFrames({ kind: 'filter', source: framed, has: framed })).toEqual({ chain: ['#editor'], inner: { kind: 'filter', source: note, has: note } });
    expect(splitFrames({ kind: 'filter', source: framed, hasNot: note })).toEqual({ chain: ['#editor'], inner: { kind: 'filter', source: note, hasNot: note } });
    expect(splitFrames({ kind: 'union', left: framed, right: framed })).toEqual({ chain: ['#editor'], inner: { kind: 'union', left: note, right: note } });
    expect(splitFrames({ ...note, scope: framed } as LocatorExpression)).toEqual({ chain: ['#editor'], inner: { ...note, scope: note } });
    expect(splitFrames(note)).toEqual({ chain: [], inner: note });
  });

  it('rejects a union or an inner locator in another document', () => {
    const elsewhere: LocatorExpression = { kind: 'frame', selector: '#other', source: note };
    for (const expression of [
      { kind: 'union', left: framed, right: elsewhere },
      { kind: 'union', left: framed, right: note },
      { kind: 'filter', source: framed, has: elsewhere },
      { kind: 'filter', source: note, hasNot: framed },
    ] satisfies LocatorExpression[]) {
      expect(() => splitFrames(expression)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', retryable: false }));
    }
  });
});


describe('inViewport', () => {
  const node: SemanticNode = { ref: { id: 'n1', revision: '' }, states: {}, attributes: {}, inputPurpose: 'none', rect: { x: 10, y: 10, width: 50, height: 20 } };
  /** A node filling a 200 by 100 viewport. */
  const whole: SemanticNode = { ...node, rect: { x: 0, y: 0, width: 200, height: 100 } };
  const frame = (x: number, y: number, width: number, height: number, scale = 1): FrameBox => ({ content: { x, y, width, height }, scale: { x: scale, y: scale } });

  it('shifts a box into the frame, clips it, and sets the frame path', () => {
    expect(inViewport(node, [frame(100, 200, 40, 400)], ['#editor'])).toMatchObject({
      rect: { x: 110, y: 210, width: 30, height: 20 },
      framePath: ['#editor'],
    });
  });

  it('shifts a bordered node’s origin with its box', () => {
    expect(inViewport({ ...node, origin: { x: 14, y: 13 } }, [frame(100, 200, 400, 400)], ['#editor'])).toMatchObject({
      rect: { x: 110, y: 210, width: 50, height: 20 },
      origin: { x: 114, y: 213 },
    });
  });

  it('nests each holding frame’s content box into the top-level viewport', () => {
    const placed = inViewport(whole, [frame(102, 52, 396, 296), frame(10, 20, 100, 100)], ['#outer', '#inner']);
    expect(placed.rect).toEqual({ x: 112, y: 72, width: 100, height: 100 });
    expect(placed.origin).toBeUndefined();
  });

  it('keeps an inner frame’s origin where it lies when its parent clips it', () => {
    const placed = inViewport(whole, [frame(100, 0, 400, 300), frame(-50, 10, 200, 100)], ['#outer', '#inner']);
    expect(placed).toMatchObject({ rect: { x: 100, y: 10, width: 150, height: 100 }, origin: { x: 50, y: 10 } });
  });

  it('scales an inner frame’s coordinates by the outer frame’s transform', () => {
    const placed = inViewport(whole, [frame(0, 0, 200, 200, 0.5), frame(100, 40, 100, 100)], ['#outer', '#inner']);
    expect(placed.rect).toEqual({ x: 50, y: 20, width: 50, height: 50 });
  });

  it('drops the box of a node outside its frame, in a frame with no box, or in a turned frame', () => {
    expect(inViewport(node, [frame(0, 0, 5, 5)], ['#f']).rect).toBeUndefined();
    expect(inViewport(node, [null], ['#f']).rect).toBeUndefined();
    expect(inViewport(node, [TURNED], ['#f']).rect).toBeUndefined();
    expect(inViewport(node, [frame(0, 0, 400, 400), null], ['#outer', '#f']).rect).toBeUndefined();
    expect(inViewport(node, [], [])).toBe(node);
  });
});


describe('pageParts', () => {
  it('reads each part as Playwright does: a prefix names the engine, a path is XPath, the rest CSS', () => {
    expect(pageParts('xpath=//iframe >> css=#a > b >> //li >> (//li)[2] >> ../a >> * > button')).toEqual([
      { engine: 'xpath', body: '//iframe' },
      { engine: 'css', body: '#a > b', chains: [[{ compound: '#a', combinator: null }, { compound: 'b', combinator: '>' }]] },
      { engine: 'xpath', body: '//li' },
      { engine: 'xpath', body: '(//li)[2]' },
      { engine: 'xpath', body: '../a' },
      { engine: 'css', body: '* > button', chains: [[{ compound: '*', combinator: null }, { compound: 'button', combinator: '>' }]] },
    ]);
  });

  it('rejects an engine other than CSS and XPath, and a capture before the last part', () => {
    expect(() => pageParts('text=Hello')).toThrow('the text= engine is not supported');
    expect(() => pageParts('*css=section >> button')).toThrow('a selector that captures with *');
  });
});

const FRAME = { content: { x: 40, y: 30, width: 300, height: 150 }, scale: { x: 1, y: 1 } };

describe('placeInFrame', () => {
  it('shifts a box inside the frame, with no origin when its corner is its own', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 } }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
    });
  });

  it('shifts a bordered node origin with its box', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
      origin: { x: 58, y: 58 },
    });
  });

  it('keeps the unclipped corner as the origin of a box the frame clips', () => {
    expect(placeInFrame({ rect: { x: 0, y: -125, width: 200, height: 400 } }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 40, y: -95 },
    });
  });

  it('keeps a bordered origin unclipped when the frame clips the box', () => {
    expect(placeInFrame({ rect: { x: 0, y: -125, width: 200, height: 400 }, origin: { x: 1, y: -124 } }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 41, y: -94 },
    });
  });

  it('drops the box and origin of a node outside the frame', () => {
    expect(placeInFrame({ rect: { x: 0, y: 400, width: 20, height: 20 }, origin: { x: 1, y: 401 } }, FRAME)).toEqual({});
  });

  it('scales a box and its origin by the frame before shifting them', () => {
    expect(placeInFrame({ rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } }, { ...FRAME, scale: { x: 0.5, y: 2 } })).toEqual({
      rect: { x: 45, y: 70, width: 25, height: 80 },
      origin: { x: 49, y: 86 },
    });
  });

  it('places no box in a frame that lays out none or is turned, nor for a node with none', () => {
    const node = { rect: { x: 10, y: 20, width: 50, height: 40 }, origin: { x: 18, y: 28 } };
    expect(placeInFrame(node, null)).toEqual({});
    expect(placeInFrame(node, { turned: { width: 300, height: 150, inset: { x: 0, y: 0, width: 300, height: 150 }, quad: null } })).toEqual({});
    expect(placeInFrame({}, FRAME)).toEqual({});
  });
});
