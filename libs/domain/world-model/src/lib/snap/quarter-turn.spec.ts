import fc from 'fast-check';
import { entityPointMm, isAxisAligned, QUARTER_TURN_MDEG, rotateQuarterTurns } from './quarter-turn';

/** The textbook R = Ry(yaw) · Rx(pitch) · Rz(roll) in floating point (specs only), rounded back to integers. */
function reference(o: { yaw: number; pitch: number; roll: number }, v: { x: number; y: number; z: number }) {
  const rad = (mdeg: number) => (mdeg / 180_000) * Math.PI;
  const [cy, sy, cp, sp, cr, sr] = [o.yaw, o.yaw, o.pitch, o.pitch, o.roll, o.roll].map((a, i) =>
    i % 2 === 0 ? Math.cos(rad(a)) : Math.sin(rad(a)),
  );
  const x1 = v.x * cr - v.y * sr;
  const y1 = v.x * sr + v.y * cr;
  const y2 = y1 * cp - v.z * sp;
  const z2 = y1 * sp + v.z * cp;
  return { x: Math.round(x1 * cy + z2 * sy) + 0, y: Math.round(y2) + 0, z: Math.round(-x1 * sy + z2 * cy) + 0 };
}

const quarterArb = fc.integer({ min: 0, max: 3 }).map((k) => k * QUARTER_TURN_MDEG);
const offsetArb = fc.record({
  x: fc.integer({ min: -100_000, max: 100_000 }),
  y: fc.integer({ min: -100_000, max: 100_000 }),
  z: fc.integer({ min: -100_000, max: 100_000 }),
});

describe('quarter-turn geometry (ADR 0015)', () => {
  it('knows axis-aligned orientations', () => {
    expect(isAxisAligned({ yaw: 0, pitch: 270_000, roll: 90_000 })).toBe(true);
    expect(isAxisAligned({ yaw: 45_000, pitch: 0, roll: 0 })).toBe(false);
    expect(isAxisAligned({ yaw: 0, pitch: 1, roll: 0 })).toBe(false);
    expect(rotateQuarterTurns({ yaw: 0, pitch: 0, roll: 1 }, { x: 1, y: 0, z: 0 })).toBeNull();
  });

  it('follows yaw about +y, then pitch about the new +x, then roll about the new +z (ADR 0007)', () => {
    const v = { x: 1, y: 2, z: 3 };
    expect(rotateQuarterTurns({ yaw: 90_000, pitch: 0, roll: 0 }, v)).toStrictEqual({ x: 3, y: 2, z: -1 });
    // pitch -90° stands a prop's +z up (snap/placement.ts).
    expect(rotateQuarterTurns({ yaw: 0, pitch: 270_000, roll: 0 }, { x: 0, y: 0, z: 1 })).toStrictEqual({
      x: 0,
      y: 1,
      z: 0,
    });
    expect(rotateQuarterTurns({ yaw: 0, pitch: 0, roll: 90_000 }, v)).toStrictEqual({ x: -2, y: 1, z: 3 });
  });

  it('matches the floating-point rotation for every quarter-turn triple, with exact integers and no -0 (property)', () => {
    fc.assert(
      fc.property(quarterArb, quarterArb, quarterArb, offsetArb, (yaw, pitch, roll, v) => {
        const o = { yaw, pitch, roll };
        const exact = rotateQuarterTurns(o, v);
        expect(exact).toStrictEqual(reference(o, v));
        for (const c of Object.values(exact ?? {})) expect(Object.is(c, -0)).toBe(false);
      }),
    );
  });

  it('entityPointMm adds the rotated offset to the position', () => {
    const transform = { positionMm: { x: 1000, y: 0, z: -50 }, orientationMdeg: { yaw: 180_000, pitch: 0, roll: 0 } };
    expect(entityPointMm(transform, { x: 20, y: 90, z: 20 })).toStrictEqual({ x: 980, y: 90, z: -70 });
    expect(
      entityPointMm({ ...transform, orientationMdeg: { yaw: 1, pitch: 0, roll: 0 } }, { x: 0, y: 0, z: 0 }),
    ).toBeNull();
  });
});
