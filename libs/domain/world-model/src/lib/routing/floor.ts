import type { PositionMm } from '../types';

/*
 * The length floor (ADR 0015, "The length rule"): the shortest a conductor or cable cut to `lengthMm`
 * can be and still follow its route. Shared by the load check (`checkWorldReferences`, world v3) and,
 * from the wiring commands on, by the command (`too-short`) and every surface that fills in a length
 * (ADR 0017's `routeDefaultLengthMm` is never below it). **Its point set is save format from v0.4.0**
 * (terminal entry points and waypoints only, no lead-outs, lanes or tunable constants): changing it
 * changes which logged commands replay.
 *
 * Integer inputs, and only `+ − ×` and `Math.sqrt` (correctly rounded in every engine, decision D6),
 * so the result is the same in Node and Chromium.
 */

/** `ceil(Σ √(Δx² + Δy² + Δz²))` over consecutive points: each `√` of a safe integer (coordinates ≤ 10 km). */
export function routeFloorMm(points: readonly PositionMm[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const dz = points[i].z - points[i - 1].z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return Math.ceil(total);
}

/** Whether `lengthMm` covers the straight line from `a` to `b`, compared exactly as integers (`L² ≥ d²`). */
export function coversChord(lengthMm: number, a: PositionMm, b: PositionMm): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return lengthMm * lengthMm >= dx * dx + dy * dy + dz * dz;
}
