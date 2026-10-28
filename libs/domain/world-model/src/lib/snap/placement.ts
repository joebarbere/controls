/**
 * From a cursor point to the exact arguments of `entity.place` / `entity.move` (F1.7). The renderer's
 * ghost preview, the workspace's commit and any script call {@link placeOnTargets}, so the mouse and a
 * script produce identical commands, and so identical `world.hash`es.
 *
 * A placed entity's `positionMm` is the snap anchor in world space: the footprint's lower-left corner
 * on the mounting face. Its prop geometry spans +x (width), +y (height) and +z (depth) from that
 * origin, turned by `orientationMdeg` so +x runs along the surface's `u`, +y along its `v` and +z
 * along its normal. On a wall that is a yaw quarter-turn; on a bench top (F1.9) the prop is also
 * pitched -90° so its depth stands up.
 */
import { propFootprint } from '../props';
import type { CatalogRef, OrientationMdeg } from '../types';
import { snapToBest } from './resolve';
import type { SnapFailure, SnapTarget } from './snap';
import type { SurfaceFrame, SurfaceNormal, Vec3Mm } from './surface';

/** Yaw (about +y, ADR 0007) that turns a prop's +z onto each vertical surface normal. */
const YAW_BY_NORMAL: Readonly<Record<SurfaceNormal, number>> = {
  '+z': 0,
  '+x': 90_000,
  '-z': 180_000,
  '-x': 270_000,
};

/** Yaw that turns a prop's +x onto a horizontal frame's `right` (then pitch -90° stands +z up). */
const YAW_BY_RIGHT: Readonly<Record<SurfaceNormal, number>> = {
  '+x': 0,
  '-z': 90_000,
  '-x': 180_000,
  '+z': 270_000,
};

/** Pitch -90° in [0, 360000) millidegrees: turns the prop's +z (depth) to world +y. */
export const PITCH_STAND_UP_MDEG = 270_000;

/** The orientation of a prop mounted flat on a vertical surface facing `normal`. */
export function orientationForNormal(normal: SurfaceNormal): OrientationMdeg {
  return { yaw: YAW_BY_NORMAL[normal], pitch: 0, roll: 0 };
}

/** The orientation of a prop mounted flat on `frame`: a wall, or (normal `'+y'`) a bench top. */
export function orientationForFrame(frame: SurfaceFrame): OrientationMdeg {
  if (frame.normal === '+y') return { yaw: YAW_BY_RIGHT[frame.right ?? '+x'], pitch: PITCH_STAND_UP_MDEG, roll: 0 };
  return orientationForNormal(frame.normal);
}

/** The vertical surface normal a mounted orientation faces, or `null` if it isn't one of the four wall mounts. */
export function normalForOrientation(o: OrientationMdeg): SurfaceNormal | null {
  if (o.pitch !== 0 || o.roll !== 0) return null;
  for (const normal of ['+z', '+x', '-z', '-x'] as const) if (YAW_BY_NORMAL[normal] === o.yaw) return normal;
  return null;
}

/** Whether `o` is one of the eight P1 mounted orientations (four walls, four bench-top turns). */
export function isMountedOrientation(o: OrientationMdeg): boolean {
  if (normalForOrientation(o)) return true;
  return o.pitch === PITCH_STAND_UP_MDEG && o.roll === 0 && Object.values(YAW_BY_RIGHT).includes(o.yaw);
}

const sameOrientation = (a: OrientationMdeg, b: OrientationMdeg): boolean =>
  a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll;

export type PlacementFailure = 'unknown-prop' | 'no-target' | 'orientation-mismatch' | SnapFailure;

export type Placement =
  | {
      readonly ok: true;
      readonly targetId: string;
      readonly kind: SnapTarget['kind'];
      readonly positionMm: Vec3Mm;
      readonly orientationMdeg: OrientationMdeg;
    }
  | { readonly ok: false; readonly reason: PlacementFailure; readonly targetId: string | null };

export interface PlacementOptions {
  /**
   * Keep this orientation (moving an existing entity): only targets that mount a prop this way are
   * considered, because `entity.move` changes position only and a commit is exactly one command.
   */
  readonly orientationMdeg?: OrientationMdeg;
}

/**
 * Where a built-in prop goes when the cursor is at `cursorWorld` (integer mm), among `targets`.
 * On success, `positionMm` and `orientationMdeg` are exactly the `entity.place` arguments (or, with
 * {@link PlacementOptions.orientationMdeg}, the `entity.move` position).
 */
export function placeOnTargets(
  ref: CatalogRef,
  cursorWorld: Vec3Mm,
  targets: readonly SnapTarget[],
  options: PlacementOptions = {},
): Placement {
  const footprint = propFootprint(ref);
  if (!footprint) return { ok: false, reason: 'unknown-prop', targetId: null };
  let candidates = targets;
  const keep = options.orientationMdeg;
  if (keep) {
    if (!isMountedOrientation(keep)) return { ok: false, reason: 'orientation-mismatch', targetId: null };
    candidates = targets.filter((t) => sameOrientation(orientationForFrame(t.frame), keep));
  }
  const result = snapToBest(candidates, footprint, cursorWorld);
  if (!result) return { ok: false, reason: 'no-target', targetId: null };
  if (!result.ok) return { ok: false, reason: result.reason, targetId: result.targetId };
  const target = candidates.find((t) => t.id === result.targetId && t.kind === result.kind);
  return {
    ok: true,
    targetId: result.targetId,
    kind: result.kind,
    positionMm: result.world,
    // `snapToBest` only returns a target from `candidates`, so `target` is always found.
    orientationMdeg: orientationForFrame((target as SnapTarget).frame),
  };
}
