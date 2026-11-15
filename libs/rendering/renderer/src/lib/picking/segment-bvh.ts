/**
 * Wire picking (F3.2 part 3, ADR 0010 "Picking", ADR 0017 §9): a BVH over the bounds of the drawn
 * wire segments, and an exact ray-to-capsule test whose radius is widened to at least
 * {@link WIRE_PICK_MIN_RADIUS_PX} on screen. Pure (lint-fenced): no Three.js, no DOM, no clock, so
 * it is unit-tested in Node and builds identically everywhere.
 *
 * - **Units are world millimetres** (the bake's tenths divided by ten); the ray direction is a unit
 *   vector. A capsule's radius at ray depth `s` (mm) is `max(r, minPx × pxAngle × s)`, where
 *   `pxAngle` is the world size of one CSS pixel per millimetre of distance (`2 tan(fov / 2) / heightPx`
 *   for a perspective camera), so a 1.6 mm wire is never thinner than 8 px of target across.
 * - **Ranking:** a ray that passes through a wire's real insulation (distance ≤ its radius) beats one
 *   that only passes within the widened radius; among real hits the nearest along the ray wins; among
 *   widened ones the nearest on screen (pixels from the centreline), then the nearer along the ray;
 *   then the lower segment index (the caller's bake order). So a wire in front wins when the pointer is
 *   on it, and the closest centreline wins in the gaps.
 * - **Build:** a binary tree split at the median of the longest axis of the centroids (a deterministic
 *   quickselect, ties by segment index), leaves of up to {@link LEAF_SIZE}; flat typed arrays. Queries
 *   allocate nothing.
 */

/** Minimum on-screen pick radius of a wire, CSS px (ADR 0010: "about 4 px"). Game-design. */
export const WIRE_PICK_MIN_RADIUS_PX = 4;

const LEAF_SIZE = 4;

/** A wire pick: which segment, how far along the ray, and how far off the centreline on screen. */
export interface SegmentRayHit {
  /** The segment index (as given to {@link SegmentBvh.build}). */
  segment: number;
  /** Ray parameter at the closest approach (mm from the origin). */
  depthMm: number;
  /** Distance from the centreline at the closest approach (mm). */
  offsetMm: number;
  /** That distance in CSS px at that depth. */
  offsetPx: number;
  /** Whether the ray passes through the wire's own radius (not just the widened target). */
  exact: boolean;
}

export const emptySegmentHit = (): SegmentRayHit => ({
  segment: -1,
  depthMm: Infinity,
  offsetMm: Infinity,
  offsetPx: Infinity,
  exact: false,
});

/** Closest approach of a ray to a segment; reused scratch. */
interface Approach {
  s: number; // along the ray, ≥ 0
  d2: number; // squared distance
}

/**
 * Closest approach between the ray `o + s·d` (`s ≥ 0`, `d` a unit vector) and the segment from `a`
 * to `b` (Ericson, "Real-Time Collision Detection" §5.1.9, with the ray's parameter clamped below
 * only). Writes `out.s` and `out.d2`.
 */
export function rayToSegment(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  out: { s: number; d2: number },
): void {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const rx = ox - ax;
  const ry = oy - ay;
  const rz = oz - az;
  const e = ux * ux + uy * uy + uz * uz;
  const b = dx * ux + dy * uy + dz * uz;
  const c = dx * rx + dy * ry + dz * rz;
  const f = ux * rx + uy * ry + uz * rz;
  let s: number;
  let t: number;
  if (e <= 1e-12) {
    t = 0;
    s = Math.max(0, -c);
  } else {
    const denom = e - b * b; // |d|² = 1
    s = denom > 1e-12 ? Math.max(0, (b * f - c * e) / denom) : 0;
    t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = Math.max(0, -c);
    } else if (t > 1) {
      t = 1;
      s = Math.max(0, b - c);
    }
  }
  const px = ox + s * dx - (ax + t * ux);
  const py = oy + s * dy - (ay + t * uy);
  const pz = oz + s * dz - (az + t * uz);
  out.s = s;
  out.d2 = px * px + py * py + pz * pz;
}

export class SegmentBvh {
  private n = 0;
  /** Per segment: a xyz, b xyz (mm). */
  private seg = new Float64Array(0);
  private radius = new Float64Array(0);
  /** Segments in tree order; leaves index ranges of it. */
  private order = new Int32Array(0);
  private centroid = new Float64Array(0);
  // Nodes: bounds (6 per node), first child (inner) or first segment (leaf), and leaf count (0: inner).
  private bounds = new Float64Array(0);
  private first = new Int32Array(0);
  private leafCount = new Int32Array(0);
  private nodes = 0;
  private stack = new Int32Array(64);
  private readonly approach: Approach = { s: 0, d2: 0 };
  private readonly span = new Float64Array(2);

