/**
 * Pure, GPU-free placement snapping in integer millimetres. The same inputs always give the same
 * output (no randomness, no clock, no float accumulation across calls), so a replayed command log
 * places things exactly where the live session did.
 *
 * Conventions:
 * - The cursor is where the player wants the **centre** of the footprint.
 * - The result `anchor` is the footprint's **lower-left corner** (min u, min v) in the target's
 *   surface frame. Corners stay integer for any integer footprint; centres would not.
 * - `world` is that anchor in world space, on the target's mounting face.
 *
 * It lives in `@controls/world-model` (moved from the renderer in F1.7) so scripts, `sim-cli` and the
 * mouse snap identically. Domain rules apply: no Three.js or DOM, and the determinism lint.
 */
import { roundMm } from '@controls/units';
import {
  BACKPLATE_GRID_PITCH,
  DIN_MODULE_PITCH,
  DIN_RAIL_CAPTURE,
  SNAP_PLANE_TOLERANCE,
  WALL_STUD_SPACING,
  WALL_STUD_THICKNESS,
  WALL_VERTICAL_PITCH,
} from './constants';
import {
  assertIntegerMm,
  surfaceToWorld,
  worldToSurface,
  type SurfaceFrame,
  type SurfaceNormal,
  type SurfacePointMm,
  type Vec3Mm,
} from './surface';

