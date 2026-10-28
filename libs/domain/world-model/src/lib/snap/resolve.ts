/**
 * Choosing which snap target a cursor point belongs to (F1.7). The renderer's ghost, scripts and
 * `sim-cli` all call {@link snapToBest} with the same targets, so a cursor point always snaps to the
 * same place whichever surface produced it. Pure and deterministic: the order of `targets` doesn't
 * matter, because candidates are sorted by a fixed priority and then by id.
 */
import { SNAP_STEPS, snap, type Footprint, type SnapResult, type SnapTarget } from './snap';
import { assertIntegerMm, worldToSurface, type Vec3Mm } from './surface';

/** More specific targets win: a cursor on a DIN rail snaps to the rail, not to the plate behind it. */
export const SNAP_PRIORITY: Readonly<Record<SnapTarget['kind'], number>> = {
  'din-rail': 0,
  'backplate-grid': 1,
  'wall-studs': 2,
  'bench-top': 3,
};

const byPriorityThenId = (a: SnapTarget, b: SnapTarget): number =>
  SNAP_PRIORITY[a.kind] - SNAP_PRIORITY[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Whether an integer-mm world point lies on `target`: within {@link SNAP_STEPS.planeToleranceMm} of
 * its plane and inside its extent (a DIN rail: along its length and inside the capture band).
 */
export function isOnTarget(target: SnapTarget, cursorWorld: Vec3Mm): boolean {
  const p = worldToSurface(target.frame, cursorWorld);
  if (Math.abs(p.w) > SNAP_STEPS.planeToleranceMm) return false;
  switch (target.kind) {
    case 'din-rail':
      return p.u >= 0 && p.u <= target.lengthMm && Math.abs(p.v) <= SNAP_STEPS.dinCaptureMm;
    case 'backplate-grid':
    case 'wall-studs':
    case 'bench-top':
      return p.u >= 0 && p.u <= target.widthMm && p.v >= 0 && p.v <= target.heightMm;
  }
}

/**
 * Snaps a footprint to the best target under the cursor: the targets the point is on (see
 * {@link isOnTarget}), by {@link SNAP_PRIORITY} then id, and the first that accepts the footprint.
 * If none accepts it, the first candidate's failure is returned (for "too large" feedback); `null`
 * means the point is on no target at all.
 */
export function snapToBest(
  targets: readonly SnapTarget[],
  footprint: Footprint,
  cursorWorld: Vec3Mm,
): SnapResult | null {
  assertIntegerMm('cursor.x', cursorWorld.x);
  assertIntegerMm('cursor.y', cursorWorld.y);
  assertIntegerMm('cursor.z', cursorWorld.z);
  const candidates = targets.filter((t) => isOnTarget(t, cursorWorld)).sort(byPriorityThenId);
  let firstFailure: SnapResult | null = null;
  for (const target of candidates) {
    const result = snap(target, footprint, cursorWorld);
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure;
}
