/**
 * Screen-space terminal picking (F3.2 part 3, ADR 0010 "Picking", ADR 0017 §9). Pure: no Three.js,
 * no DOM, no clock (lint-fenced), so the radius, pitch and occlusion rules are unit-tested in Node.
 *
 * Terminals are data points (each method's projected entry point), never meshes: a 3 px screw is no
 * target. A click picks **the nearest visible terminal within `min(16 px, pitch / 2)`**, where the
 * pitch is that terminal's distance to its nearest visible neighbour on screen. So a click is never
 * nearer a neighbour than the terminal it picks, and where terminals crowd (a 6 mm block row at the
 * default framing is 4 to 6 px) the radius shrinks with them instead of guessing. Visibility is the
 * caller's occlusion test (the BVH picker), asked lazily and only for terminals near the cursor.
 *
 * The **terminal-group pitch** of a device (the least nearest-neighbour distance of its on-screen
 * terminals, neighbours on other devices included, occlusion ignored) is what the UI compares with
 * {@link TERMINAL_TARGET_MIN_PX} to offer the one-key zoom (`view.focus` on the device).
 *
 * Everything is CSS pixels. Ties break by index (the caller's canonical order: entity id, then the
 * catalogue's terminal order), so the result never depends on iteration order. Queries allocate
 * nothing once the index has grown to the terminal count.
 */

/** Picking radius cap in CSS px (ADR 0010's spike measured 12; ADR 0017 §9 fixes 16). Game-design. */
export const TERMINAL_PICK_MAX_RADIUS_PX = 16;
/** Minimum comfortable target size (WCAG 2.2 SC 2.5.8, 24 × 24 CSS px): below it the zoom is offered. */
export const TERMINAL_TARGET_MIN_PX = 24;
/**
 * How far a pitch is looked for (CSS px). It must cover 2 × {@link TERMINAL_PICK_MAX_RADIUS_PX} (the
 * pick decision) and {@link TERMINAL_TARGET_MIN_PX} (the zoom offer); a terminal with no neighbour
 * this close has an ample pitch, reported as `Infinity`.
 */
export const TERMINAL_PITCH_SEARCH_PX = 48;

const cell = (v: number): number => Math.floor(v / TERMINAL_PITCH_SEARCH_PX);

/** A radius query's answer: the index's own scratch, valid until its next query. */
export interface ScreenQuery {
  readonly count: number;
  /** Point indices, nearest first (ties by index); the first `count` are valid. */
  readonly index: Int32Array;
  /** Their distances in px. */
  readonly distance: Float64Array;
}

/** Projected terminals in a uniform grid (cell = {@link TERMINAL_PITCH_SEARCH_PX}) for radius queries. */
export class ScreenPoints {
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private live = new Uint8Array(0);
  private n = 0;
  // The grid as a hash of cells in CSR form: `cellStart[h] … cellStart[h + 1]` index `items`.
  private mask = 0;
  private cellStart = new Int32Array(1);
  private cursor = new Int32Array(0);
  private items = new Int32Array(0);
  private cellOf = new Int32Array(0);
  // Query scratch.
  private readonly seenCells = new Int32Array(9);
  private readonly query: { count: number; index: Int32Array; distance: Float64Array } = {
    count: 0,
    index: new Int32Array(0),
    distance: new Float64Array(0),
  };

  /** Number of points (on screen or not). */
  get count(): number {
    return this.n;
  }

  /** Starts a new set of `count` points, all off screen until {@link set}. Grows storage only when needed. */
  reset(count: number): void {
    if (this.xs.length < count) {
      const capacity = Math.max(count, this.xs.length * 2, 16);
      this.xs = new Float64Array(capacity);
      this.ys = new Float64Array(capacity);
      this.live = new Uint8Array(capacity);
      this.items = new Int32Array(capacity);
      this.cellOf = new Int32Array(capacity);
      this.query.index = new Int32Array(capacity);
      this.query.distance = new Float64Array(capacity);
    }
    this.n = count;
    this.live.fill(0, 0, count);
  }

  /** Point `i` at (`x`, `y`) CSS px; `onScreen` false leaves it out of every query. */
  set(i: number, x: number, y: number, onScreen: boolean): void {
    this.xs[i] = x;
    this.ys[i] = y;
    this.live[i] = onScreen ? 1 : 0;
  }

  x(i: number): number {
    return this.xs[i];
  }

  y(i: number): number {
    return this.ys[i];
  }

  onScreen(i: number): boolean {
    return i >= 0 && i < this.n && this.live[i] === 1;
  }

  /** Buckets the on-screen points. Call after the {@link set}s and before any query. */
  build(): void {
    let size = 16;
    while (size < 2 * this.n) size *= 2;
    this.mask = size - 1;
    if (this.cellStart.length < size + 1) this.cellStart = new Int32Array(size + 1);
    if (this.cursor.length < size) this.cursor = new Int32Array(size);
    const start = this.cellStart;
    start.fill(0, 0, size + 1);
    for (let i = 0; i < this.n; i++) {
      if (this.live[i] === 0) continue;
      const h = this.hash(cell(this.xs[i]), cell(this.ys[i]));
      this.cellOf[i] = h;
      start[h + 1]++;
    }
    for (let h = 0; h < size; h++) start[h + 1] += start[h];
    // Filled in index order: a stable bucket sort.
    const cursor = this.cursor;
    cursor.fill(0, 0, size);
    for (let i = 0; i < this.n; i++) {
      if (this.live[i] === 0) continue;
      const h = this.cellOf[i];
      this.items[start[h] + cursor[h]++] = i;
    }
  }

