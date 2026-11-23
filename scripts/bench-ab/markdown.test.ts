import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration } from './markdown.ts';

describe('duration', () => {
  it('rounds before choosing ms or s, so 999.6 ms reads 1.00 s', () => {
    assert.equal(duration(999.4), '999 ms');
    assert.equal(duration(999.6), '1.00 s');
    assert.equal(duration(1_234), '1.23 s');
    assert.equal(duration(Number.NaN), '-');
  });
});
