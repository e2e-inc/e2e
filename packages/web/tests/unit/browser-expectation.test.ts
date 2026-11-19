/**
 * The step label of a `toHaveJSProperty` expected value, built before the
 * matcher validates the value, so a value the matcher refuses still has one.
 */

import { describe, expect, it } from 'vitest';
import { expectedLabel } from '../../src/browser-expectation.ts';

describe('expectedLabel', () => {
  it('writes a JSON value as JSON', () => {
    expect(expectedLabel({ mode: 'dark', sizes: [1, 2] })).toBe('{"mode":"dark","sizes":[1,2]}');
    expect(expectedLabel('open')).toBe('"open"');
  });

  it('writes a value JSON.stringify drops or turns into null as its own text', () => {
    expect(expectedLabel(undefined)).toBe('undefined');
    expect(expectedLabel(Number.NaN)).toBe('NaN');
    expect(expectedLabel(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('names a value JSON.stringify refuses', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(expectedLabel(1n)).toBe('a value that is not JSON');
    expect(expectedLabel(cyclic)).toBe('a value that is not JSON');
  });
});
