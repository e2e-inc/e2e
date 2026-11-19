/**
 * Every point of the viewport the engine sets takes pointer input: its
 * corners and edges at the default size, at a configured one, at one set
 * while the attempt runs, and at the largest one a window holds, in the
 * attempt's own tab, a tab the test opens, and a tab or a window the app
 * opens. A screenshot and a recording cover all of it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ViewportSize } from '@e2e-dev/core/engine';
import { decodePng } from '../helpers/png.ts';
import { bySelector, onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

const DEFAULT: ViewportSize = { width: 1280, height: 720 };
const WIDE: ViewportSize = { width: 1920, height: 1080 };
const TALL: ViewportSize = { width: 800, height: 1400 };

const TARGET = { width: 24, height: 12 } as const;

/** Where each target sits: a corner of the viewport, or the middle of an edge. */
const PLACES = {
  'top-left': 'top:0;left:0',
  top: `top:0;left:calc(50% - ${String(TARGET.width / 2)}px)`,
  'top-right': 'top:0;right:0',
  right: `top:calc(50% - ${String(TARGET.height / 2)}px);right:0`,
  'bottom-right': 'bottom:0;right:0',
  bottom: `bottom:0;left:calc(50% - ${String(TARGET.width / 2)}px)`,
  'bottom-left': 'bottom:0;left:0',
  left: `top:calc(50% - ${String(TARGET.height / 2)}px);left:0`,
} as const;

const TARGETS = Object.keys(PLACES);

/**
 * A page three viewports tall, with no scrollbar over its right edge and a
 * blue target fixed at every place, which records what the pointer did:
 * `clicked` and `hovered` name targets, `events` has every press, release,
 * click, and wheel with its point.
 */
const EDGES = `<!doctype html><title>Edges</title>
  <style>
    html { scrollbar-width: none }
    body { margin: 0; height: 300vh; background: #fff }
    button { position: fixed; width: ${String(TARGET.width)}px; height: ${String(TARGET.height)}px; padding: 0; border: 0; background: #00f }
  </style>
  <script>
    Object.assign(window, { clicked: [], hovered: [], events: [] });
    addEventListener('click', (event) => { if (event.target.id) clicked.push(event.target.id); }, true);
    addEventListener('mouseover', (event) => { if (event.target.id) hovered.push(event.target.id); }, true);
    for (const type of ['mousedown', 'mouseup', 'click', 'wheel']) addEventListener(type, (event) => events.push(type + ' ' + event.clientX + ',' + event.clientY), true);
  </script>
  ${Object.entries(PLACES).map(([id, place]) => `<button id="${id}" style="${place}"></button>`).join('')}
  <a id="open-tab" href="/edges" target="_blank" style="position:fixed;top:40%;left:40%">Open tab</a>
  <a id="open-window" href="/edges" onclick="window.open(this.href, '_blank', 'popup,width=300,height=200'); return false" style="position:fixed;top:60%;left:40%">Open window</a>`;

/** The middle of each target in a viewport of `size`, in the order of `PLACES`. */
function centres({ width, height }: ViewportSize): { x: number; y: number }[] {
  const [left, centre, right] = [TARGET.width / 2, width / 2, width - TARGET.width / 2];
  const [top, middle, bottom] = [TARGET.height / 2, height / 2, height - TARGET.height / 2];
  return [
    { x: left, y: top }, { x: centre, y: top }, { x: right, y: top }, { x: right, y: middle },
    { x: right, y: bottom }, { x: centre, y: bottom }, { x: left, y: bottom }, { x: left, y: middle },
  ];
}

/** Opens the edges page in the shown tab. */
async function openEdges(page: WebSession): Promise<void> {
  await page.open(page.serve('/edges', EDGES));
}

/** What the shown tab's page recorded under `name`. */
function recorded(page: WebSession, name: 'clicked' | 'hovered' | 'events'): Promise<string[]> {
  return page.browser.evaluate<string[]>(`window.${name}.splice(0)`);
}

/**
 * Asserts the shown tab's page, laid out at `size`, takes a tap on every
 * target and on the last pixel of the viewport.
 */
async function expectTaps(page: WebSession, size: ViewportSize): Promise<void> {
  expect(await page.browser.evaluate('({ width: innerWidth, height: innerHeight })')).toEqual(size);
  for (const id of TARGETS) await page.act(bySelector(`#${id}`), { kind: 'tap' });
  expect(await recorded(page, 'clicked')).toEqual(TARGETS);
  const last = { x: size.width - 1, y: size.height - 1 };
  await recorded(page, 'events');
  await page.engine.performAt!(last, { kind: 'tap' }, page.op());
  expect(await recorded(page, 'events')).toEqual(['mousedown', 'mouseup', 'click'].map((type) => `${type} ${String(last.x)},${String(last.y)}`));
}

/**
 * Decodes a recording in the shown tab's page and reads its last frame: its
 * size, and the pixel at each of `points`.
 */
function lastFrame(page: WebSession, webm: Buffer, points: readonly { x: number; y: number }[]): Promise<{ width: number; height: number; pixels: number[][] }> {
  return page.browser.evaluate(async ({ bytes, at }: { bytes: number[]; at: { x: number; y: number }[] }) => {
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('ended', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('the recording did not decode')), { once: true });
      void video.play();
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: at.map(({ x, y }) => Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data.subarray(0, 3))),
    };
  }, { bytes: [...webm], at: [...points] });
}

