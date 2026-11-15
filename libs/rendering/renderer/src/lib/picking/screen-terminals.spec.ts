import fc from 'fast-check';
import {
  groupPitchPx,
  pickScreenTerminal,
  ScreenPoints,
  TERMINAL_PICK_MAX_RADIUS_PX,
  TERMINAL_PITCH_SEARCH_PX,
} from './screen-terminals';

/** Points from `[x, y]` pairs, all on screen unless listed in `off`. */
const points = (xy: readonly (readonly [number, number])[], off: readonly number[] = []) => {
  const p = new ScreenPoints();
  p.reset(xy.length);
  xy.forEach(([x, y], i) => p.set(i, x, y, !off.includes(i)));
  p.build();
  return p;
};

const all = () => true;
/** A row of `n` terminals `pitch` px apart from (100, 100). */
const row = (n: number, pitch: number) => Array.from({ length: n }, (_, i) => [100 + i * pitch, 100] as const);

describe('pickScreenTerminal (ADR 0017 §9)', () => {
  it('picks within min(16 px, pitch / 2): ADR 0010’s 4.3 px row picks at 0, 1.1 and 1.9 px off, the neighbour past halfway', () => {
    const p = points(row(9, 4.3));
    const at = (dx: number, dy = 0) => pickScreenTerminal(p, 100 + 4 * 4.3 + dx, 100 + dy, all);
    for (const dx of [0, 1.1, 1.9, -1.9]) expect(at(dx)).toMatchObject({ hit: 4, near: 4 });
    expect(at(2.4)).toMatchObject({ hit: 5, near: 5 }); // nearer 5 than 4: never the farther one
    // Off the row by more than half the pitch: the spike's R = 12 picked something here; the pitch
    // rule picks nothing, and says which terminal is near and why (the zoom offer reads it).
    const miss = at(0, 2.2);
    expect(miss).toMatchObject({ hit: -1, near: 4 });
    expect(miss.distancePx).toBeCloseTo(2.2, 9);
    expect(miss.pitchPx).toBeCloseTo(4.3, 9);
    expect(miss.radiusPx).toBeCloseTo(2.15, 9);
  });

  it('caps the radius at 16 px where terminals are far apart', () => {
    const p = points(row(2, 200));
    expect(pickScreenTerminal(p, 100, 115.9, all)).toMatchObject({ hit: 0, radiusPx: 16, pitchPx: Infinity });
    expect(pickScreenTerminal(p, 100, 116.1, all)).toMatchObject({ hit: -1, near: -1 });
    // A neighbour 30 px away: radius 15.
    const q = points([
      [100, 100],
      [130, 100],
    ]);
    expect(pickScreenTerminal(q, 100, 114.9, all)).toMatchObject({ hit: 0, pitchPx: 30, radiusPx: 15 });
    expect(pickScreenTerminal(q, 100, 115.1, all)).toMatchObject({ hit: -1, near: 0 });
  });

  it('filters by occlusion: a hidden terminal is never picked and doesn’t shrink its neighbour’s radius', () => {
    const p = points(row(3, 10));
    const hidden = new Set([1]);
    const visible = vi.fn((i: number) => !hidden.has(i));
    // Near the hidden middle terminal: terminal 0 is 10.8 px away, beyond its 10 px radius, so nothing.
    expect(pickScreenTerminal(p, 110, 104, visible)).toMatchObject({ hit: -1, near: 0 });
    expect(visible).toHaveBeenCalledWith(1); // the nearest was asked, and was hidden
    // Next to the first one: its nearest visible neighbour is 20 px away, so the radius is 10 px.
    expect(pickScreenTerminal(p, 107, 100, visible)).toMatchObject({ hit: 0, pitchPx: 20, radiusPx: 10 });
    // With everything visible, the same point picks the middle one, 3 px away.
    expect(pickScreenTerminal(p, 107, 100, all)).toMatchObject({ hit: 1, radiusPx: 5 });
  });

  it('asks the occlusion test only near the cursor, nearest first', () => {
    const p = points(row(40, 3));
    const asked: number[] = [];
    pickScreenTerminal(p, 100 + 20 * 3 + 0.5, 100, (i) => {
      asked.push(i);
      return true;
    });
    // The nearest (20), then its nearest neighbour (21, at 3 px; ties by index would ask 19 first).
    expect(asked).toStrictEqual([20, 19]);
  });

  it('ignores terminals off screen, and breaks ties by index', () => {
    const p = points(
      [
        [100, 100],
        [110, 100],
        [105, 100],
      ],
      [2],
    );
    // Halfway between 0 and 1 (5 px each, pitch 10, radius 5): the lower index.
    expect(pickScreenTerminal(p, 105, 100, all)).toMatchObject({ hit: 0, distancePx: 5 });
    expect(p.onScreen(2)).toBe(false);
    expect(p.onScreen(-1)).toBe(false);
  });

  it('property: equals a brute-force reference, and the pick is never nearer another visible terminal', () => {
    const coordinate = fc.integer({ min: 0, max: 400 }).map((v) => v / 4);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(coordinate, coordinate, fc.boolean(), fc.boolean()), { minLength: 1, maxLength: 40 }),
        coordinate,
        coordinate,
        (terminals, cx, cy) => {
          const p = new ScreenPoints();
          p.reset(terminals.length);
          terminals.forEach(([x, y, on], i) => p.set(i, x, y, on));
          p.build();
          const visible = (i: number) => terminals[i][3];
          const got = pickScreenTerminal(p, cx, cy, visible);
          // Reference: every visible on-screen terminal, sorted by (distance, index).
          const live = terminals
            .map(([x, y, on, vis], i) => ({ i, x, y, ok: on && vis }))
            .flatMap((t) => (t.ok ? [t] : []));
          const dist = (a: { x: number; y: number }, x: number, y: number) =>
            Math.sqrt((a.x - x) * (a.x - x) + (a.y - y) * (a.y - y));
          const nearest = [...live]
            .map((t) => ({ t, d: dist(t, cx, cy) }))
            .sort((a, b) => a.d - b.d || a.t.i - b.t.i)[0];
          if (!nearest || nearest.d > TERMINAL_PICK_MAX_RADIUS_PX) {
            expect(got.near).toBe(-1);
            expect(got.hit).toBe(-1);
            return;
          }
          expect(got.near).toBe(nearest.t.i);
          const pitch = Math.min(
            ...live
              .filter((t) => t.i !== nearest.t.i)
              .map((t) => dist(t, nearest.t.x, nearest.t.y))
              .filter((d) => d <= TERMINAL_PITCH_SEARCH_PX),
          );
          expect(got.pitchPx).toBe(pitch);
          const hit = nearest.d <= Math.min(TERMINAL_PICK_MAX_RADIUS_PX, pitch / 2);
          expect(got.hit).toBe(hit ? nearest.t.i : -1);
          if (hit)
            for (const t of live) if (t.i !== got.hit) expect(dist(t, cx, cy)).toBeGreaterThanOrEqual(got.distancePx);
        },
      ),
    );
  });
});

describe('groupPitchPx', () => {
  it('is the least nearest-neighbour distance of a group’s on-screen terminals, other devices included', () => {
    // Device A: 0 and 1 (40 px apart); device B: 2, 6 px right of 1.
    const p = points([
      [100, 100],
      [100, 140],
      [106, 140],
      [400, 400],
    ]);
    expect(groupPitchPx(p, 0, 2)).toBe(6);
    expect(groupPitchPx(p, 0, 1)).toBe(40);
    expect(groupPitchPx(p, 3, 4)).toBe(Infinity);
    expect(groupPitchPx(points(row(2, 10), [0, 1]), 0, 2)).toBe(Infinity);
  });

  it('reuses its storage: a smaller set after a larger one keeps working', () => {
    const p = new ScreenPoints();
    p.reset(100);
    for (let i = 0; i < 100; i++) p.set(i, i * 7, 0, true);
    p.build();
    expect(p.count).toBe(100);
    p.reset(2);
    p.set(0, 0, 0, true);
    p.set(1, 20, 0, true);
    p.build();
    expect(groupPitchPx(p, 0, 1)).toBe(20);
    expect(p.within(10, 0, 48).count).toBe(2);
  });
});
