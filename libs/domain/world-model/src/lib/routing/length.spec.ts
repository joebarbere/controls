import fc from 'fast-check';
import { boxFromCorners, conservativeCube, segmentCrossesBox } from './collide';
import { routeFloorMm } from './floor';
import {
  DEFAULT_CABLE_TAIL_MM,
  defaultTailsMm,
  ROUTE_SLACK_PERCENT,
  routeDefaultLengthMm,
  routeSlackMm,
} from './length';

const p = (x: number, y: number, z: number) => ({ x, y, z });
const coordinate = fc.integer({ min: -10_000_000, max: 10_000_000 });
const pointArb = fc.record({ x: coordinate, y: coordinate, z: coordinate });

describe('routeDefaultLengthMm (ADR 0015, "The length rule")', () => {
  it('is the floor plus the slack plus the tails, in whole millimetres', () => {
    const points = [p(0, 0, 0), p(3000, 0, 0), p(3000, 4000, 0)];
    expect(routeFloorMm(points)).toBe(7000);
    expect(ROUTE_SLACK_PERCENT).toBe(5);
    expect(routeDefaultLengthMm(points)).toBe(7350);
    expect(routeDefaultLengthMm(points, 5, { a: 200, b: 0 })).toBe(7550);
    expect(routeSlackMm(1)).toBe(1);
    expect(routeSlackMm(0)).toBe(0);
  });

  it('is never below the floor (property)', () => {
    fc.assert(
      fc.property(fc.array(pointArb, { minLength: 2, maxLength: 12 }), (points) => {
        const floor = routeFloorMm(points);
        const length = routeDefaultLengthMm(points);
        expect(Number.isSafeInteger(length)).toBe(true);
        expect(length).toBeGreaterThanOrEqual(floor);
      }),
    );
  });

  it('default tails: 200 mm at an end in an entry, none at a free end', () => {
    expect(DEFAULT_CABLE_TAIL_MM).toBe(200);
    expect(defaultTailsMm({ a: { entity: 1, entry: 'top' }, b: null })).toStrictEqual({ a: 200, b: 0 });
  });
});

describe('segmentCrossesBox (route-collides)', () => {
  const box = boxFromCorners(p(10, 10, 10), p(0, 0, 0));

  it('collides only through the open interior: touching a face or an edge is clear', () => {
    expect(segmentCrossesBox(p(-5, 5, 5), p(15, 5, 5), box)).toBe(true);
    expect(segmentCrossesBox(p(5, 5, 5), p(5, 5, 50), box)).toBe(true); // starts inside
    expect(segmentCrossesBox(p(-5, 10, 5), p(15, 10, 5), box)).toBe(false); // along the top face
    expect(segmentCrossesBox(p(5, 10, 5), p(5, 50, 5), box)).toBe(false); // leaves from the face
    expect(segmentCrossesBox(p(-5, -5, 5), p(15, 15, 5), box)).toBe(true); // diagonal through
    expect(segmentCrossesBox(p(-10, 0, 5), p(0, 10, 5), box)).toBe(false); // through the corner edge only
    expect(segmentCrossesBox(p(-5, 5, 5), p(-1, 5, 5), box)).toBe(false); // stops short
  });

  it('the conservative cube contains the body at any orientation', () => {
    expect(conservativeCube(p(0, 0, 0), { w: 3, h: 4, d: 12 })).toStrictEqual({
      min: p(-13, -13, -13),
      max: p(13, 13, 13),
    });
  });

  it('is symmetric in the segment direction (property)', () => {
    fc.assert(
      fc.property(pointArb, pointArb, (a, b) => {
        const big = boxFromCorners(p(-1000, -1000, -1000), p(1000, 1000, 1000));
        expect(segmentCrossesBox(a, b, big)).toBe(segmentCrossesBox(b, a, big));
      }),
    );
  });
});
