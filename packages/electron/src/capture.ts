/**
 * Pixels: screenshots of the viewport or the whole page with every password
 * field and nested document painted over, withheld when the window holds one
 * no mask reaches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, readPngSize, TestError, type EngineScreenshotOptions, type EngineSnapshot, type ObservationPixels } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { pixelRatio, placeMasks, removeMasks, type MaskState } from './in-page/masks.ts';
import { viewportSize } from './in-page/node-ops.ts';
import { inDocument, type RawRead } from './locate.ts';
import type { PageTarget } from './page.ts';
import { MASKED_TAGS } from './snapshot.ts';
import type { AppWindow } from './windows.ts';

/** Everything that can hold a secure value or show another document in a screenshot: masked, or the capture is not taken. */
const MASKED_SELECTOR = ['input[type=password i]', ...MASKED_TAGS.map((tag) => tag.toLowerCase())].join(', ');

/**
 * How many password fields and nested documents in the window's document no
 * selector mask reaches; see `DomSnapshot.unmaskableCount`. Undefined when the
 * document could not be read: nothing is then known to be masked.
 */
async function unmaskable(devtools: DevTools, window: AppWindow): Promise<number | undefined> {
  return (await devtools.snapshot(window.page))?.dom.unmaskableCount();
}

const UNREAD = 'the window\'s document could not be read to check what its masks cover, so the screenshot is withheld';

/**
 * What a capture covers: the window's viewport when undefined, else the whole
 * page, cut to the options' clip when there is one.
 */
type Region = EngineScreenshotOptions | undefined;

/** A capture's pixels, how many CSS pixels wide they are, and, on a whole page, how far it is scrolled. */
interface Shot {
  readonly image: Buffer;
  readonly width: number;
  readonly scroll?: { readonly x: number; readonly y: number };
}

/** A capture with its masks painted over, or why it is withheld; `masked` says how many regions the masks cover either way. */
type MaskedCapture = { readonly masked: number } & (Shot | { readonly withheld: string });

function outOfReach(count: number): string {
  const plural = count === 1 ? '' : 's';
  return `the window shows ${count} password field${plural} or nested document${plural} inside a closed shadow root, which no mask reaches, so the screenshot is withheld`;
}

/**
 * The one way pixels leave a window: every password field and nested document
 * painted over, and nothing returned when one sits in a closed shadow root,
 * out of every selector's reach. `unmaskableBefore` is that count from a read
 * the caller already has. The app may render such an element while the
 * capture runs, inside a closed shadow root or beside the masks already
 * placed, so the document is read again before the pixels go out.
 */
function maskedCapture(devtools: DevTools, window: AppWindow, unmaskableBefore: number | undefined, scale: 'css' | 'device', region: Region): Promise<MaskedCapture> {
  // One capture of a page at a time: the masks are the page's, and a second capture would take the first one's away.
  const turn = (captures.get(window.page) ?? Promise.resolve()).then(() => captureUnderMasks(devtools, window, unmaskableBefore, scale, region));
  captures.set(window.page, turn.catch(() => undefined));
  return turn;
}

const captures = new WeakMap<PageTarget, Promise<unknown>>();

async function captureUnderMasks(devtools: DevTools, window: AppWindow, unmaskableBefore: number | undefined, scale: 'css' | 'device', region: Region): Promise<MaskedCapture> {
  const { page } = window;
  if (unmaskableBefore === undefined) return { masked: (await page.evaluate(removeMasks, MASKED_SELECTOR)).count, withheld: UNREAD };
  if (unmaskableBefore > 0) return { masked: (await page.evaluate(removeMasks, MASKED_SELECTOR)).count, withheld: outOfReach(unmaskableBefore) };
  const placed = await page.evaluate(placeMasks, MASKED_SELECTOR);
  const { count: masked } = placed;
  let shot: Shot;
  let after: MaskState | undefined;
  try {
    shot = region === undefined ? await captureViewport(window, scale) : await capturePage(window, scale, region);
  } finally {
    // The masks never outlive the capture, whatever became of it.
    after = await page.evaluate(removeMasks, MASKED_SELECTOR).catch(() => undefined);
  }
  // A document that navigated or reloaded under the capture took its masks with it: the image may show the new one bare.
  if (!placed.placed) return { masked, withheld: 'a mask did not cover the password field or nested document it was placed over, so the screenshot is withheld' };
  if (after?.placed !== true) return { masked, withheld: 'the masks did not last through the screenshot (the window loaded another document, or the page removed them), so the screenshot is withheld' };
  const unmaskableAfter = await unmaskable(devtools, window);
  if (unmaskableAfter === undefined) return { masked, withheld: UNREAD };
  if (unmaskableAfter > 0) return { masked, withheld: outOfReach(unmaskableAfter) };
  if (after.count > masked) {
    return { masked, withheld: 'a password field or nested document appeared while the screenshot was taken, after its masks were placed, so the screenshot is withheld' };
  }
  // A mask is painted where its element was measured: one a script moved since may show beside its mask.
  if (after.boxes !== placed.boxes) {
    return { masked, withheld: 'a password field or nested document moved while the screenshot was taken, out from under its mask, so the screenshot is withheld' };
  }
  return { masked, ...shot };
}

