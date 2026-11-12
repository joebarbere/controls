import type { PositionMm } from '../types';

/*
 * `route-collides` (ADR 0015): a straight segment through a device body, until F3.2 part 1's router
 * replaces straight segments. Bodies are boxes in world integer mm: an axis-aligned device's own box
 * rotated by quarter-turns (exact), and for any other orientation the conservative cube centred on its
 * position with half-side `ceil(√(w² + h² + d²))` (no trigonometry). A segment collides when it passes
 * through the box's **open** interior, so a route that only touches a face (a terminal's entry point on
 * the body's surface) doesn't.
 *
 * D6: only `+ − × ÷`, `Math.sqrt`, `min`/`max`/`ceil`. Each slab parameter is a quotient of integers,
 * correctly rounded in every engine, so the answer is the same in Node and Chromium.
 */

/** An axis-aligned box in world integer mm, `min < max` on each axis. */
export interface BoxMm {
  readonly min: PositionMm;
  readonly max: PositionMm;
}

/** The conservative cube for a body of size `w × h × d` at `position` (any orientation). */
export function conservativeCube(position: PositionMm, size: { w: number; h: number; d: number }): BoxMm {
  const half = Math.ceil(Math.sqrt(size.w * size.w + size.h * size.h + size.d * size.d));
  return {
    min: { x: position.x - half, y: position.y - half, z: position.z - half },
    max: { x: position.x + half, y: position.y + half, z: position.z + half },
  };
}

/** The box spanned by two opposite corners (any order). */
export function boxFromCorners(p: PositionMm, q: PositionMm): BoxMm {
  return {
    min: { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), z: Math.min(p.z, q.z) },
    max: { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y), z: Math.max(p.z, q.z) },
  };
}

const AXES = ['x', 'y', 'z'] as const;

/** Whether the segment from `p` to `q` passes through the open interior of `box` (slab test). */
export function segmentCrossesBox(p: PositionMm, q: PositionMm, box: BoxMm): boolean {
  let enter = 0;
  let exit = 1;
  for (const axis of AXES) {
    const lo = box.min[axis];
    const hi = box.max[axis];
    const from = p[axis];
    const d = q[axis] - from;
    if (d === 0) {
      if (from <= lo || from >= hi) return false;
      continue;
    }
    const t1 = (lo - from) / d;
    const t2 = (hi - from) / d;
    enter = Math.max(enter, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
    if (enter >= exit) return false;
  }
  return enter < exit;
}
