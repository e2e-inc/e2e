import { describe, expect, it } from 'vitest';
import { placeBoxInFrame } from '../../src/observation.ts';

const FRAME = { x: 40, y: 30, width: 300, height: 150 };

describe('placeBoxInFrame', () => {
  it('shifts a box inside the frame, with no origin when its corner is its own', () => {
    expect(placeBoxInFrame({ x: 10, y: 20, width: 50, height: 40 }, undefined, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
    });
  });

  it('shifts a bordered node origin with its box', () => {
    expect(placeBoxInFrame({ x: 10, y: 20, width: 50, height: 40 }, { x: 18, y: 28 }, FRAME)).toEqual({
      rect: { x: 50, y: 50, width: 50, height: 40 },
      origin: { x: 58, y: 58 },
    });
  });

  it('keeps the unclipped corner as the origin of a box the frame clips', () => {
    expect(placeBoxInFrame({ x: 0, y: -125, width: 200, height: 400 }, undefined, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 40, y: -95 },
    });
  });

  it('keeps a bordered origin unclipped when the frame clips the box', () => {
    expect(placeBoxInFrame({ x: 0, y: -125, width: 200, height: 400 }, { x: 1, y: -124 }, FRAME)).toEqual({
      rect: { x: 40, y: 30, width: 200, height: 150 },
      origin: { x: 41, y: -94 },
    });
  });

  it('drops the box and origin of a node outside the frame', () => {
    expect(placeBoxInFrame({ x: 0, y: 400, width: 20, height: 20 }, { x: 1, y: 401 }, FRAME)).toEqual({});
  });

  it('cuts the box to the part of the frame an outer frame shows, keeping the corner as the origin', () => {
    const shown = { x: 40, y: 30, width: 100, height: 150 };
    expect(placeBoxInFrame({ x: 50, y: 10, width: 200, height: 40 }, undefined, FRAME, shown)).toEqual({
      rect: { x: 90, y: 40, width: 50, height: 40 },
    });
    expect(placeBoxInFrame({ x: -20, y: 10, width: 200, height: 40 }, undefined, FRAME, shown)).toEqual({
      rect: { x: 40, y: 40, width: 100, height: 40 },
      origin: { x: 20, y: 40 },
    });
  });

  it('cuts the box at the bottom and top of the part an outer frame shows', () => {
    const shown = { x: 40, y: 80, width: 300, height: 60 };
    expect(placeBoxInFrame({ x: 10, y: 20, width: 50, height: 200 }, { x: 12, y: 22 }, FRAME, shown)).toEqual({
      rect: { x: 50, y: 80, width: 50, height: 60 },
      origin: { x: 52, y: 52 },
    });
  });

  it('drops a box inside the frame that the outer frames do not show', () => {
    const shown = { x: 40, y: 30, width: 100, height: 150 };
    expect(placeBoxInFrame({ x: 150, y: 10, width: 50, height: 40 }, { x: 151, y: 11 }, FRAME, shown)).toEqual({});
  });
});