/** The window's viewport as a PNG: one image pixel per CSS pixel, or per device pixel. */
async function captureViewport(window: AppWindow, scale: 'css' | 'device'): Promise<Shot> {
  const { page } = window;
  const [{ cssVisualViewport: scrolled }, { width, height }, ratio] = await Promise.all([page.session.send('Page.getLayoutMetrics'), page.evaluate(viewportSize), page.evaluate(pixelRatio)]);
  // A clip is in the document's coordinates, so the window's is where the document is scrolled to. It is the window's
  // whole inner size, scrollbars included, as a capture with no clip is.
  const clip = scale === 'css' && ratio !== 1 ? { x: scrolled.pageX, y: scrolled.pageY, width, height, scale: 1 / ratio } : undefined;
  const { data } = await page.captured(() => page.session.send('Page.captureScreenshot', { format: 'png', ...(clip === undefined ? {} : { clip }) }));
  return { image: Buffer.from(data, 'base64'), width };
}

/**
 * The window's whole page as a PNG, cut to the region's clip: Chromium paints
 * past the viewport without scrolling or resizing the window. A fixed
 * element, the masks among them, lands where it shows at the current scroll,
 * the same place in the page as the element it covers.
 */
async function capturePage(window: AppWindow, scale: 'css' | 'device', region: EngineScreenshotOptions): Promise<Shot> {
  const { page } = window;
  const [{ cssContentSize: content, cssVisualViewport: scrolled }, ratio] = await Promise.all([page.session.send('Page.getLayoutMetrics'), page.evaluate(pixelRatio)]);
  const whole = { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height) };
  let kept = whole;
  if (region.clip !== undefined) {
    const inside = overlap(region.clip, whole);
    const { x, y, width, height } = region.clip;
    if (inside === undefined) throw new TestError('INVALID_ARGUMENT', `screenshot clip { x: ${x}, y: ${y}, width: ${width}, height: ${height} } is outside the ${whole.width}x${whole.height} page`);
    kept = inside;
  }
  const clip = { ...kept, scale: scale === 'css' ? 1 / ratio : 1 };
  const { data } = await page.captured(() => page.session.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }));
  return { image: Buffer.from(data, 'base64'), width: kept.width, scroll: { x: scrolled.pageX, y: scrolled.pageY } };
}

/** The part of `box` inside `bounds`; undefined when none of it is. */
function overlap(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  const x = Math.max(box.x, bounds.x);
  const y = Math.max(box.y, bounds.y);
  const width = Math.min(box.x + box.width, bounds.x + bounds.width) - x;
  const height = Math.min(box.y + box.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Adds the pixels of the viewport, or with `fullPage` of the whole page, to an observation of a read window, or leaves them out when they are withheld. */
export async function withPixels(devtools: DevTools, raw: RawRead, snapshot: EngineSnapshot, { fullPage = false }: { readonly fullPage?: boolean } = {}): Promise<EngineSnapshot> {
  // The pixels are of the document the snapshot describes, or the observation is taken again.
  const capture = await inDocument(raw.window, raw.generation, () => maskedCapture(devtools, raw.window, raw.dom.unmaskableCount(), 'css', fullPage ? { fullPage: true } : undefined));
  if ('withheld' in capture) return { ...snapshot, maskedRegionCount: capture.masked };
  const data = new Uint8Array(capture.image);
  const size = readPngSize(data);
  if (size === undefined) throw new Error('the window capture is not a PNG');
  const pixels: ObservationPixels = {
    data,
    mediaType: 'image/png',
    width: size.width,
    height: size.height,
    scale: capture.width > 0 ? size.width / capture.width : 1,
    ...(capture.scroll === undefined ? {} : { scroll: capture.scroll }),
  };
  return { ...snapshot, pixels, maskedRegionCount: capture.masked };
}

/**
 * `app.screenshot(label)`: the window's viewport, or the whole page the
 * region asks for, with its masks painted over, written under the attempt's
 * artifacts as `screenshots/<n>-<label>.png`. Refused with `POLICY_DENIED`
 * when the capture is withheld, when `refused` says why the window is not
 * one to capture, or when the window loaded another document while the
 * capture waited its turn: the pixels are of the document `refused`
 * approved, or none are kept.
 */
export async function screenshotFile(devtools: DevTools, window: AppWindow, artifactsDir: string, name: string, refused: () => string | undefined, region?: Region): Promise<string> {
  const before = refused();
  if (before !== undefined) throw new ConfigurationError('POLICY_DENIED', before);
  const generation = window.page.generation;
  const capture = await maskedCapture(devtools, window, await unmaskable(devtools, window), 'device', region);
  if ('withheld' in capture) throw new ConfigurationError('POLICY_DENIED', capture.withheld);
  if (window.page.generation !== generation) throw new ConfigurationError('POLICY_DENIED', 'the window loaded another document while the screenshot was taken, so the screenshot is withheld');
  const after = refused();
  if (after !== undefined) throw new ConfigurationError('POLICY_DENIED', after);
  const relative = path.posix.join('screenshots', name);
  const absolute = path.join(artifactsDir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, capture.image);
  return relative;
}

/** A screenshot's file name: its number in the attempt and a label that cannot turn into a path (letters, digits, dashes). */
export function screenshotName(counter: number, label: string | undefined): string {
  const safe = label === undefined ? '' : label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${String(counter).padStart(3, '0')}${safe === '' ? '' : `-${safe}`}.png`;
}
