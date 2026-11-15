import type { Axis } from '@controls/catalog';
import type { PositionMm } from '../types';

/*
 * Small vector helpers for the routing maths (ADR 0017). Integer helpers stay exact on integer input;
 * the float ones use only `+ − × ÷` and `Math.sqrt` (D6), so every result is the same in Node and
 * Chromium.
 */

/** A point or direction in world mm; integer for anything stored, possibly fractional inside the bake. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The integer unit vector of each catalogue axis. */
export const UNIT: Readonly<Record<Axis, PositionMm>> = {
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  '+y': { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

export const add = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x + q.x, y: p.y + q.y, z: p.z + q.z });
export const sub = (p: Vec3, q: Vec3): Vec3 => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
export const scale = (p: Vec3, k: number): Vec3 => ({ x: p.x * k, y: p.y * k, z: p.z * k });
export const same = (p: Vec3, q: Vec3): boolean => p.x === q.x && p.y === q.y && p.z === q.z;

/** |q − p|² (exact for integer points within 10 km). */
export function distance2(p: Vec3, q: Vec3): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  return dx * dx + dy * dy + dz * dz;
}

/** |q − p|, through the correctly rounded `Math.sqrt` (never `Math.hypot`). */
export function distance(p: Vec3, q: Vec3): number {
  return Math.sqrt(distance2(p, q));
}
