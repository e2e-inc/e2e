/**
 * A capture stops what time moves on the page: an animation or transition
 * that ends is captured at its end, one that repeats forever at the style
 * under it, in every document and shadow root, and every path out of the
 * capture plays the cancelled ones again.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSnapshot } from '@e2e-dev/core/engine';
import { aroundCapture, heldByCapture } from '../helpers/capture-hooks.ts';
import { attribute } from '../helpers/frames.ts';
import { gate } from '../helpers/gate.ts';
import { decodePng } from '../helpers/png.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';
import { maskSecureFields } from '../../src/in-page/mask.ts';

const GREEN = [0, 128, 0, 255];
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

/**
 * A block that blinks from red to blue forever over a green style of its
 * own, so green shows only while the animation is cancelled, above a black
 * block whose move 200px to the right takes ten minutes.
 */
const STAGE = `<style>
  body { margin: 0; background: #fff; }
  @keyframes blink { from { background-color: rgb(255, 0, 0); } to { background-color: rgb(0, 0, 255); } }
  #blink { width: 40px; height: 40px; background: rgb(0, 128, 0); animation: blink 200ms linear infinite alternate; }
  #slide { width: 40px; height: 40px; background: rgb(0, 0, 0); transition: margin-left 600s linear; }
  #slide.moved { margin-left: 200px; }
</style>
<div id="blink"></div><div id="slide"></div>`;

/** A page that holds the stage in each place a capture must reach, with `window.stage()` answering the root it is in. */
const PLACES: readonly (readonly [string, string])[] = [
  ['the document', `<!doctype html>${STAGE}<script>window.stage = () => document;</script>`],
  ...(['open', 'closed'] as const).map((mode) => [
    `${mode === 'open' ? 'an' : 'a'} ${mode} shadow root`,
    `<!doctype html><style>body { margin: 0; }</style><div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: '${mode}' });
        root.innerHTML = ${JSON.stringify(STAGE)};
        window.stage = () => root;
      </script>`,
  ] as const),
  [
    'a frame',
    `<!doctype html><style>body { margin: 0; }</style>
      <iframe style="display:block;border:0;width:320px;height:200px" srcdoc="${attribute(STAGE)}"></iframe>
      <script>window.stage = () => document.querySelector('iframe').contentDocument;</script>`,
  ],
];

/** How far the blink animation has played, in milliseconds; -1 while the block has none. Runs in the page. */
function blinkTime(): number {
  const stage: () => Document | ShadowRoot = Reflect.get(window, 'stage');
  const [animation] = stage().getElementById('blink')!.getAnimations();
  return animation === undefined ? -1 : Number(animation.currentTime);
}

/** The blink animation's play state; `none` while the block has none. Runs in the page. */
function blinkState(): string {
  const stage: () => Document | ShadowRoot = Reflect.get(window, 'stage');
  return stage().getElementById('blink')!.getAnimations()[0]?.playState ?? 'none';
}

/** Starts the slide's move and records the stage's `transitionend`s; answers how far the block has moved, in pixels. Runs in the page. */
function startSlide(): number {
  const stage: () => Document | ShadowRoot = Reflect.get(window, 'stage');
  const ended: string[] = [];
  Reflect.set(window, 'ended', ended);
  const slide = stage().getElementById('slide')!;
  stage().addEventListener('transitionend', (event) => ended.push(`${event.type} of ${event.target === slide ? 'the slide' : 'something else'}`));
  const style = (slide.ownerDocument.defaultView ?? window).getComputedStyle(slide);
  // Reading the style before the change gives the transition a value to start from.
  void style.marginLeft;
  slide.classList.add('moved');
  return Number.parseFloat(style.marginLeft);
}

/** The `transitionend`s `startSlide` recorded. Runs in the page. */
function transitionEnds(): string[] {
  return Reflect.get(window, 'ended');
}

let session: WebSession;

beforeAll(async () => {
  session = await startWebSession({ web: { viewport: { width: 320, height: 200 } }, startAttempt: false });
});

beforeEach(async () => {
  await session.startAttempt();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await session.endAttempt();
});

afterAll(async () => {
  await session?.close();
});

