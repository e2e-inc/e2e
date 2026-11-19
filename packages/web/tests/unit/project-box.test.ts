/** A box carried through a projective map: the upright bounds of where its corners land. */

import { describe, expect, it } from 'vitest';
import { IDENTITY, projectBox, rectToQuad, scaleThenTranslate } from '../../src/driver/projection.ts';

describe('projectBox', () => {
  it('leaves a box where it is under the identity', () => {
    expect(projectBox(IDENTITY, { x: 3, y: 4, width: 10, height: 20 })).toEqual({ x: 3, y: 4, width: 10, height: 20 });
  });

  it('scales and shifts a box as a frame\'s content box does', () => {
    const map = scaleThenTranslate({ x: 100, y: 50 }, { x: 2, y: 0.5 });
    expect(projectBox(map, { x: 10, y: 20, width: 30, height: 40 })).toEqual({ x: 120, y: 60, width: 60, height: 20 });
  });

  it('bounds the corners of a box a quarter turn carries', () => {
    const quarterTurn = rectToQuad(100, 100, [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }])!;
    const { x, y, width, height } = projectBox(quarterTurn, { x: 10, y: 20, width: 30, height: 40 });
    expect([x, y, width, height].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([40, 10, 40, 30]);
  });
});
