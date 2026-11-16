import { BAKE_UNITS_PER_MM, type BakedCoil } from '@controls/world-model';

/*
 * The drawn pieces of a baked route (F3.2 part 2), in millimetres: the segments its instanced
 * 6-sided cylinders stand on, the coil of a long cut, and where its label sleeves go. Pure and
 * GPU-free (lint-fenced): the route shape itself is the domain bake's (`bakeWorldRoutes`, ADR 0017);
 * nothing here decides where a wire goes, it only turns the bake's integer tenths into what the GPU
 * side writes. Coils and sleeves are a picture of data the bake and the world already hold.
 */

/** One drawn segment, mm, and which half of its route it is in (0: end `a`'s half, 1: end `b`'s). */
export type SegmentVisitor = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  half: 0 | 1,
) => void;

/** A baked polyline's length in mm (`points`: flat x, y, z in tenths). */
export function polylineLengthMm(points: readonly number[]): number {
  let total = 0;
  for (let i = 3; i + 2 < points.length; i += 3) {
    const dx = points[i] - points[i - 3];
    const dy = points[i + 1] - points[i - 2];
    const dz = points[i + 2] - points[i - 1];
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return total / BAKE_UNITS_PER_MM;
}

/**
 * Visits each segment of a baked polyline (tenths) in order, in mm, with the half of the route its
 * midpoint lies in (by length along the route), so an overlay can colour each end's half by that
 * end (D15). Returns the number of segments. A one-point route has none.
 */
export function forEachRouteSegment(points: readonly number[], visit: SegmentVisitor): number {
  const half = polylineLengthMm(points) / 2;
  const u = BAKE_UNITS_PER_MM;
  let along = 0;
  let n = 0;
  for (let i = 3; i + 2 < points.length; i += 3) {
    const ax = points[i - 3] / u;
    const ay = points[i - 2] / u;
    const az = points[i - 1] / u;
    const bx = points[i] / u;
    const by = points[i + 1] / u;
    const bz = points[i + 2] / u;
    const length = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
    visit(ax, ay, az, bx, by, bz, along + length / 2 < half ? 0 : 1);
    along += length;
    n++;
  }
  return n;
}

/**
 * Which half of a baked route (tenths) a point (tenths) is in: by the length along the route to the
 * route vertex nearest it (the bake's coil point lies on the route). 0 is end `a`'s half.
 */
export function halfAt(points: readonly number[], at: readonly [number, number, number]): 0 | 1 {
  const n = points.length / 3;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = points[3 * i] - at[0];
    const dy = points[3 * i + 1] - at[1];
    const dz = points[3 * i + 2] - at[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const along = polylineLengthMm(points.slice(0, 3 * (best + 1)));
  return along < polylineLengthMm(points) / 2 ? 0 : 1;
}

/** Diameter of a drawn coil (mm; game-design: a hand-wound loop of panel wire, about 6 in). */
export const COIL_DIAMETER_MM = 150;
/** Most turns drawn, however long the coil (game-design: more reads as a blob, and costs instances). */
export const COIL_MAX_DRAWN_TURNS = 3;
/** Segments per drawn turn (game-design: as round as the 6-sided conductor). */
export const COIL_SEGMENTS_PER_TURN = 12;

/**
 * A coil drawn as up to {@link COIL_MAX_DRAWN_TURNS} rings hanging from its point, one wire diameter
 * apart along +z, as a polyline in mm (flat x, y, z). The turn count is the coil's length over one
 * ring's circumference, at least one. The bake decides whether there is a coil and where; this only
 * draws it.
 */
export function coilPolylineMm(coil: BakedCoil, wireDiameterMm: number): number[] {
  const r = COIL_DIAMETER_MM / 2;
  const turns = coilDrawnTurns(coil);
  const [x, y, z] = coil.at.map((v) => v / BAKE_UNITS_PER_MM);
  const out: number[] = [];
  const steps = turns * COIL_SEGMENTS_PER_TURN;
  for (let k = 0; k <= steps; k++) {
    // From the hanging point (the top of the ring) round and back, drifting along +z.
    const angle = (2 * Math.PI * k) / COIL_SEGMENTS_PER_TURN;
    out.push(x + r * Math.sin(angle), y - r + r * Math.cos(angle), z + (wireDiameterMm * k) / COIL_SEGMENTS_PER_TURN);
  }
  return out;
}

/** The number of turns {@link coilPolylineMm} draws. */
export function coilDrawnTurns(coil: BakedCoil): number {
  const lengthMm = coil.lengthTenths / BAKE_UNITS_PER_MM;
  return Math.max(1, Math.min(COIL_MAX_DRAWN_TURNS, Math.floor(lengthMm / (Math.PI * COIL_DIAMETER_MM))));
}

/** How far along the route from each end a label sleeve sits (mm; game-design: just past the lead-out). */
export const SLEEVE_OFFSET_MM = 25;
/** A sleeve's length (mm; game-design: a printed heat-shrink marker). */
export const SLEEVE_LENGTH_MM = 12;
/** How much wider than the wire a sleeve is drawn, on the diameter (mm; game-design). */
export const SLEEVE_EXTRA_DIAMETER_MM = 1.5;

/** A sleeve marker: its centre and the unit direction of the route there (mm). */
export interface SleevePlacement {
  readonly at: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/** The point and direction `distance` mm along a baked polyline (tenths) from its start, or `null` (no segment). */
function alongMm(points: readonly number[], distance: number, fromEnd: boolean): SleevePlacement | null {
  const u = BAKE_UNITS_PER_MM;
  const n = points.length / 3;
  let left = distance;
  for (let s = 1; s < n; s++) {
    const i = fromEnd ? n - s : s - 1; // the segment's first point, walking from the chosen end
    const j = fromEnd ? n - s - 1 : s;
    const ax = points[3 * i] / u;
    const ay = points[3 * i + 1] / u;
    const az = points[3 * i + 2] / u;
    const dx = points[3 * j] / u - ax;
    const dy = points[3 * j + 1] / u - ay;
    const dz = points[3 * j + 2] / u - az;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length === 0) continue;
    if (left <= length || s === n - 1) {
      const t = Math.min(1, left / length);
      return {
        at: [ax + dx * t, ay + dy * t, az + dz * t],
        direction: [dx / length, dy / length, dz / length],
      };
    }
    left -= length;
  }
  return null;
}

/**
 * Where a labelled route's two sleeve markers go: {@link SLEEVE_OFFSET_MM} along from each end (at
 * most a third of the way, so a short route's sleeves never meet). `[]` for a route with no segment.
 */
export function sleevePlacements(points: readonly number[]): SleevePlacement[] {
  const distance = Math.min(SLEEVE_OFFSET_MM, polylineLengthMm(points) / 3);
  const a = alongMm(points, distance, false);
  const b = alongMm(points, distance, true);
  return a && b ? [a, b] : [];
}

/**
 * Above this |y| component a segment counts as vertical for {@link flatThinAxis} (game-design: about
 * 25° from vertical; a sagging span's samples near its ends stay on the horizontal rule).
 */
export const FLAT_VERTICAL_Y = 0.9;

/**
 * The axis a flat cable's segment is thin along (the normal of its wide faces), for a segment along
 * the unit direction (dx, dy, dz): world +y made perpendicular to the segment, so a horizontal run
 * lies flat; a vertical run (|dy| > {@link FLAT_VERTICAL_Y}) uses +z, so it shows its wide face to a
 * wall's front and lies flat against a stud's side face. A drawing abstraction (a real NM-B twists
 * as it is pulled), deterministic, and the same frame `bakeCableEnds` fans tails across (`fanAxis`:
 * +x across an entry along y, +z across one along x). Writes the unit axis into `out[0..2]`;
 * allocation-free.
 */
export function flatThinAxis(dx: number, dy: number, dz: number, out: Float64Array | number[]): void {
  const vertical = Math.abs(dy) > FLAT_VERTICAL_Y;
  const rx = 0;
  const ry = vertical ? 0 : 1;
  const rz = vertical ? 1 : 0;
  const dot = rx * dx + ry * dy + rz * dz;
  let nx = rx - dot * dx;
  let ny = ry - dot * dy;
  let nz = rz - dot * dz;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < 1e-9) {
    // Exactly along the reference: any perpendicular will do (+x).
    nx = 1;
    ny = 0;
    nz = 0;
  } else {
    nx /= length;
    ny /= length;
    nz /= length;
  }
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
}

/**
 * Where a cable conductor's tail sleeve goes: one marker {@link SLEEVE_OFFSET_MM} back from the tail's
 * far end (its terminal, or a stub's tip), at most a third of the way. `[]` for a tail with no segment.
 */
export function tailSleevePlacement(points: readonly number[]): SleevePlacement[] {
  const distance = Math.min(SLEEVE_OFFSET_MM, polylineLengthMm(points) / 3);
  const at = alongMm(points, distance, true);
  return at ? [at] : [];
}

/**
 * A cable's drawn jacket as one polyline (tenths): end `a`'s jacket stub reversed (from where the
 * jacket ends to the entry), the baked run, then end `b`'s stub (entry to jacket end), with the
 * shared entry points once. The run and the stubs come from the domain bake (`bakeWorldRoutes`,
 * `bakeCableEnds`); this only joins them.
 */
export function joinCableJacket(
  a: readonly number[] | null,
  run: readonly number[],
  b: readonly number[] | null,
): number[] {
  const out: number[] = [];
  const push = (x: number, y: number, z: number) => {
    const n = out.length;
    if (n >= 3 && out[n - 3] === x && out[n - 2] === y && out[n - 1] === z) return;
    out.push(x, y, z);
  };
  if (a) for (let i = a.length - 3; i >= 0; i -= 3) push(a[i], a[i + 1], a[i + 2]);
  for (let i = 0; i + 2 < run.length; i += 3) push(run[i], run[i + 1], run[i + 2]);
  if (b) for (let i = 0; i + 2 < b.length; i += 3) push(b[i], b[i + 1], b[i + 2]);
  return out;
}
