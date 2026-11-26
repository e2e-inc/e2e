/**
 * Pixels: screenshots with every password field and nested document painted
 * over, withheld when the window holds one no mask reaches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator } from 'playwright-core';
import { ConfigurationError, readPngSize, type EngineSnapshot, type ObservationPixels } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { viewportSize } from './in-page/node-ops.ts';
import type { RawRead } from './locate.ts';
import { MASKED_TAGS, unmaskableCount } from './tree.ts';
import type { AppWindow } from './windows.ts';

/** Everything that can hold a secure value or show another document in a screenshot: masked, or the capture is not taken. */
const MASKED_SELECTOR = ['input[type=password i]', ...MASKED_TAGS.map((tag) => tag.toLowerCase())].join(', ');

/** How many password fields and nested documents in the window's document no selector mask reaches; see `unmaskableCount`. */
async function unmaskable(devtools: DevTools, window: AppWindow): Promise<number> {
  const snapshot = await devtools.snapshot(window.page);
  return snapshot === undefined ? 0 : unmaskableCount(snapshot.document, snapshot.strings);
}

/**
 * Adds the pixels to an observation of a read window: masked, and left out
 * when a secure field or nested document sits in a closed shadow root, out of
 * every selector's reach. `maskedRegionCount` says how many regions the masks
 * cover either way.
 */
export async function withPixels(devtools: DevTools, raw: RawRead, snapshot: EngineSnapshot): Promise<EngineSnapshot> {
  const { window } = raw;
  const masks = window.page.locator(MASKED_SELECTOR);
  const masked = await masks.count();
  if (unmaskableCount(raw.document, raw.strings) > 0) return { ...snapshot, maskedRegionCount: masked };
  const pixels = await capturePixels(devtools, window, masks);
  // The app may have rendered such an element while the capture ran, inside a closed shadow root or beside the masks
  // already placed: read the document again before the pixels go out.
  if ((await unmaskable(devtools, window)) > 0 || (await masks.count()) > masked) return { ...snapshot, maskedRegionCount: masked };
  return { ...snapshot, pixels, maskedRegionCount: masked };
}

/** A CSS-scale screenshot of the window with the masks painted over. */
async function capturePixels(devtools: DevTools, window: AppWindow, masks: Locator): Promise<ObservationPixels> {
  const data = new Uint8Array(await window.page.screenshot({ scale: 'css', mask: [masks], maskColor: '#000000', caret: 'hide', animations: 'disabled' }));
  const { width: css } = await devtools.evaluate(window.page, viewportSize);
  const size = readPngSize(data);
  if (size === undefined) throw new Error('the window capture is not a PNG');
  return { data, mediaType: 'image/png', width: size.width, height: size.height, scale: css > 0 ? size.width / css : 1 };
}

/**
 * `app.screenshot(label)`: the window with its masks painted over, written
 * under the attempt's artifacts as `screenshots/<n>-<label>.png`. Refused
 * with `POLICY_DENIED` when the window holds a password field or nested
 * document no mask reaches, before or after the capture.
 */
export async function screenshotFile(devtools: DevTools, window: AppWindow, artifactsDir: string, name: string): Promise<string> {
  const relative = path.posix.join('screenshots', name);
  const absolute = path.join(artifactsDir, relative);
  const withheld = (count: number): ConfigurationError =>
    new ConfigurationError(
      'POLICY_DENIED',
      `the window shows ${count} password field${count === 1 ? '' : 's'} or nested document${count === 1 ? '' : 's'} inside a closed shadow root, which no mask reaches, so the screenshot is withheld`,
    );
  const before = await unmaskable(devtools, window);
  if (before > 0) throw withheld(before);
  const masks = window.page.locator(MASKED_SELECTOR);
  const masked = await masks.count();
  // Animations stopped, so a moving field stays under the mask measured for it.
  const image = await window.page.screenshot({ mask: [masks], maskColor: '#000000', caret: 'hide', animations: 'disabled' });
  // The app may have rendered such an element while the capture ran: the file is written only once the document still has none.
  const after = await unmaskable(devtools, window);
  if (after > 0) throw withheld(after);
  if ((await masks.count()) > masked) {
    throw new ConfigurationError('POLICY_DENIED', 'a password field or nested document appeared while the screenshot was taken, after its masks were placed, so the screenshot is withheld');
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, image);
  return relative;
}

/** A screenshot's file name: its number in the attempt and a label that cannot turn into a path (letters, digits, dashes). */
export function screenshotName(counter: number, label: string | undefined): string {
  const safe = label === undefined ? '' : label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${String(counter).padStart(3, '0')}${safe === '' ? '' : `-${safe}`}.png`;
}