  /** Number of segments indexed. */
  get size(): number {
    return this.n;
  }

  /**
   * Indexes `count` segments: `points` holds 6 numbers per segment (a, then b, mm) and `radii` one
   * radius per segment (mm). The arrays are copied.
   */
  build(points: ArrayLike<number>, radii: ArrayLike<number>, count: number): void {
    this.n = count;
    if (this.seg.length < 6 * count) {
      const capacity = Math.max(count, 16);
      this.seg = new Float64Array(6 * capacity);
      this.radius = new Float64Array(capacity);
      this.order = new Int32Array(capacity);
      this.centroid = new Float64Array(3 * capacity);
      const maxNodes = 2 * capacity;
      this.bounds = new Float64Array(6 * maxNodes);
      this.first = new Int32Array(maxNodes);
      this.leafCount = new Int32Array(maxNodes);
    }
    for (let i = 0; i < 6 * count; i++) this.seg[i] = points[i];
    for (let i = 0; i < count; i++) {
      this.radius[i] = radii[i];
      this.order[i] = i;
      const k = 6 * i;
      this.centroid[3 * i] = (this.seg[k] + this.seg[k + 3]) / 2;
      this.centroid[3 * i + 1] = (this.seg[k + 1] + this.seg[k + 4]) / 2;
      this.centroid[3 * i + 2] = (this.seg[k + 2] + this.seg[k + 5]) / 2;
    }
    this.nodes = 0;
    if (count > 0) this.buildNode(0, count, 0);
  }

  /** Empties the index (keeps its storage). */
  clear(): void {
    this.n = 0;
    this.nodes = 0;
  }

  /**
   * The best wire under the ray `o + s·d` (mm; `d` a unit vector) by the module's ranking, written
   * to `out`. Returns whether there was one. `pxAngle` is one CSS pixel's world size per mm of depth.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    pxAngle: number,
    out: SegmentRayHit,
    minRadiusPx = WIRE_PICK_MIN_RADIUS_PX,
  ): boolean {
    out.segment = -1;
    out.depthMm = Infinity;
    out.offsetMm = Infinity;
    out.offsetPx = Infinity;
    out.exact = false;
    if (this.nodes === 0) return false;
    const k = minRadiusPx * pxAngle;
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      if (!this.rayHitsNode(node, ox, oy, oz, ix, iy, iz, k)) continue;
      const count = this.leafCount[node];
      if (count === 0) {
        if (top + 2 > stack.length) {
          const grown = new Int32Array(stack.length * 2);
          grown.set(stack);
          this.stack = grown;
          return this.raycast(ox, oy, oz, dx, dy, dz, pxAngle, out, minRadiusPx); // once per growth
        }
        stack[top++] = this.first[node] + 1;
        stack[top++] = this.first[node];
        continue;
      }
      for (let m = this.first[node]; m < this.first[node] + count; m++) {
        this.testSegment(this.order[m], ox, oy, oz, dx, dy, dz, pxAngle, k, out);
      }
    }
    return out.segment >= 0;
  }

  private testSegment(
    i: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    pxAngle: number,
    k: number,
    out: SegmentRayHit,
  ): void {
    const p = this.seg;
    const j = 6 * i;
    const a = this.approach;
    rayToSegment(ox, oy, oz, dx, dy, dz, p[j], p[j + 1], p[j + 2], p[j + 3], p[j + 4], p[j + 5], a);
    const r = this.radius[i];
    const widened = Math.max(r, k * a.s);
    if (a.d2 > widened * widened) return;
    const offset = Math.sqrt(a.d2);
    const exact = a.d2 <= r * r;
    const offsetPx = a.s > 0 ? offset / (pxAngle * a.s) : 0;
    let better: boolean;
    if (out.segment < 0) better = true;
    else if (exact !== out.exact) better = exact;
    else if (exact) better = a.s < out.depthMm || (a.s === out.depthMm && i < out.segment);
    else
      better =
        offsetPx < out.offsetPx ||
        (offsetPx === out.offsetPx && (a.s < out.depthMm || (a.s === out.depthMm && i < out.segment)));
    if (!better) return;
    out.segment = i;
    out.depthMm = a.s;
    out.offsetMm = offset;
    out.offsetPx = offsetPx;
    out.exact = exact;
  }

  /** Slab test against the node's box grown by the widened radius at the box's far side. */
  private rayHitsNode(
    node: number,
    ox: number,
    oy: number,
    oz: number,
    ix: number,
    iy: number,
    iz: number,
    k: number,
  ): boolean {
    const b = this.bounds;
    const q = 6 * node;
    // An upper bound on the depth of any point in the box: centre distance plus half the diagonal.
    const hx = (b[q + 3] - b[q]) / 2;
    const hy = (b[q + 4] - b[q + 1]) / 2;
    const hz = (b[q + 5] - b[q + 2]) / 2;
    const cx = b[q] + hx - ox;
    const cy = b[q + 1] + hy - oy;
    const cz = b[q + 2] + hz - oz;
    const far = Math.sqrt(cx * cx + cy * cy + cz * cz) + Math.sqrt(hx * hx + hy * hy + hz * hz);
    const e = k * far;
    const span = this.span;
    span[0] = 0;
    span[1] = Infinity;
    return (
      slab(b[q] - e, b[q + 3] + e, ox, ix, span) &&
      slab(b[q + 1] - e, b[q + 4] + e, oy, iy, span) &&
      slab(b[q + 2] - e, b[q + 5] + e, oz, iz, span)
    );
  }

