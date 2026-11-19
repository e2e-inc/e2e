import { describe, expect, it } from 'vitest';
import { parseModifierCall } from '../../src/internal/skip.ts';

const runtime = (condition: boolean, reason?: string) => ({ kind: 'runtime', condition, reason });

describe('parseModifierCall', () => {
  it('registers a test for a title and a body', () => {
    const fn = () => {};
    expect(parseModifierCall(['later', fn])).toEqual({ kind: 'register', title: 'later', fn });
  });

  it('skips always in the reason form: no argument, or a lone string or undefined', () => {
    expect(parseModifierCall([])).toEqual(runtime(true));
    expect(parseModifierCall([undefined])).toEqual(runtime(true));
    expect(parseModifierCall(['waiting on the API'])).toEqual(runtime(true, 'waiting on the API'));
  });

  it('reads the first argument as a condition by truthiness, as Playwright does', () => {
    for (const falsy of [undefined, null, false, 0, '', Number.NaN]) {
      expect(parseModifierCall([falsy, 'flaky on CI'])).toEqual(runtime(false, 'flaky on CI'));
      if (falsy !== undefined && typeof falsy !== 'string') expect(parseModifierCall([falsy])).toEqual(runtime(false));
    }
    for (const truthy of [true, 1, 'true', {}]) {
      expect(parseModifierCall([truthy, 'flaky on CI'])).toEqual(runtime(true, 'flaky on CI'));
    }
    expect(parseModifierCall([1])).toEqual(runtime(true));
  });

  it('takes the reason from the second argument only', () => {
    expect(parseModifierCall(['1', 'the real reason'])).toEqual(runtime(true, 'the real reason'));
    expect(parseModifierCall([true, 42])).toEqual(runtime(true));
    expect(parseModifierCall([undefined, undefined])).toEqual(runtime(false));
  });
});