  /**
   * The on-screen points within `radius` px of (`x`, `y`), nearest first (ties by index). The answer
   * is the index's scratch, valid until the next query. `radius` must be at most
   * {@link TERMINAL_PITCH_SEARCH_PX} (one ring of cells is searched).
   */
  within(x: number, y: number, radius: number): ScreenQuery {
    const q = this.query;
    const index = q.index;
    const distance = q.distance;
    let count = 0;
    const cx = cell(x);
    const cy = cell(y);
    const r2 = radius * radius;
    // Distinct buckets only: two neighbouring cells may hash to one.
    const seen = this.seenCells;
    let cells = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = this.hash(cx + dx, cy + dy);
        let dup = false;
        for (let c = 0; c < cells; c++) if (seen[c] === h) dup = true;
        if (dup) continue;
        seen[cells++] = h;
        for (let s = this.cellStart[h]; s < this.cellStart[h + 1]; s++) {
          const i = this.items[s];
          const ex = this.xs[i] - x;
          const ey = this.ys[i] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 > r2) continue;
          // Insertion into the sorted prefix (few points are ever this close).
          const d = Math.sqrt(d2);
          let j = count++;
          while (j > 0 && (distance[j - 1] > d || (distance[j - 1] === d && index[j - 1] > i))) {
            index[j] = index[j - 1];
            distance[j] = distance[j - 1];
            j--;
          }
          index[j] = i;
          distance[j] = d;
        }
      }
    }
    q.count = count;
    return q;
  }

  private hash(cx: number, cy: number): number {
    // Integer cell coordinates mixed into the table (Math.imul keeps it in 32 bits).
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & this.mask;
  }
}

/** The result of {@link pickScreenTerminal}; reused between calls. */
export interface ScreenTerminalPick {
  /** The terminal a click picks, or −1. */
  hit: number;
  /** The nearest visible terminal within {@link TERMINAL_PICK_MAX_RADIUS_PX} (picked or not), or −1. */
  near: number;
  /** The cursor's distance to `near` (px), or `Infinity`. */
  distancePx: number;
  /** `near`'s distance to its nearest visible neighbour (px), `Infinity` beyond {@link TERMINAL_PITCH_SEARCH_PX}. */
  pitchPx: number;
  /** The pick radius at `near`: `min(16, pitchPx / 2)` (px), or 0 without `near`. */
  radiusPx: number;
}

export const emptyTerminalPick = (): ScreenTerminalPick => ({
  hit: -1,
  near: -1,
  distancePx: Infinity,
  pitchPx: Infinity,
  radiusPx: 0,
});

/**
 * Where a click at (`x`, `y`) lands (see the module comment). `visible(i)` is the occlusion test;
 * it is asked only for terminals within the cap of the cursor, nearest first until one is visible,
 * and then for `near`'s neighbours nearest first until one is visible. Callers memoise it per frame.
 */
export function pickScreenTerminal(
  points: ScreenPoints,
  x: number,
  y: number,
  visible: (i: number) => boolean,
  out: ScreenTerminalPick = emptyTerminalPick(),
): ScreenTerminalPick {
  out.hit = -1;
  out.near = -1;
  out.distancePx = Infinity;
  out.pitchPx = Infinity;
  out.radiusPx = 0;
  const around = points.within(x, y, TERMINAL_PICK_MAX_RADIUS_PX);
  for (let k = 0; k < around.count; k++) {
    // `visible` may not query `points`: the answer is scratch until the next query.
    if (!visible(around.index[k])) continue;
    out.near = around.index[k];
    out.distancePx = around.distance[k];
    break;
  }
  const near = out.near;
  if (near < 0) return out;
  const neighbours = points.within(points.x(near), points.y(near), TERMINAL_PITCH_SEARCH_PX);
  for (let k = 0; k < neighbours.count; k++) {
    const j = neighbours.index[k];
    if (j === near || !visible(j)) continue;
    out.pitchPx = neighbours.distance[k];
    break;
  }
  out.radiusPx = Math.min(TERMINAL_PICK_MAX_RADIUS_PX, out.pitchPx / 2);
  if (out.distancePx <= out.radiusPx) out.hit = near;
  return out;
}

/**
 * A terminal group's pitch (px): the least distance from any of the points `from … to − 1` (a
 * device's terminals are contiguous in the canonical order) that is on screen to another on-screen
 * terminal, whoever's it is, occlusion ignored (a layout measure, not a pick). `Infinity` when none
 * of them has a neighbour within {@link TERMINAL_PITCH_SEARCH_PX}, or none is on screen.
 */
export function groupPitchPx(points: ScreenPoints, from: number, to: number): number {
  let pitch = Infinity;
  for (let i = from; i < to; i++) {
    if (!points.onScreen(i)) continue;
    const around = points.within(points.x(i), points.y(i), TERMINAL_PITCH_SEARCH_PX);
    for (let k = 0; k < around.count; k++) {
      if (around.index[k] === i) continue;
      if (around.distance[k] < pitch) pitch = around.distance[k];
      break;
    }
  }
  return pitch;
}