/** One observation's pixels: the bytes, and the image they decode to. */
async function capture(): Promise<{ bytes: Uint8Array; image: ReturnType<typeof decodePng>; snapshot: EngineSnapshot }> {
  const snapshot = await session.observe({ pixels: true });
  if (snapshot.pixels === undefined) throw new Error('the observation took no pixels');
  return { bytes: snapshot.pixels.data, image: decodePng(snapshot.pixels.data), snapshot };
}

/** One artifact screenshot, decoded. */
async function screenshot(label: string): Promise<ReturnType<typeof decodePng>> {
  return decodePng(readFileSync(path.join(session.artifactsDir, await session.engine.artifacts!.screenshot!(label, session.op(10_000)))));
}

/** Whether the blink animation plays again, from its start. */
async function expectBlinkRuns(): Promise<void> {
  await expect.poll(() => session.browser.evaluate(blinkTime), { timeout: 5_000 }).toBeGreaterThan(0);
}

describe.each(PLACES)('in %s', (_place, page) => {
  it('takes the same pixels of an infinite animation twice, and the animation runs again afterwards', async () => {
    await session.setContent(page);
    await session.waitForFrames();
    expect(await session.browser.evaluate(blinkTime)).toBeGreaterThanOrEqual(0);

    const first = await capture();
    const second = await capture();

    expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
    expect(first.image.pixelAt(20, 20)).toEqual(GREEN);
    await expectBlinkRuns();
  });

  it('captures a transition in flight at its end, and its transitionend fires', async () => {
    await session.setContent(page);
    await session.waitForFrames();
    expect(await session.browser.evaluate(startSlide)).toBeLessThan(1);

    const { image } = await capture();

    expect(image.pixelAt(220, 60)).toEqual(BLACK);
    expect(image.pixelAt(20, 60)).toEqual(WHITE);
    await expect.poll(() => session.browser.evaluate(transitionEnds), { timeout: 5_000 }).toEqual(['transitionend of the slide']);
  });
});

it('takes an artifact screenshot with every animation held where it is, and each goes on afterwards', async () => {
  await session.setContent(PLACES[0]![1]);
  expect(await session.browser.evaluate(startSlide)).toBeLessThan(1);
  const during: string[] = [];
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(blinkState));
    },
  });
  await expectBlinkRuns();
  const before = await session.browser.evaluate(blinkTime);

  const image = await screenshot('held');
  vi.restoreAllMocks();

  // The slide is where its ten minute move had it, not at its end, and its transition goes on, with no end event.
  expect(image.pixelAt(20, 60)).toEqual(BLACK);
  expect(image.pixelAt(220, 60)).toEqual(WHITE);
  expect(during).toEqual(['paused']);
  expect(await session.browser.evaluate(blinkState)).toBe('running');
  // Back on its clock, the animation is further on than before, where one played again would start over.
  await expect.poll(() => session.browser.evaluate(blinkTime)).toBeGreaterThan(before);
  expect(await session.browser.evaluate(transitionEnds)).toEqual([]);
  expect(await session.browser.evaluate(() => document.getElementById('slide')!.getAnimations().map((animation) => animation.playState))).toEqual(['running']);
});

it('takes an artifact screenshot of a page that removes a node when its animation ends, and the node stays', async () => {
  await session.setContent(`<!doctype html>
    <style>
      @keyframes fade { to { opacity: 0; } }
      #toast { animation: fade 20s linear; }
    </style>
    <p id="toast">Saved</p>
    <script>
      window.events = [];
      for (const type of ['animationend', 'animationcancel', 'animationstart']) document.addEventListener(type, (event) => window.events.push(event.type));
      document.getElementById('toast').addEventListener('animationend', (event) => event.target.remove());
    </script>`);
  await expect.poll(() => session.browser.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['animationstart']);

  await screenshot('toast');

  expect(await session.browser.evaluate(() => ({
    toast: document.getElementById('toast')?.getAnimations().map((animation) => animation.playState) ?? null,
    events: (window as unknown as { events: string[] }).events,
  }))).toEqual({ toast: ['running'], events: ['animationstart'] });
});

