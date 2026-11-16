import fc from 'fast-check';
import {
  emptySegmentHit,
  rayToSegment,
  SegmentBvh,
  type SegmentRayHit,
  WIRE_PICK_MIN_RADIUS_PX,
  WIRE_PICK_SCREEN_STEP_PX,
} from './segment-bvh';

/** One CSS px per mm of depth for a 45° vertical fov on a 720 px canvas: 2 tan(22.5°) / 720. */
const PX_ANGLE = (2 * Math.tan(Math.PI / 8)) / 720;

const bvh = (segments: readonly (readonly [number, number, number, number, number, number])[], radius = 0.8) => {
  const b = new SegmentBvh();
  b.build(
    segments.flat(),
    segments.map(() => radius),
    segments.length,
  );
  return b;
};

/** A ray straight down −z from (x, y, 1000). */
const down = (b: SegmentBvh, x: number, y: number, out: SegmentRayHit = emptySegmentHit()) => {
  b.raycast(x, y, 1000, 0, 0, -1, PX_ANGLE, out);
  return out;
};

describe('rayToSegment', () => {
  it('closest approach: across, beyond an end, behind the origin', () => {
    const out = { s: 0, d2: 0 };
    rayToSegment(0, 0, 10, 0, 0, -1, -5, 2, 0, 5, 2, 0, out);
    expect(out).toStrictEqual({ s: 10, d2: 4 });
    rayToSegment(0, 0, 10, 0, 0, -1, 3, 4, 0, 9, 4, 0, out); // nearest end (3, 4, 0)
    expect(out.s).toBeCloseTo(10, 12);
    expect(out.d2).toBeCloseTo(25, 12);
    rayToSegment(0, 0, 10, 0, 0, 1, -5, 0, 0, 5, 0, 0, out); // pointing away: the origin itself
    expect(out).toStrictEqual({ s: 0, d2: 100 });
    rayToSegment(0, 0, 10, 0, 0, -1, 1, 1, 0, 1, 1, 0, out); // a point
    expect(out).toStrictEqual({ s: 10, d2: 2 });
    rayToSegment(1, 0, 10, 0, 0, -1, 0, 0, 0, 0, 0, 20, out); // parallel: s from the near end
    expect(out.d2).toBeCloseTo(1, 12);
  });

  it('property: no sampled pair of points is closer than the reported approach', () => {
    const v = fc.integer({ min: -200, max: 200 });
    fc.assert(
      fc.property(fc.tuple(v, v, v), fc.tuple(v, v, v), fc.tuple(v, v, v), fc.tuple(v, v, v), (o, dir, a, b) => {
        const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
        if (len === 0) return;
        const d = dir.map((c) => c / len);
        const out = { s: 0, d2: 0 };
        rayToSegment(o[0], o[1], o[2], d[0], d[1], d[2], a[0], a[1], a[2], b[0], b[1], b[2], out);
        expect(out.s).toBeGreaterThanOrEqual(0);
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          const q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
          const w = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
          const s = Math.max(0, w[0] * d[0] + w[1] * d[1] + w[2] * d[2]);
          const p = [o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]];
          const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          expect(out.d2).toBeLessThanOrEqual(d2 + 1e-6 * (1 + d2));
        }
      }),
    );
  });
});