describe.each([
  ['the default viewport', undefined],
  ['a configured 1920x1080 viewport', WIDE],
  ['a configured 800x1400 viewport', TALL],
] as const)('%s', (_name, viewport) => {
  const size = viewport ?? DEFAULT;
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession(viewport === undefined ? {} : { web: { viewport } });
  });
  afterAll(async () => {
    await page?.close();
  });

  it('takes a tap in every corner and on every edge', async () => {
    await openEdges(page);
    await expectTaps(page, size);
  });

  it('takes them in a tab the test opens', async () => {
    const tab = await page.browser.newTab();
    await openEdges(page);
    await expectTaps(page, size);
    await tab.close();
  });

  it.each(['open-tab', 'open-window'])('takes them in what the app opens: %s', async (link) => {
    await openEdges(page);
    const popup = await page.browser.waitForPopup(() => page.browser.locator(`#${link}`).tap());
    await expectTaps(page, size);
    await popup.close();
  });

  it('takes a hover, a drag, and a swipe at the bottom and right edges', async () => {
    await openEdges(page);
    const { width, height } = size;
    for (const id of ['right', 'bottom-right', 'bottom']) await page.act(bySelector(`#${id}`), { kind: 'hover' });
    expect(await recorded(page, 'hovered')).toEqual(['right', 'bottom-right', 'bottom']);

    await recorded(page, 'events');
    await page.engine.performAt!({ x: width - 2, y: 100 }, { kind: 'dragTo', target: { x: 100, y: height - 2 } }, page.op());
    expect((await recorded(page, 'events')).filter((event) => !event.startsWith('click'))).toEqual([`mousedown ${String(width - 2)},100`, `mouseup 100,${String(height - 2)}`]);

    for (const at of [{ x: width - 2, y: height / 2 }, { x: width / 2, y: height - 2 }]) {
      await page.browser.evaluate('scrollTo(0, 0)');
      await recorded(page, 'events');
      await page.engine.performAt!(at, { kind: 'swipe', direction: 'down' }, page.op());
      expect(await recorded(page, 'events')).toContain(`wheel ${String(at.x)},${String(at.y)}`);
      expect(await page.browser.evaluate<number>('scrollY')).toBeGreaterThan(0);
    }
  });

  it('shows every corner and edge in a screenshot and in a recording', async () => {
    await openEdges(page);
    const points = centres(size);
    const shot = decodePng((await page.observe({ pixels: true })).pixels!.data);
    expect({ width: shot.width, height: shot.height }).toEqual(size);
    expect(points.map(({ x, y }) => shot.pixelAt(Math.floor(x), Math.floor(y)))).toEqual(points.map(() => [0, 0, 255, 255]));

    await page.engine.artifacts!.startVideo!(page.op());
    await page.act(bySelector('#bottom-right'), { kind: 'tap' });
    const [segment, ...more] = await page.engine.artifacts!.stopVideo!(page.op());
    if (segment === undefined || !('path' in segment) || more.length > 0) throw new Error('expected one video file');
    const webm = readFileSync(path.join(page.artifactsDir, segment.path));
    await page.setContent('<!doctype html><title>Viewer</title>');
    const frame = await lastFrame(page, webm, points);
    expect({ width: frame.width, height: frame.height }).toEqual(size);
    // A lossy frame: blue is far above the other two channels wherever a target is.
    for (const [red, green, blue] of frame.pixels) expect(blue! - Math.max(red!, green!)).toBeGreaterThan(100);
  });
});

describe('a viewport set while the attempt runs', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession();
  });
  afterAll(async () => {
    await page?.close();
  });

  it.each([WIDE, TALL, DEFAULT])('takes a tap in every corner and on every edge at $width x $height, in the shown tab and the next one', async (size) => {
    await openEdges(page);
    await page.browser.setViewport(size);
    await expectTaps(page, size);
    const tab = await page.browser.newTab();
    await openEdges(page);
    await expectTaps(page, size);
    await tab.close();
  });

  it('refuses a viewport taller than the largest Firefox window and keeps the one it has, every point of it; Chromium takes it', async () => {
    const tallest = { width: 400, height: 20_000 };
    await page.browser.setViewport(DEFAULT);
    await openEdges(page);
    const resized = page.browser.setViewport(tallest);
    if (onFirefox) {
      await expect(resized).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/^the browser window cannot hold a 400x20000 viewport: it shows at most \d+ pixels of the page's height, and pointer input reaches only what the window shows\./),
      });
      await expectTaps(page, DEFAULT);
    } else {
      await resized;
      await expectTaps(page, tallest);
    }
  });

  it.each([
    ['height', { width: 400, height: 20_000 }],
    ['width', { width: 20_000, height: 300 }],
  ] as const)('takes a tap in every corner and on every edge of the largest viewport the Firefox window holds by %s, and refuses one pixel more; Chromium takes what was asked', async (side, asked) => {
    await page.browser.setViewport(DEFAULT);
    await openEdges(page);
    const refusal = await page.browser.setViewport(asked).then(() => undefined, (cause: unknown) => cause);
    if (!onFirefox) {
      expect(refusal).toBeUndefined();
      await expectTaps(page, asked);
      return;
    }
    expect(refusal).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const limit = Number(new RegExp(`it shows at most (\\d+) pixels of the page's ${side},`).exec((refusal as Error).message)?.[1]);
    const largest = { ...asked, [side]: limit };
    await page.browser.setViewport(largest);
    await expectTaps(page, largest);
    await expect(page.browser.setViewport({ ...largest, [side]: limit + 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining(`it shows at most ${String(limit)} pixels of the page's ${side},`),
    });
    await openEdges(page);
    await expectTaps(page, largest);
  });

  it('sizes a tab opened before the change once it is shown again', async () => {
    await page.browser.setViewport(DEFAULT);
    await openEdges(page);
    const [first] = page.browser.tabs();
    const second = await page.browser.newTab();
    await page.browser.setViewport(TALL);
    await first!.activate();
    await expectTaps(page, TALL);
    await second.close();
  });
});
