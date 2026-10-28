/**
 * From a cursor point to the exact arguments of `entity.place` / `entity.move` (F1.7). The renderer's
 * ghost preview, the workspace's commit and any script call {@link placeOnTargets}, so the mouse and a
 * script produce identical commands, and so identical `world.hash`es.
 *
 * A placed entity's `positionMm` is the snap anchor in world space: the footprint's lower-left corner
 * on the mounting face. Its prop geometry spans +x (width), +y (height) and +z (depth) from that
 * origin, turned by `orientationMdeg` so +x runs along the surface's `u` and +z along its normal.
 */
import { propFootprint } from '../props';
import type { CatalogRef, OrientationMdeg } from '../types';
import { snapToBest } from './resolve';
import type { SnapFailure, SnapTarget } from './snap';
import type { SurfaceNormal, Vec3Mm } from './surface';

/** Yaw (about +y, ADR 0007) that turns a prop's +z onto each P1 surface normal; pitch and roll stay 0. */
const YAW_BY_NORMAL: Readonly<Record<SurfaceNormal, number>> = {
  '+z': 0,
  '+x': 90_000,
  '-z': 180_000,
  '-x': 270_000,
};

/** The orientation of a prop mounted flat on a surface facing `normal`. */
export function orientationForNormal(normal: SurfaceNormal): OrientationMdeg {
  return { yaw: YAW_BY_NORMAL[normal], pitch: 0, roll: 0 };
}

/** The surface normal a mounted orientation faces, or `null` if it isn't one of the four flat mounts. */
export function normalForOrientation(o: OrientationMdeg): SurfaceNormal | null {
  if (o.pitch !== 0 || o.roll !== 0) return null;
  for (const normal of ['+z', '+x', '-z', '-x'] as const) if (YAW_BY_NORMAL[normal] === o.yaw) return normal;
  return null;
}

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
   * Keep this orientation (moving an existing entity): only targets facing the same way are
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
  if (options.orientationMdeg) {
    const normal = normalForOrientation(options.orientationMdeg);
    if (!normal) return { ok: false, reason: 'orientation-mismatch', targetId: null };
    candidates = targets.filter((t) => t.frame.normal === normal);
  }
  const result = snapToBest(candidates, footprint, cursorWorld);
  if (!result) return { ok: false, reason: 'no-target', targetId: null };
  if (!result.ok) return { ok: false, reason: result.reason, targetId: result.targetId };
  return {
    ok: true,
    targetId: result.targetId,
    kind: result.kind,
    positionMm: result.world,
    orientationMdeg: orientationForNormal(result.normal),
  };
}