  /** Builds the node for `order[from … to)`, returns nothing; children are allocated in pairs. */
  private buildNode(from: number, to: number, node: number): void {
    if (node === 0) this.nodes = 1;
    const b = this.bounds;
    const q = 6 * node;
    b[q] = b[q + 1] = b[q + 2] = Infinity;
    b[q + 3] = b[q + 4] = b[q + 5] = -Infinity;
    let cminX = Infinity;
    let cminY = Infinity;
    let cminZ = Infinity;
    let cmaxX = -Infinity;
    let cmaxY = -Infinity;
    let cmaxZ = -Infinity;
    for (let m = from; m < to; m++) {
      const i = this.order[m];
      const j = 6 * i;
      const r = this.radius[i];
      const s = this.seg;
      b[q] = Math.min(b[q], s[j] - r, s[j + 3] - r);
      b[q + 1] = Math.min(b[q + 1], s[j + 1] - r, s[j + 4] - r);
      b[q + 2] = Math.min(b[q + 2], s[j + 2] - r, s[j + 5] - r);
      b[q + 3] = Math.max(b[q + 3], s[j] + r, s[j + 3] + r);
      b[q + 4] = Math.max(b[q + 4], s[j + 1] + r, s[j + 4] + r);
      b[q + 5] = Math.max(b[q + 5], s[j + 2] + r, s[j + 5] + r);
      const c = this.centroid;
      cminX = Math.min(cminX, c[3 * i]);
      cminY = Math.min(cminY, c[3 * i + 1]);
      cminZ = Math.min(cminZ, c[3 * i + 2]);
      cmaxX = Math.max(cmaxX, c[3 * i]);
      cmaxY = Math.max(cmaxY, c[3 * i + 1]);
      cmaxZ = Math.max(cmaxZ, c[3 * i + 2]);
    }
    const count = to - from;
    const ex = cmaxX - cminX;
    const ey = cmaxY - cminY;
    const ez = cmaxZ - cminZ;
    if (count <= LEAF_SIZE || Math.max(ex, ey, ez) === 0) {
      this.first[node] = from;
      this.leafCount[node] = count;
      return;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = from + (count >> 1);
    this.select(from, to - 1, mid, axis);
    const left = this.nodes;
    this.nodes += 2;
    this.first[node] = left;
    this.leafCount[node] = 0;
    this.buildNode(from, mid, left);
    this.buildNode(mid, to, left + 1);
  }

  /** Quickselect: `order[lo … hi]` partitioned so `order[k]` is in place by (centroid on `axis`, index). */
  private select(lo: number, hi: number, k: number, axis: number): void {
    const o = this.order;
    const c = this.centroid;
    const less = (i: number, j: number): boolean =>
      c[3 * i + axis] < c[3 * j + axis] || (c[3 * i + axis] === c[3 * j + axis] && i < j);
    while (hi > lo) {
      // Median of three as the pivot, deterministic.
      const m = (lo + hi) >> 1;
      if (less(o[m], o[lo])) swap(o, m, lo);
      if (less(o[hi], o[lo])) swap(o, hi, lo);
      if (less(o[hi], o[m])) swap(o, hi, m);
      const pivot = o[m];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (less(o[i], pivot)) i++;
        while (less(pivot, o[j])) j--;
        if (i <= j) {
          swap(o, i, j);
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }
}

function swap(a: Int32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/**
 * One slab of a ray–box test: narrows `span` ([enter, exit] along the ray) to where the ray, from
 * `o` with inverse direction `inv` on this axis, is between `lo` and `hi`. Returns whether any is left.
 */
function slab(lo: number, hi: number, o: number, inv: number, span: Float64Array): boolean {
  if (!Number.isFinite(inv)) return o >= lo && o <= hi; // parallel to the slab: inside it or never
  const t1 = (lo - o) * inv;
  const t2 = (hi - o) * inv;
  span[0] = Math.max(span[0], Math.min(t1, t2));
  span[1] = Math.min(span[1], Math.max(t1, t2));
  return span[0] <= span[1];
}
