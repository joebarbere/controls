import type { OrientationMdeg, PositionMm, Transform } from '../types';

/*
 * Exact geometry for axis-aligned entities (ADR 0015, "Geometry needs axis-aligned hosts"). A
 * terminal's, entry's, mount's or hosted waypoint's world position is the entity's position plus a
 * catalogue offset rotated by the entity's orientation. Orientations are integer millidegrees, and
 * ECMAScript doesn't pin `Math.sin`/`Math.cos` across engines, so P3 only places such points on
 * entities whose yaw, pitch and roll are each a multiple of 90°: quarter-turns composed in yaw-pitch-
 * roll order are integer signed-permutation matrices, so positions stay exact integers, identical in
 * Node and Chromium. Never `Math.cos` here.
 *
 * Used by the load check (`checkWorldReferences`) from world v3 on, and by the wiring commands,
 * `routing/` and the renderer's terminal picker as they land (owner `renderer-engineer`).
 */

/** A quarter turn in millidegrees. */
export const QUARTER_TURN_MDEG = 90_000;

/** cos and sin of k quarter-turns, k = 0 … 3. */
const COS = [1, 0, -1, 0] as const;
const SIN = [0, 1, 0, -1] as const;

/** Whether every angle of `orientation` is a whole number of quarter-turns. */
export function isAxisAligned(orientation: OrientationMdeg): boolean {
  return (
    orientation.yaw % QUARTER_TURN_MDEG === 0 &&
    orientation.pitch % QUARTER_TURN_MDEG === 0 &&
    orientation.roll % QUARTER_TURN_MDEG === 0
  );
}

/** k for an angle of k quarter-turns (`angle` in [0, 360000) and a multiple of 90 000). */
const turns = (angle: number): 0 | 1 | 2 | 3 => ((angle / QUARTER_TURN_MDEG) & 3) as 0 | 1 | 2 | 3;

/**
 * `offset` (integer mm in the entity's own frame) rotated by an axis-aligned `orientation`: intrinsic
 * yaw about +y, then pitch about the new +x, then roll about the new +z (ADR 0007), so
 * v' = Ry(yaw) · Rx(pitch) · Rz(roll) · v. Returns `null` if the orientation isn't axis-aligned.
 */
export function rotateQuarterTurns(orientation: OrientationMdeg, offset: PositionMm): PositionMm | null {
  if (!isAxisAligned(orientation)) return null;
  const r = turns(orientation.roll);
  const p = turns(orientation.pitch);
  const y = turns(orientation.yaw);
  // Rz(roll)
  const x1 = offset.x * COS[r] - offset.y * SIN[r];
  const y1 = offset.x * SIN[r] + offset.y * COS[r];
  const z1 = offset.z;
  // Rx(pitch)
  const y2 = y1 * COS[p] - z1 * SIN[p];
  const z2 = y1 * SIN[p] + z1 * COS[p];
  // Ry(yaw)
  const x3 = x1 * COS[y] + z2 * SIN[y];
  const z3 = -x1 * SIN[y] + z2 * COS[y];
  return { x: x3 + 0, y: y2 + 0, z: z3 + 0 };
}

/**
 * The world position (integer mm) of a point at `offsetMm` in an entity's own frame, or `null` when
 * the entity isn't axis-aligned (the commands refuse it as `not-axis-aligned`).
 */
export function entityPointMm(transform: Transform, offsetMm: PositionMm): PositionMm | null {
  const rotated = rotateQuarterTurns(transform.orientationMdeg, offsetMm);
  if (rotated === null) return null;
  const at = transform.positionMm;
  return { x: at.x + rotated.x, y: at.y + rotated.y, z: at.z + rotated.z };
}
