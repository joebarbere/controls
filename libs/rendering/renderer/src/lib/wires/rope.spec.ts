import { ROPE_TUNING, VerletRope, type RopePoint } from './rope';

const settle = (rope: VerletRope): number => {
  let frames = 0;
  while (rope.step()) frames++;
  return frames;
};
const points = (rope: VerletRope) => Array.from({ length: rope.count }, (_, i) => [rope.x(i), rope.y(i), rope.z(i)]);
const lowest = (rope: VerletRope) => Math.min(...points(rope).map((p) => p[1]));

const SPAN: RopePoint[] = [
  { x: 0, y: 0, z: 0 },
  { x: 300, y: 0, z: 0 },
];

describe('VerletRope (the live preview)', () => {
  it('subdivides each span at the 15 mm spacing, pinned at every given point', () => {
    const rope = new VerletRope();
    rope.setPins([...SPAN, { x: 300, y: -100, z: 0 }]);
    expect(rope.count).toBe(20 + 7 + 1);
    expect([0, 20, 27].every((i) => rope.isPinned(i))).toBe(true);
    expect(points(rope).filter((_, i) => rope.isPinned(i))).toStrictEqual([
      [0, 0, 0],
      [300, 0, 0],
      [300, -100, 0],
    ]);
  });

  it('sags under gravity by about the bake’s 1 % slack, then settles and stops asking for frames', () => {
    const rope = new VerletRope();
    rope.setPins(SPAN);
    expect(rope.settled).toBe(false);
    const frames = settle(rope);
    expect(rope.settled).toBe(true);
    expect(frames).toBeLessThan(ROPE_TUNING.maxFrames);
    // The bake's parabola for 1 % extra on 300 mm: √(3 · 300 · 3 / 8) ≈ 18.4 mm (ADR 0017 §7).
    const sag = -lowest(rope);
    expect(sag).toBeGreaterThan(15); // measured 21.6 (a 20-link chain with tethers, not the parabola)
    expect(sag).toBeLessThan(25);
    // The pins never move.
    expect([rope.x(0), rope.y(0), rope.x(rope.count - 1), rope.y(rope.count - 1)]).toStrictEqual([0, 0, 300, 0]);
    expect(rope.step()).toBe(false);
  });

  it('is a pure function of its pins and the number of frames (no clock, no randomness)', () => {
    const a = new VerletRope();
    const b = new VerletRope();
    a.setPins(SPAN);
    b.setPins(SPAN);
    for (let i = 0; i < 37; i++) {
      a.step();
      b.step();
    }
    expect(points(a)).toStrictEqual(points(b));
  });

  it('keeps its shape when the cursor pin moves (no pop back to straight)', () => {
    const rope = new VerletRope();
    rope.setPins(SPAN);
    settle(rope);
    const before = lowest(rope);
    rope.setPins([SPAN[0], { x: 310, y: 0, z: 0 }]);
    expect(rope.settled).toBe(false);
    // Straight after the move would be 0; it starts from the old sag laid on the new chord.
    expect(lowest(rope)).toBeCloseTo(before, 0);
    // Unchanged pins are a no-op: still settling from where it was.
    const frames = rope.frames;
    rope.setPins([SPAN[0], { x: 310, y: 0, z: 0 }]);
    expect(rope.frames).toBe(frames);
  });

  it('caps the particle count on a long preview by widening the spacing', () => {
    const rope = new VerletRope();
    rope.setPins([
      { x: 0, y: 0, z: 0 },
      { x: 100_000, y: 0, z: 0 },
      { x: 100_000, y: 0, z: 100_000 },
    ]);
    expect(rope.count).toBeLessThanOrEqual(ROPE_TUNING.maxParticles);
    expect(rope.count).toBeGreaterThan(ROPE_TUNING.maxParticles / 2);
  });

  it('fewer than two pins draw nothing', () => {
    const rope = new VerletRope();
    rope.setPins(SPAN);
    rope.setPins([SPAN[0]]);
    expect(rope.count).toBe(0);
    expect(rope.settled).toBe(true);
    expect(rope.step()).toBe(false);
  });
});