it.each([
  ['an artifact screenshot', (): Promise<unknown> => session.engine.artifacts!.screenshot!('unmaskable', session.op(5_000))],
  ['an observation', (): Promise<unknown> => session.engine.observe!(session.op(5_000), { pixels: true })],
])('sets the animations going again when %s cannot mask a page that broke popovers', async (_capture, take) => {
  await session.setContent(`${PLACES[0]![1]}<input type="password" value="hunter22"><script>HTMLElement.prototype.showPopover = () => { throw new Error('no popovers here'); };</script>`);
  await expectBlinkRuns();

  // An observation reads on without the pixels it could not take; a screenshot fails.
  await take().catch(() => undefined);

  expect(await session.browser.evaluate(heldByCapture)).toBe('0 hosts, 0 sheets, 1 animations');
  expect(await session.browser.evaluate(blinkState)).toBe('running');
});

it('sets a held animation going again when the capture fails', async () => {
  await session.setContent(PLACES[0]![1]);
  const during: string[] = [];
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(blinkState));
      throw new Error('capture failed');
    },
  });

  await expect(session.engine.artifacts!.screenshot!('failed', session.op(5_000))).rejects.toThrow('capture failed');
  vi.restoreAllMocks();

  expect(during).toEqual(['paused']);
  expect(await session.browser.evaluate(blinkState)).toBe('running');
});

it('takes the mask off a document it masked after another document could not be masked', async () => {
  await session.setContent(`${PLACES[0]![1]}<iframe srcdoc="<p>Frame</p>"></iframe>`);
  await session.waitForFrames();
  const send = BidiConnection.prototype.send;
  const { held: whenFrameFailed, release: frameFailed } = gate();
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(async function (this: BidiConnection, method, params) {
    if (method === 'script.callFunction' && (params as { functionDeclaration: string }).functionDeclaration === maskSecureFields.toString()) {
      const { contexts } = await this.send('browsingContext.getTree', { maxDepth: 0 });
      if (!contexts.some((top) => top.context === (params as { target: { context: string } }).target.context)) {
        frameFailed();
        throw new Error('mask failed');
      }
      // The tab's own document is masked only once the frame's mask failed, so its mask is the one left to take off.
      await whenFrameFailed;
    }
    return send.call(this, method, params);
  });

  await expect(session.engine.artifacts!.screenshot!('unmaskable', session.op(5_000))).rejects.toThrow('mask failed');
  vi.restoreAllMocks();

  expect(await session.browser.evaluate(heldByCapture)).toBe('0 hosts, 0 sheets, 1 animations');
  expect(await session.browser.evaluate(blinkState)).toBe('running');
});

