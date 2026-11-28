import { describe, expect, it } from 'vitest';
import { isPromiseLike } from '@e2e-dev/core/lib/internal/promise-like';

describe('isPromiseLike', () => {
  it('accepts a Promise and any object or function with a callable then', () => {
    expect(isPromiseLike(Promise.resolve(1))).toBe(true);
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable that is not a Promise is the case under test
    expect(isPromiseLike({ then: () => {} })).toBe(true);
    // oxlint-disable-next-line unicorn/no-thenable -- a function that is a thenable is the case under test
    expect(isPromiseLike(Object.assign(() => {}, { then: () => {} }))).toBe(true);
  });

  it('rejects values without a callable then', () => {
    // oxlint-disable-next-line unicorn/no-thenable -- a then that is not callable is the case under test
    for (const value of [null, undefined, 0, 'then', {}, { then: 1 }, () => {}]) {
      expect(isPromiseLike(value)).toBe(false);
    }
  });
});
