/**
 * Keyboard terminal cycling (F3.2 part 3, ADR 0010 decision 4, ADR 0017 §9) and the work-mode frame
 * of a device, so `view.focus` can zoom to one. Pure (lint-fenced): no Three.js, DOM or clock.
 *
 * **Cycle order is reading order on the device, in its own frame:** top row first (local y
 * descending), then left to right (x ascending), then front to back (z descending), then the terminal
 * id in code-unit order. It depends only on the catalogue entry, never on the camera or on iteration
 * order, so Tab visits the same terminals in the same order on every machine and after any move or
 * turn of the device.
 */
import { rotateQuarterTurns, type OrientationMdeg, type SurfaceNormal } from '@controls/world-model';

/** A terminal as the cycle sees it: its id and where it is on the device (catalogue `positionMm`). */
export interface CycleTerminal {
  readonly id: string;
  readonly positionMm: { readonly x: number; readonly y: number; readonly z: number };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Terminal ids of a device in Tab order (see the module comment). */
export function terminalCycleOrder(terminals: readonly CycleTerminal[]): string[] {
  return [...terminals]
    .sort(
      (p, q) =>
        q.positionMm.y - p.positionMm.y ||
        p.positionMm.x - q.positionMm.x ||
        q.positionMm.z - p.positionMm.z ||
        byCodeUnit(p.id, q.id),
    )
    .map((t) => t.id);
}

/**
 * The terminal `step` places from `current` in `order`, wrapping. Without a current one in the
 * order, Tab (`step` 1) starts at the first and Shift+Tab (−1) at the last. `null` for an empty order.
 */
export function cycleTerminal(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  const n = order.length;
  if (n === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[step > 0 ? 0 : n - 1];
  return order[(at + step + n) % n];
}

/** How work mode frames a device: the way its working face points and the camera's elevation. */
export interface DeviceFocusFrame {
  readonly normal: SurfaceNormal;
  readonly elevationDeg: number;
}

const NORMALS: ReadonlyArray<readonly [SurfaceNormal, number, number]> = [
  ['+x', 1, 0],
  ['-x', -1, 0],
  ['+z', 0, 1],
  ['-z', 0, -1],
];

const horizontal = (v: { x: number; y: number; z: number } | null): SurfaceNormal | null => {
  if (v === null || v.y !== 0) return null;
  return NORMALS.find(([, x, z]) => x === v.x && z === v.z)?.[0] ?? null;
};

/**
 * The work-mode frame of a device at `orientation`: its front (local +z) where that is horizontal,
 * at elevation 0 (panel and wall devices); a device whose front faces up (a bench device, pitched
 * −90°) is seen from its own near side (local −y) from `benchElevationDeg` above. `null` when the
 * device isn't at quarter-turns or faces down (nothing to frame it from).
 */
export function deviceFocusFrame(orientation: OrientationMdeg, benchElevationDeg: number): DeviceFocusFrame | null {
  const front = rotateQuarterTurns(orientation, { x: 0, y: 0, z: 1 });
  const normal = horizontal(front);
  if (normal !== null) return { normal, elevationDeg: 0 };
  if (front === null || front.y !== 1) return null;
  const near = horizontal(rotateQuarterTurns(orientation, { x: 0, y: -1, z: 0 }));
  return near === null ? null : { normal: near, elevationDeg: benchElevationDeg };
}