it('plays a cancelled animation again when the capture goes stale, and stops it again for the capture that follows', async () => {
  await session.setContent(PLACES[0]![1]);
  const during: number[] = [];
  let captures = 0;
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(blinkTime));
    },
    after: (order, connection, context) => {
      captures = order;
      if (order > 1) return;
      // A navigation committed under the masks makes the capture stale, though the browser answered it.
      const event = { type: 'event', method: 'browsingContext.navigationCommitted', params: { context, navigation: null, timestamp: Date.now(), url: session.origin } };
      (connection as unknown as { receive(raw: string): void }).receive(JSON.stringify(event));
    },
  });

  const { image } = await capture();
  vi.restoreAllMocks();

  expect(captures).toBe(2);
  // The second capture found the animation running again, or it would have had nothing to cancel.
  expect(during).toEqual([-1, -1]);
  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('keeps an animation cancelled for a capture that overlaps the one that cancelled it', async () => {
  await session.setContent(PLACES[0]![1]);
  let second: Promise<Awaited<ReturnType<typeof capture>>> | undefined;
  const { held: whenSecondMasked, release: secondMasked } = gate();
  const { held: whenFirstDone, release: firstDone } = gate();
  aroundCapture({
    before: async (order) => {
      if (order === 1) {
        // The second capture masks the page while the first holds it, and takes its screenshot only once the first let go.
        second = capture();
        await whenSecondMasked;
      } else {
        secondMasked();
        await whenFirstDone;
      }
    },
  });

  const first = await capture();
  firstDone();
  const overlapping = await second!;
  vi.restoreAllMocks();

  expect(first.image.pixelAt(20, 20)).toEqual(GREEN);
  expect(overlapping.image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('leaves stopped a CSS animation the page dropped during the capture, and plays again what the page still has', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes fade { to { opacity: 0.5; } }
      div { width: 20px; height: 20px; }
      .spin { animation: spin 1s linear infinite; }
      #kept { animation: spin 1s linear infinite, fade 2s linear infinite; }
      #kept::before { content: ''; display: block; animation: fade 2s linear infinite; }
    </style>
    <div id="unclassed" class="spin"></div><div id="removed" class="spin"></div><div id="scripted"></div><div id="kept"></div>
    <script>document.getElementById('scripted').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, iterations: Infinity });</script>`);
  /** What animates in the document: each animation's name, or `script` for one a script made, its state, and its target. Runs in the page. */
  const animating = (): string[] => document.getAnimations().map((animation) => {
    const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
    return `${animation instanceof CSSAnimation ? animation.animationName : 'script'} ${animation.playState} on ${String(effect?.target?.id)}${effect?.pseudoElement ?? ''}`;
  });
  const kept = ['spin running on kept', 'fade running on kept', 'fade running on kept::before'];
  expect(await session.browser.evaluate(animating)).toEqual(['spin running on unclassed', 'spin running on removed', ...kept, 'script running on scripted']);
  const during: string[][] = [];
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(animating));
      await session.browser.evaluate(() => {
        document.getElementById('unclassed')!.classList.remove('spin');
        const taken = ['removed', 'scripted'].map((id) => document.getElementById(id)!);
        Reflect.set(window, 'taken', taken);
        for (const element of taken) element.remove();
        return null;
      });
    },
  });

  await capture();
  vi.restoreAllMocks();

  expect(during).toEqual([[]]);
  expect(await session.browser.evaluate(animating)).toEqual(kept);
  // Put back, the element gets the one animation its style gives it, and the script animation never stopped being the page's.
  await session.browser.evaluate(() => {
    const taken: Element[] = Reflect.get(window, 'taken');
    document.body.append(...taken);
    return null;
  });
  expect(await session.browser.evaluate(animating)).toEqual([...kept, 'spin running on removed', 'script running on scripted']);
});

it('undoes its masking in a document as it leaves under the capture', async () => {
  const masked = session.serve('/masked', `${PLACES[0]![1]}<input type="password" value="hunter22" style="position:absolute;left:100px;top:100px;width:100px;height:30px">`);
  const next = session.serve('/next', '<!doctype html><title>Next</title><p>Next</p>');
  await session.open(masked);
  expect(await session.browser.evaluate(heldByCapture)).toBe('0 hosts, 0 sheets, 1 animations');
  const during: string[] = [];
  const { held: whenLeft, release: left } = gate();
  aroundCapture({
    before: async (order) => {
      if (order > 1) return;
      during.push(await session.browser.evaluate(heldByCapture));
      // Registered after the mask's own listener, so it records what that one left. Firefox opens no session storage in a document that is already leaving.
      await session.browser.evaluate(`() => {
        sessionStorage.setItem('hidden', 'never');
        addEventListener('pagehide', () => sessionStorage.setItem('hidden', (${heldByCapture.toString()})()));
        return null;
      }`);
      await session.open(next);
      left();
    },
    // The driver reaches the tab once the document is gone, as it does when a navigation commits at once.
    unmask: () => whenLeft,
  });

  await capture();
  vi.restoreAllMocks();

  expect(during).toEqual(['1 hosts, 1 sheets, 0 animations']);
  // The next page shares the session storage the leaving document wrote what it held into.
  expect(await session.browser.evaluate(() => sessionStorage.getItem('hidden'))).toBe('0 hosts, 0 sheets, 1 animations');
});

it('covers a secure field an infinite animation moves where the field rests with the animation cancelled', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; }
      @keyframes drift { from { transform: translateX(100px); } to { transform: translateX(160px); } }
      #card { animation: drift 150ms linear infinite alternate; }
      input { position: absolute; left: 20px; top: 20px; width: 120px; height: 40px; border: 0; background: #fff; color: #fff; }
    </style>
    <div id="card"><input type="password" value="hunter22"></div>`);

  const { image, snapshot } = await capture();

  expect(snapshot.maskedRegionCount).toBe(1);
  expect(image.pixelAt(80, 40)).toEqual(BLACK);
  expect(image.pixelAt(250, 40)).toEqual(WHITE);
});

