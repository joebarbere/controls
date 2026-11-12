import fc from 'fast-check';
import { coversChord, routeFloorMm } from './floor';

const p = (x: number, y: number, z: number) => ({ x, y, z });

describe('routeFloorMm and coversChord (ADR 0015, the length rule)', () => {
  it('sums the straight segments and rounds up to a millimetre', () => {
    expect(routeFloorMm([])).toBe(0);
    expect(routeFloorMm([p(5, 5, 5)])).toBe(0);
    expect(routeFloorMm([p(0, 0, 0), p(3, 4, 0)])).toBe(5);
    expect(routeFloorMm([p(0, 0, 0), p(1, 1, 0)])).toBe(2); // √2 ≈ 1.414
    expect(routeFloorMm([p(0, 0, 0), p(3, 4, 0), p(3, 4, 12)])).toBe(17);
    expect(routeFloorMm([p(-10_000_000, -10_000_000, -10_000_000), p(10_000_000, 10_000_000, 10_000_000)])).toBe(
      34_641_017,
    );
  });

  it('compares the chord exactly as integers: L² ≥ d²', () => {
    expect(coversChord(5, p(0, 0, 0), p(3, 4, 0))).toBe(true);
    expect(coversChord(4, p(0, 0, 0), p(3, 4, 0))).toBe(false);
    // √671150 ≈ 819.24: 820 covers it, 819 doesn't.
    expect(coversChord(820, p(50, 1150, -1800), p(120, 345, -1935))).toBe(true);
    expect(coversChord(819, p(50, 1150, -1800), p(120, 345, -1935))).toBe(false);
  });

  it('the floor covers the chord between its ends (property)', () => {
    const point = fc.record({
      x: fc.integer({ min: -10_000_000, max: 10_000_000 }),
      y: fc.integer({ min: -10_000_000, max: 10_000_000 }),
      z: fc.integer({ min: -10_000_000, max: 10_000_000 }),
    });
    fc.assert(
      fc.property(fc.array(point, { minLength: 2, maxLength: 6 }), (points) => {
        const floor = routeFloorMm(points);
        expect(Number.isSafeInteger(floor)).toBe(true);
        expect(coversChord(floor, points[0], points.at(-1) ?? points[0])).toBe(true);
      }),
    );
  });
});
