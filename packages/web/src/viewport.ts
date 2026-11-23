/**
 * The `{ width, height }` sizes the engine takes in whole pixels:
 * `web({ viewport })` and `web({ screencast: { size } })` at config load, and
 * `browser.setViewport()` during a test. One rule for all three; each caller
 * picks the smallest side and the error code.
 */

import { ConfigurationError, rejectUnknownKeys, TestError } from '@e2e-dev/core/engine';
import { describe, isPlainObject } from './support.ts';

/** A width and height in whole pixels. */
export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

const SIDES = ['width', 'height'] as const;

/**
 * `size` read once as `{ width, height }` in whole pixels, each at least `min`,
 * with no other key. Anything else throws `code`, naming the size as `where`.
 */
export function pixelSize(
  where: string,
  size: unknown,
  { min, code }: { readonly min: number; readonly code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT' },
): PixelSize {
  const refuse = (message: string): Error => (code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message));
  const usage = `${where} must be { width, height } in whole pixels, each at least ${min}`;
  if (!isPlainObject(size)) throw refuse(`${usage}, got ${describe(size)}`);
  rejectUnknownKeys(where, size, SIDES, code);
  const side = (name: (typeof SIDES)[number]): number => {
    const pixels: unknown = Reflect.get(size, name);
    if (typeof pixels === 'number' && Number.isInteger(pixels) && pixels >= min) return pixels;
    throw refuse(`${usage}, got ${name} ${describe(pixels)}`);
  };
  return { width: side('width'), height: side('height') };
}