it('hides the caret of a focused field whose transition takes in the caret color', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; }
      input { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; margin: 0; padding: 0; border: 0; outline: 0; background: #fff; font-size: 40px; caret-color: rgb(255, 0, 0); transition: all 600s linear; }
    </style>
    <input>`);
  /** The field's caret color, as the capture's own transition holds it. Runs in the page. */
  const caretColor = (): string => getComputedStyle(document.querySelector('input')!).caretColor;
  await session.browser.evaluate(() => {
    document.querySelector('input')!.focus();
    return null;
  });
  expect(await session.browser.evaluate(caretColor)).toBe('rgb(255, 0, 0)');
  const during: string[] = [];
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(caretColor));
    },
  });

  const first = await capture();
  const second = await capture();
  vi.restoreAllMocks();

  expect(during).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
  const inked: string[] = [];
  for (let y = 20; y < 80; y += 1) {
    for (let x = 20; x < 220; x += 1) if (first.image.pixelAt(x, y).join() !== WHITE.join()) inked.push(`${String(x)},${String(y)}`);
  }
  expect(inked).toEqual([]);
});

it('leaves an animation that holds still as the page set it: paused, at a zero rate, or driven by scroll', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; min-height: 1200px; }
      @keyframes blink { from { background-color: rgb(255, 0, 0); } to { background-color: rgb(0, 0, 255); } }
      @keyframes grow { from { width: 0px; } to { width: 320px; } }
      div { position: fixed; left: 0; width: 40px; height: 40px; background: rgb(0, 128, 0); }
      #paused { top: 0; animation: blink 1s linear infinite; animation-play-state: paused; }
      #ended { top: 40px; animation: blink 1s linear; animation-play-state: paused; }
      #frozen { top: 80px; }
      #scrolled { top: 120px; animation: grow linear; animation-timeline: scroll(root); }
    </style>
    <div id="paused"></div><div id="ended"></div><div id="frozen"></div><div id="scrolled"></div>
    <script>
      const frozen = document.getElementById('frozen').animate([{ backgroundColor: 'rgb(255, 0, 0)' }, { backgroundColor: 'rgb(0, 0, 255)' }], { duration: 1000, iterations: Infinity });
      frozen.playbackRate = 0;
    </script>`);
  // A scroll timeline reads the scroll position once per frame.
  await session.browser.evaluate(async () => {
    scrollTo(0, 500);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return null;
  });
  /** Each block's animation states, and its style as the animation holds it. Runs in the page. */
  const held = (): string[] => ['paused', 'ended', 'frozen', 'scrolled'].map((id) => {
    const block = document.getElementById(id)!;
    const style = getComputedStyle(block);
    return `${id}: ${block.getAnimations().map((animation) => animation.playState).join()} ${style.backgroundColor} ${String(Math.round(Number.parseFloat(style.width)))}px`;
  });
  const before = await session.browser.evaluate(held);
  expect(before).toEqual([
    'paused: paused rgb(255, 0, 0) 40px',
    'ended: paused rgb(255, 0, 0) 40px',
    'frozen: running rgb(255, 0, 0) 40px',
    'scrolled: running rgb(0, 128, 0) 160px',
  ]);

  const first = await capture();
  const second = await capture();

  expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
  expect(first.image.pixelAt(20, 20).slice(0, 3)).toEqual([255, 0, 0]);
  expect(first.image.pixelAt(150, 140)).toEqual(GREEN);
  expect(await session.browser.evaluate(held)).toEqual(before);
});

it('captures a page that holds an animation its browser will not finish', async () => {
  // Firefox never applies a playback rate in a frame it does not render, and finish() refuses an animation whose rate is turning zero.
  await session.setContent(`${PLACES[0]![1]}
    <iframe style="display:none" srcdoc="<div id='held'></div><script>document.getElementById('held').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600000 }).updatePlaybackRate(0);</script>"></iframe>`);
  await session.waitForFrames();

  const { image } = await capture();

  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('plays the other animations again when the page turned one backwards under the capture', async () => {
  await session.setContent(`${PLACES[0]![1]}
    <div id="turned" style="width:40px;height:40px"></div>
    <script>window.turned = document.getElementById('turned').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, iterations: Infinity });</script>`);
  aroundCapture({
    // play() refuses an animation with no end that runs backwards.
    before: async () => {
      await session.browser.evaluate(() => {
        const turned: Animation = Reflect.get(window, 'turned');
        turned.playbackRate = -1;
        return null;
      });
    },
  });

  const { image } = await capture();
  vi.restoreAllMocks();

  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});