describe('SegmentBvh (ADR 0017 §9)', () => {
  it('widens a thin wire to 4 px on screen, and no further', () => {
    const b = bvh([[-50, 0, 0, 50, 0, 0]]);
    const px = PX_ANGLE * 1000; // mm per px at the wire's depth
    expect(down(b, 0, 0.5)).toMatchObject({ segment: 0, exact: true, offsetMm: 0.5 });
    const near = down(b, 0, 3.9 * px);
    expect(near).toMatchObject({ segment: 0, exact: false });
    expect(near.offsetPx).toBeCloseTo(3.9, 9);
    expect(down(b, 0, 4.1 * px).segment).toBe(-1);
    // A fat conductor's own radius is the target when it is wider than 4 px.
    const fat = bvh([[-50, 0, 0, 50, 0, 0]], 10 * px);
    expect(down(fat, 0, 9 * px)).toMatchObject({ segment: 0, exact: true });
    expect(WIRE_PICK_MIN_RADIUS_PX).toBe(4);
  });

  it('ranks a real hit over a widened one, the nearer real hit first, else the nearest centreline on screen', () => {
    const px = PX_ANGLE * 1000;
    const b = bvh([
      [-50, 0, 0, 50, 0, 0], // 0: at depth 1000
      [-50, 0.4, 100, 50, 0.4, 100], // 1: in front, through the same pixel
      [-50, 2 * px, 0, 50, 2 * px, 0], // 2: 2 px off at depth 1000
    ]);
    expect(down(b, 0, 0)).toMatchObject({ segment: 1, exact: true }); // both real: the front one
    // 1.2 px off both 0 and 2 (and 1.4 px off 1 at its depth): no real hit, the nearest centreline on screen.
    expect(down(b, 0, 3.2 * px).segment).toBe(2);
    expect(down(b, 0, -0.9).segment).toBe(0);
  });

  it('wires lined up along the ray (a cable’s tails end-on): the front one, on it or beside it, in any order', () => {
    const px = PX_ANGLE * 1000;
    // Three tails 2.6 mm apart in depth, straight up at x = 0, seen from z = 1000 (the bottom knockout's
    // three conductors seen head-on, F3.2 part 4). Bake order front-last, as a cable's tails are.
    const tails: [number, number, number, number, number, number][] = [
      [0, -100, -5.2, 0, 100, -5.2],
      [0, -100, -2.6, 0, 100, -2.6],
      [0, -100, 0, 0, 100, 0],
    ];
    for (const order of [tails, [...tails].reverse(), [tails[1], tails[0], tails[2]]]) {
      const b = bvh(order);
      const front = order.indexOf(tails[2]);
      expect(down(b, 0.3, 0)).toMatchObject({ segment: front, exact: true });
      // Beside them (widened only), their screen distances differ by rounding only: still the front one.
      for (const offset of [1.3, 2.2, 3.6])
        expect(down(b, offset * px, 7)).toMatchObject({ segment: front, exact: false });
    }
    // A quarter pixel or more nearer on screen still wins over a wire in front.
    const b = bvh([
      [0.5 * px, -100, -50, 0.5 * px, 100, -50],
      [0, -100, 0, 0, 100, 0],
    ]);
    expect(down(b, 3 * px, 0).segment).toBe(0);
    expect(WIRE_PICK_SCREEN_STEP_PX).toBe(0.25);
  });

  it('property: the BVH answers exactly what testing every segment answers, for any ray', () => {
    const step = (offsetPx: number) => Math.floor(offsetPx / 0.25);
    const c = fc.integer({ min: -300, max: 300 });
    const segment = fc.tuple(c, c, c, c, c, c);
    const o = fc.integer({ min: -1000, max: 1000 });
    const d = fc.integer({ min: -100, max: 100 });
    // A unit direction (the zero vector, rare, becomes straight down: mapped, never filtered).
    const direction = fc.tuple(d, d, d).map(([x, y, z]) => {
      const len = Math.sqrt(x * x + y * y + z * z);
      return len === 0 ? ([0, 0, -1] as const) : ([x / len, y / len, z / len] as const);
    });
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 60 }),
        fc.tuple(o, o, o),
        direction,
        fc.integer({ min: 1, max: 30 }),
        (segments, [x, y, z], [dx, dy, dz], r10) => {
          const radius = r10 / 10;
          const b = bvh(segments, radius);
          const got = emptySegmentHit();
          b.raycast(x, y, z, dx, dy, dz, PX_ANGLE, got);
          // Reference: every segment with the module's ranking.
          let best: SegmentRayHit = emptySegmentHit();
          const out = { s: 0, d2: 0 };
          segments.forEach((s, i) => {
            rayToSegment(x, y, z, dx, dy, dz, ...s, out);
            const widened = Math.max(radius, WIRE_PICK_MIN_RADIUS_PX * PX_ANGLE * out.s);
            if (out.d2 > widened * widened) return;
            const offset = Math.sqrt(out.d2);
            const hit = {
              segment: i,
              depthMm: out.s,
              offsetMm: offset,
              offsetPx: out.s > 0 ? offset / (PX_ANGLE * out.s) : 0,
              exact: out.d2 <= radius * radius,
            };
            const better =
              best.segment < 0 ||
              (hit.exact !== best.exact
                ? hit.exact
                : hit.exact
                  ? hit.depthMm < best.depthMm || (hit.depthMm === best.depthMm && i < best.segment)
                  : step(hit.offsetPx) < step(best.offsetPx) ||
                    (step(hit.offsetPx) === step(best.offsetPx) &&
                      (hit.depthMm < best.depthMm || (hit.depthMm === best.depthMm && i < best.segment))));
            if (better) best = hit;
          });
          expect(got).toStrictEqual(best);
        },
      ),
    );
  });

  it('is empty before a build, after clear(), and for zero segments', () => {
    const b = new SegmentBvh();
    expect(down(b, 0, 0).segment).toBe(-1);
    b.build([0, 0, 0, 10, 0, 0], [1], 1);
    expect(b.size).toBe(1);
    expect(down(b, 5, 0).segment).toBe(0);
    b.clear();
    expect(b.size).toBe(0);
    expect(down(b, 5, 0).segment).toBe(-1);
    b.build([], [], 0);
    expect(down(b, 5, 0).segment).toBe(-1);
  });

  it('indexes 35 000 segments (500 wires of about 70) and picks with no allocation growth', () => {
    const n = 35_000;
    const points = new Float64Array(6 * n);
    for (let i = 0; i < n; i++) {
      const w = Math.floor(i / 70);
      const k = i % 70;
      points.set([k * 15, w * 3, 0, (k + 1) * 15, w * 3, 0], 6 * i);
    }
    const b = new SegmentBvh();
    b.build(points, new Float64Array(n).fill(0.8), n);
    const out = emptySegmentHit();
    expect(down(b, 7.5 * 15, 3 * 250 + 0.2, out)).toMatchObject({ segment: 250 * 70 + 7, exact: true });
    for (let i = 0; i < 1000; i++) down(b, (i % 70) * 15 + 1, (i % 500) * 3, out);
    expect(out.segment).toBe(499 * 70 + (999 % 70));
  });
});
