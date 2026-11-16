import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@e2e-dev/core/engine';
import { jsonEqual } from '../../src/json-equal.ts';

describe('jsonEqual', () => {
  it.each<[JsonValue, JsonValue]>([
    [240, 240],
    [0, -0],
    ['sticky', 'sticky'],
    [null, null],
    [true, true],
    [[1, [2, 'b']], [1, [2, 'b']]],
    [{ a: 1, b: { c: [null] } }, { b: { c: [null] }, a: 1 }],
    [{}, {}],
  ])('equates %j and %j', (a, b) => {
    expect(jsonEqual(a, b)).toBe(true);
  });

  it.each<[JsonValue, JsonValue]>([
    [240, '240'],
    [null, 0],
    [false, 0],
    [[1, 2], [2, 1]],
    [[1], [1, 1]],
    [[], {}],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: 2 }, { a: 1, c: 2 }],
    [{ a: null }, {}],
    [{ a: [1] }, { a: [2] }],
  ])('tells %j from %j', (a, b) => {
    expect(jsonEqual(a, b)).toBe(false);
    expect(jsonEqual(b, a)).toBe(false);
  });

  it('tells an own __proto__ key from another key, though the other object inherits __proto__', () => {
    // oxlint-disable-next-line e2e/no-unchecked-json -- a literal, parsed the way a page result is
    const parsed = JSON.parse('{"__proto__":{}}') as JsonValue;
    expect(jsonEqual(parsed, { y: {} })).toBe(false);
    expect(jsonEqual({ y: {} }, parsed)).toBe(false);
  });
});
