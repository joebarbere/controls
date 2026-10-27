/**
 * Mounting-surface frames in integer millimetres. A surface (backplate, wall, DIN rail) has a 2D frame:
 * `u` runs to the viewer's right when facing the surface, `v` is world +y, and the surface normal points
 * at the viewer. P1 surfaces are vertical and axis-aligned, so the normal is one of four directions.
 *
 * TODO(ADR 0007): replace `SurfaceNormal` with the save-format orientation encoding once it lands.
 */
import { isIntegerMm } from '@controls/units';

/** Integer-mm point in world space (right-handed, +y up). */
export interface Vec3Mm {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Integer-mm point in a surface's own 2D frame. */
export interface SurfacePointMm {
  readonly u: number;
  readonly v: number;
}

/** Direction the surface faces (its outward normal). */
export type SurfaceNormal = '+x' | '-x' | '+z' | '-z';

export interface SurfaceFrame {
  /** World position of the surface's local origin (u = 0, v = 0, on the face). */
  readonly origin: Vec3Mm;
  readonly normal: SurfaceNormal;
}

/** World-space unit axes of a frame: u (right), n (normal). v is always +y. */
interface Axes {
  readonly ux: number;
  readonly uz: number;
  readonly nx: number;
  readonly nz: number;
}

// right = up × normal (right-handed, +y up).
const AXES: Readonly<Record<SurfaceNormal, Axes>> = {
  '+z': { ux: 1, uz: 0, nx: 0, nz: 1 },
  '-z': { ux: -1, uz: 0, nx: 0, nz: -1 },
  '+x': { ux: 0, uz: -1, nx: 1, nz: 0 },
  '-x': { ux: 0, uz: 1, nx: -1, nz: 0 },
};

/** Normalises -0 to 0 so results stay valid world coordinates. */
const z0 = (n: number): number => (n === 0 ? 0 : n);

export function assertIntegerMm(name: string, value: number): void {
  if (!isIntegerMm(value)) throw new RangeError(`${name} must be integer millimetres, got ${value}`);
}

/** World normal of a frame as an integer unit vector. */
export function frameNormal(frame: SurfaceFrame): Vec3Mm {
  const a = AXES[frame.normal];
  return { x: a.nx, y: 0, z: a.nz };
}

/** World → surface: returns (u, v) and the signed distance `w` along the normal (all integer mm). */
export function worldToSurface(frame: SurfaceFrame, p: Vec3Mm): SurfacePointMm & { readonly w: number } {
  const a = AXES[frame.normal];
  const dx = p.x - frame.origin.x;
  const dy = p.y - frame.origin.y;
  const dz = p.z - frame.origin.z;
  return { u: z0(dx * a.ux + dz * a.uz), v: z0(dy), w: z0(dx * a.nx + dz * a.nz) };
}

/** Surface → world. `w` is the stand-off along the normal (0 = on the face). */
export function surfaceToWorld(frame: SurfaceFrame, p: SurfacePointMm, w = 0): Vec3Mm {
  const a = AXES[frame.normal];
  return {
    x: z0(frame.origin.x + p.u * a.ux + w * a.nx),
    y: z0(frame.origin.y + p.v),
    z: z0(frame.origin.z + p.u * a.uz + w * a.nz),
  };
}