/** Device outline on the mounting surface, integer mm. */
export interface Footprint {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** A DIN rail. Frame origin: the rail's left end, on its centreline, on the backplate face. */
export interface DinRailTarget {
  readonly kind: 'din-rail';
  readonly id: string;
  readonly frame: SurfaceFrame;
  readonly lengthMm: number;
}

/** A backplate (sub-panel). Frame origin: the plate's lower-left corner on its front face. */
export interface BackplateGridTarget {
  readonly kind: 'backplate-grid';
  readonly id: string;
  readonly frame: SurfaceFrame;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Keep-out border, integer mm. Default 0. */
  readonly marginMm?: number;
}

/** An open stud wall. Frame origin: lower-left corner of the wall at floor level, on the stud faces. */
export interface WallStudsTarget {
  readonly kind: 'wall-studs';
  readonly id: string;
  readonly frame: SurfaceFrame;
  readonly widthMm: number;
  readonly heightMm: number;
  /** u of the first stud's centre (integer mm). */
  readonly firstStudCentreMm: number;
}

/** Anything placement can snap to. */
export type SnapTarget = DinRailTarget | BackplateGridTarget | WallStudsTarget;

export type SnapFailure = 'out-of-capture' | 'out-of-bounds' | 'too-large';

export type SnapResult =
  | {
      readonly ok: true;
      readonly targetId: string;
      readonly kind: SnapTarget['kind'];
      readonly anchor: SurfacePointMm;
      readonly world: Vec3Mm;
      /** The target surface's normal (which way a part mounted there faces). */
      readonly normal: SurfaceNormal;
    }
  | { readonly ok: false; readonly targetId: string; readonly kind: SnapTarget['kind']; readonly reason: SnapFailure };

/** Increments derived from the sourced constants, rounded once to integer mm. */
export const SNAP_STEPS = {
  dinModuleMm: roundMm(DIN_MODULE_PITCH.valueMm),
  dinCaptureMm: roundMm(DIN_RAIL_CAPTURE.valueMm),
  backplateGridMm: roundMm(BACKPLATE_GRID_PITCH.valueMm),
  wallVerticalMm: roundMm(WALL_VERTICAL_PITCH.valueMm),
  planeToleranceMm: roundMm(SNAP_PLANE_TOLERANCE.valueMm),
  /** Half a stud, rounded **up** so a box set against a stud never overlaps it. */
  studHalfThicknessMm: Math.ceil(WALL_STUD_THICKNESS.valueMm / 2),
} as const;

const z0 = (n: number): number => (n === 0 ? 0 : n);
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Nearest grid slot `k` (0…kMax) for a desired start `x` on a grid of `pitch` starting at 0. */
const slot = (x: number, pitch: number, kMax: number): number => clamp(Math.round(x / pitch), 0, kMax);

function checkFootprint(f: Footprint): void {
  assertIntegerMm('footprint.widthMm', f.widthMm);
  assertIntegerMm('footprint.heightMm', f.heightMm);
  if (f.widthMm <= 0 || f.heightMm <= 0) throw new RangeError('footprint must be positive');
}

function ok(target: SnapTarget, anchor: SurfacePointMm): SnapResult {
  const a = { u: z0(anchor.u), v: z0(anchor.v) };
  return {
    ok: true,
    targetId: target.id,
    kind: target.kind,
    anchor: a,
    world: surfaceToWorld(target.frame, a),
    normal: target.frame.normal,
  };
}

const fail = (target: SnapTarget, reason: SnapFailure): SnapResult => ({
  ok: false,
  targetId: target.id,
  kind: target.kind,
  reason,
});

/**
 * DIN rail: the device clips on centred across the rail, its left edge on a whole module
 * (18 mm) from the rail's left end, and it must fit on the rail.
 */
export function snapToDinRail(target: DinRailTarget, footprint: Footprint, cursor: SurfacePointMm): SnapResult {
  checkFootprint(footprint);
  assertIntegerMm('lengthMm', target.lengthMm);
  if (Math.abs(cursor.v) > SNAP_STEPS.dinCaptureMm) return fail(target, 'out-of-capture');
  const pitch = SNAP_STEPS.dinModuleMm;
  const free = target.lengthMm - footprint.widthMm;
  if (free < 0) return fail(target, 'too-large');
  const k = slot(cursor.u - footprint.widthMm / 2, pitch, Math.floor(free / pitch));
  return ok(target, { u: k * pitch, v: -Math.floor(footprint.heightMm / 2) });
}

/** Backplate: the footprint's corner lands on the grid, inside the plate minus its margin. */
export function snapToBackplateGrid(
  target: BackplateGridTarget,
  footprint: Footprint,
  cursor: SurfacePointMm,
): SnapResult {
  checkFootprint(footprint);
  const margin = target.marginMm ?? 0;
  assertIntegerMm('widthMm', target.widthMm);
  assertIntegerMm('heightMm', target.heightMm);
  assertIntegerMm('marginMm', margin);
  const pitch = SNAP_STEPS.backplateGridMm;
  const freeU = target.widthMm - 2 * margin - footprint.widthMm;
  const freeV = target.heightMm - 2 * margin - footprint.heightMm;
  if (freeU < 0 || freeV < 0) return fail(target, 'too-large');
  const ku = slot(cursor.u - footprint.widthMm / 2 - margin, pitch, Math.floor(freeU / pitch));
  const kv = slot(cursor.v - footprint.heightMm / 2 - margin, pitch, Math.floor(freeV / pitch));
  return ok(target, { u: margin + ku * pitch, v: margin + kv * pitch });
}

/**
 * Stud centres along a wall, integer mm. Computed from the exact 406.4 mm spacing per stud
 * (`round(first + i × 406.4)`), never by adding a rounded step, so rounding error can't accumulate.
 */
export function studCentres(target: WallStudsTarget): number[] {
  assertIntegerMm('widthMm', target.widthMm);
  assertIntegerMm('firstStudCentreMm', target.firstStudCentreMm);
  const centres: number[] = [];
  for (let i = 0; ; i++) {
    const c = roundMm(target.firstStudCentreMm + i * WALL_STUD_SPACING.valueMm);
    if (c > target.widthMm) return centres;
    if (c >= 0) centres.push(c);
  }
}

/**
 * Wall studs: a box mounts against the side of the nearest stud (the side the cursor is on),
 * in the bay between two studs, and its bottom lands on the 10 mm vertical grid.
 */
export function snapToWallStuds(target: WallStudsTarget, footprint: Footprint, cursor: SurfacePointMm): SnapResult {
  checkFootprint(footprint);
  assertIntegerMm('heightMm', target.heightMm);
  const studs = studCentres(target);
  if (studs.length === 0) return fail(target, 'out-of-bounds');
  const half = SNAP_STEPS.studHalfThicknessMm;
  const w = footprint.widthMm;

  // Nearest stud; ties go to the lower index (deterministic).
  let nearest = 0;
  for (let i = 1; i < studs.length; i++) {
    if (Math.abs(studs[i] - cursor.u) < Math.abs(studs[nearest] - cursor.u)) nearest = i;
  }

  // Candidate placements: right of the nearest stud, or left of it. Cursor side first.
  const right = {
    u: studs[nearest] + half,
    lo: studs[nearest] + half,
    hi: (studs[nearest + 1] ?? target.widthMm + half) - half,
  };
  const left = { u: studs[nearest] - half - w, lo: (studs[nearest - 1] ?? -half) + half, hi: studs[nearest] - half };
  const order = cursor.u >= studs[nearest] ? [right, left] : [left, right];
  const fitsBay = (c: { lo: number; hi: number }) => c.hi - c.lo >= w;
  const inWall = (c: { u: number }) => c.u >= 0 && c.u + w <= target.widthMm;
  if (!order.some(fitsBay)) return fail(target, 'too-large');
  const choice = order.find((c) => fitsBay(c) && inWall(c));
  if (!choice) return fail(target, 'out-of-bounds');

  const vPitch = SNAP_STEPS.wallVerticalMm;
  const freeV = target.heightMm - footprint.heightMm;
  if (freeV < 0) return fail(target, 'too-large');
  const kv = slot(cursor.v - footprint.heightMm / 2, vPitch, Math.floor(freeV / vPitch));
  return ok(target, { u: choice.u, v: kv * vPitch });
}

/**
 * Snaps a footprint to any target. `cursorWorld` is the integer-mm world point under the cursor
 * (convert a raycast hit with `metresToMm` from `@controls/units` first).
 */
export function snap(target: SnapTarget, footprint: Footprint, cursorWorld: Vec3Mm): SnapResult {
  assertIntegerMm('cursor.x', cursorWorld.x);
  assertIntegerMm('cursor.y', cursorWorld.y);
  assertIntegerMm('cursor.z', cursorWorld.z);
  const local = worldToSurface(target.frame, cursorWorld);
  switch (target.kind) {
    case 'din-rail':
      return snapToDinRail(target, footprint, local);
    case 'backplate-grid':
      return snapToBackplateGrid(target, footprint, local);
    case 'wall-studs':
      return snapToWallStuds(target, footprint, local);
  }
}
