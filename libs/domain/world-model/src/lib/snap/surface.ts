/**
 * Mounting-surface frames in integer millimetres. A surface (backplate, wall, DIN rail, bench top) has
 * a 2D frame with axes `u` and `v` and an outward normal `n` pointing at the viewer, with
 * `u × v = n` (right-handed).
 *
 * - **Vertical surfaces** (walls, backplates, rails) face one of four horizontal directions
 *   ({@link SurfaceNormal}): `u` runs to the viewer's right (`up × n`) and `v` is world +y.
 * - **Horizontal surfaces** (bench tops, F1.9) face `'+y'`: `u` is the frame's `right` (default
 *   `'+x'`) and `v = n × u`, which runs away from a viewer standing at the frame's `v = 0` edge.
 *
 * A placed entity stores its orientation in the ADR 0007 encoding (integer millidegrees), mapped from
 * a frame by `orientationForFrame` (`placement.ts`). Frame normals are the frame's own description,
 * not a second rotation type.
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

/** The way a vertical surface faces (its outward normal); also any horizontal quarter-turn direction. */
export type SurfaceNormal = '+x' | '-x' | '+z' | '-z';

/** The way any P1 surface faces: one of the four horizontal directions, or up (bench tops). */
export type FrameNormal = SurfaceNormal | '+y';

export interface SurfaceFrame {
  /** World position of the surface's local origin (u = 0, v = 0, on the face). */
  readonly origin: Vec3Mm;
  readonly normal: FrameNormal;
  /** Horizontal (`'+y'`) frames only: the direction of `u`. Defaults to `'+x'`; vertical frames ignore it. */
  readonly right?: SurfaceNormal;
}

/** World-space integer unit axes of a frame. */
interface Axes {
  readonly u: Vec3Mm;
  readonly v: Vec3Mm;
  readonly n: Vec3Mm;
}

/** Integer unit vector of each direction. */
export const DIRECTION: Readonly<Record<FrameNormal, Vec3Mm>> = {
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
  '+y': { x: 0, y: 1, z: 0 },
};

/** Normalises -0 to 0 so results stay valid world coordinates. */
const z0 = (n: number): number => (n === 0 ? 0 : n);

const cross = (a: Vec3Mm, b: Vec3Mm): Vec3Mm => ({
  x: z0(a.y * b.z - a.z * b.y),
  y: z0(a.z * b.x - a.x * b.z),
  z: z0(a.x * b.y - a.y * b.x),
});

const dot = (a: Vec3Mm, b: Vec3Mm): number => a.x * b.x + a.y * b.y + a.z * b.z;

function axesOf(frame: SurfaceFrame): Axes {
  const n = DIRECTION[frame.normal];
  if (frame.normal === '+y') {
    const u = DIRECTION[frame.right ?? '+x'];
    return { u, v: cross(n, u), n };
  }
  const up = DIRECTION['+y'];
  return { u: cross(up, n), v: up, n };
}

export function assertIntegerMm(name: string, value: number): void {
  if (!isIntegerMm(value)) throw new RangeError(`${name} must be integer millimetres, got ${value}`);
}

/** World normal of a frame as an integer unit vector. */
export function frameNormal(frame: SurfaceFrame): Vec3Mm {
  return axesOf(frame).n;
}

/** World `u` and `v` axes of a frame as integer unit vectors. */
export function frameAxes(frame: SurfaceFrame): { readonly u: Vec3Mm; readonly v: Vec3Mm } {
  const { u, v } = axesOf(frame);
  return { u, v };
}

/** World → surface: returns (u, v) and the signed distance `w` along the normal (all integer mm). */
export function worldToSurface(frame: SurfaceFrame, p: Vec3Mm): SurfacePointMm & { readonly w: number } {
  const a = axesOf(frame);
  const d = { x: p.x - frame.origin.x, y: p.y - frame.origin.y, z: p.z - frame.origin.z };
  return { u: z0(dot(d, a.u)), v: z0(dot(d, a.v)), w: z0(dot(d, a.n)) };
}

/** Surface → world. `w` is the stand-off along the normal (0 = on the face). */
export function surfaceToWorld(frame: SurfaceFrame, p: SurfacePointMm, w = 0): Vec3Mm {
  const a = axesOf(frame);
  const o = frame.origin;
  return {
    x: z0(o.x + p.u * a.u.x + p.v * a.v.x + w * a.n.x),
    y: z0(o.y + p.u * a.u.y + p.v * a.v.y + w * a.n.y),
    z: z0(o.z + p.u * a.u.z + p.v * a.v.z + w * a.n.z),
  };
}
