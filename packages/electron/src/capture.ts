/**
 * Pixels: screenshots with every password field and nested document painted
 * over, withheld when the window holds one no mask reaches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, readPngSize, type EngineSnapshot, type ObservationPixels } from '@e2e-dev/core/engine';
import type { Locator } from 'playwright-core';
import type { DevTools } from './devtools.ts';
import { viewportSize } from './in-page/node-ops.ts';
import type { RawRead } from './locate.ts';
import { MASKED_TAGS } from './snapshot.ts';
import type { AppWindow } from './windows.ts';

/** Everything that can hold a secure value or show another document in a screenshot: masked, or the capture is not taken. */
const MASKED_SELECTOR = ['input[type=password i]', ...MASKED_TAGS.map((tag) => tag.toLowerCase())].join(', ');

/** How many password fields and nested documents in the window's document no selector mask reaches; see `DomSnapshot.unmaskableCount`. */
async function unmaskable(devtools: DevTools, window: AppWindow): Promise<number> {
  return (await devtools.snapshot(window.page))?.dom.unmaskableCount() ?? 0;
}

/** A capture with its masks painted over, or why it is withheld; `masked` says how many regions the masks cover either way. */
type MaskedCapture = { readonly masked: number } & ({ readonly image: Buffer } | { readonly withheld: string });

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
async function maskedCapture(devtools: DevTools, window: AppWindow, unmaskableBefore: number, scale: 'css' | 'device'): Promise<MaskedCapture> {
  const masks = window.page.locator(MASKED_SELECTOR);
  const masked = await masks.count();
  if (unmaskableBefore > 0) return { masked, withheld: outOfReach(unmaskableBefore) };
  const placed = await maskBoxes(masks);
  // Animations stopped, so a field a CSS animation moves stays under the mask measured for it.
  const image = await window.page.screenshot({ scale, mask: [masks], maskColor: '#000000', caret: 'hide', animations: 'disabled' });
  const after = await unmaskable(devtools, window);
  if (after > 0) return { masked, withheld: outOfReach(after) };
  if ((await masks.count()) > masked) {
    return { masked, withheld: 'a password field or nested document appeared while the screenshot was taken, after its masks were placed, so the screenshot is withheld' };
  }
  // A mask is painted where its element was measured: one a script moved since may show beside its mask.
  if ((await maskBoxes(masks)) !== placed) {
    return { masked, withheld: 'a password field or nested document moved while the screenshot was taken, out from under its mask, so the screenshot is withheld' };
  }
  return { masked, image };
}

/** Where the masked elements are in the viewport, as one comparable string. */
async function maskBoxes(masks: Locator): Promise<string> {
  return await masks.evaluateAll((elements) =>
    elements
      .map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round).join(',');
      })
      .join(';'),
  );
}

/** Adds the pixels to an observation of a read window, or leaves them out when they are withheld. */
export async function withPixels(devtools: DevTools, raw: RawRead, snapshot: EngineSnapshot): Promise<EngineSnapshot> {
  const capture = await maskedCapture(devtools, raw.window, raw.dom.unmaskableCount(), 'css');
  if ('withheld' in capture) return { ...snapshot, maskedRegionCount: capture.masked };
  const data = new Uint8Array(capture.image);
  const { width: css } = await devtools.evaluate(raw.window.page, viewportSize);
  const size = readPngSize(data);
  if (size === undefined) throw new Error('the window capture is not a PNG');
  const pixels: ObservationPixels = { data, mediaType: 'image/png', width: size.width, height: size.height, scale: css > 0 ? size.width / css : 1 };
  return { ...snapshot, pixels, maskedRegionCount: capture.masked };
}

/**
 * `app.screenshot(label)`: the window with its masks painted over, written
 * under the attempt's artifacts as `screenshots/<n>-<label>.png`. Refused
 * with `POLICY_DENIED` when the capture is withheld.
 */
export async function screenshotFile(devtools: DevTools, window: AppWindow, artifactsDir: string, name: string): Promise<string> {
  const capture = await maskedCapture(devtools, window, await unmaskable(devtools, window), 'device');
  if ('withheld' in capture) throw new ConfigurationError('POLICY_DENIED', capture.withheld);
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
