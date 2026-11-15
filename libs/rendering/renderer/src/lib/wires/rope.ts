/*
 * The live preview rope (F3.2 part 2, ADR 0010 "Live versus baked"): the one wire that is simulated,
 * the route being drawn, as a Verlet rope pinned at its terminal points, waypoints and the cursor.
 * Pure and GPU-free (lint-fenced): typed arrays, no `Math.random`, no clock. A frame is a fixed
 * number of fixed substeps whatever the frame time, so the same pins and the same number of frames
 * give the same shape. It is a picture only: never committed, stored or hashed (ADR 0017 §7); what a
 * gesture commits is the router's explicit waypoints and a length, through `wire.add`.
 *
 * Re-pinning keeps the rope's shape: each span's particles start from the old span's sag laid on the
 * new chord, so moving the cursor slides the rope instead of snapping it straight (the spike's
 * "the live preview pops").
 */

/** A point in mm. */
export interface RopePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The rope's tuning (ADR 0010's spike values, game-design; the slack is the bake's 1 % sag cap). */
export const ROPE_TUNING = Object.freeze({
  /** Particle spacing (mm). */
  spacingMm: 15,
  /** Extra length per span, as a fraction of its chord (the bake's sag cap, ADR 0017 §7). */
  slack: 0.01,
  /** Substeps per frame, each of `dt` seconds. */
  substeps: 2,
  dt: 1 / 120,
  /** Constraint passes per substep. */
  passes: 12,
  /** Velocity kept per substep. */
  damping: 0.98,
  /** mm/s², along −y. */
  gravityMmPerS2: 9810,
  /** A frame whose largest particle move is below this (mm) is quiet. */
  settleMoveMm: 0.01,
  /** Quiet frames in a row before the rope counts as settled. */
  settleFrames: 10,
  /** Frames after which it counts as settled anyway (5 s at 120 Hz substeps). */
  maxFrames: 300,
  /** Most particles (a very long preview takes a wider spacing instead). */
  maxParticles: 1024,
});

export class VerletRope {
  private pos = new Float64Array(0);
  private prev = new Float64Array(0);
  private pinned = new Uint8Array(0);
  private rest = new Float64Array(0);
  /**
   * Long-range tethers: per particle, its span's two pin particles and the rope length to each. A
   * nearly taut rope is the stiffest case for Verlet (the spike's 3 % rope sagged 55 mm where the
   * parabola gives 32), so each particle is also kept within its rope length of both pins, which
   * removes the stretch the link passes leave.
   */
  private tetherA = new Int32Array(0);
  private tetherB = new Int32Array(0);
  private tetherLengthA = new Float64Array(0);
  private tetherLengthB = new Float64Array(0);
  /** Per pin: its particle index. */
  private pinAt = new Int32Array(0);
  private pins: RopePoint[] = [];
  private countValue = 0;
  private framesValue = 0;
  private quiet = 0;
  private settledValue = true;

  /** Particles in use. */
  get count(): number {
    return this.countValue;
  }

  /** Frames stepped since the last re-pin. */
  get frames(): number {
    return this.framesValue;
  }

  /** Whether the rope has stopped moving (nothing to draw until the pins change). */
  get settled(): boolean {
    return this.settledValue;
  }

  /** Particle `i`'s coordinates (mm). */
  x(i: number): number {
    return this.pos[3 * i];
  }
  y(i: number): number {
    return this.pos[3 * i + 1];
  }
  z(i: number): number {
    return this.pos[3 * i + 2];
  }

  /** Whether particle `i` is a pin. */
  isPinned(i: number): boolean {
    return this.pinned[i] === 1;
  }

  /**
   * Pins the rope through `pins` (mm, in order: at least two to draw anything). Unchanged pins are a
   * no-op. Otherwise each span is re-subdivided and starts from the old span's sag on its new chord,
   * at rest, and the rope is unsettled again.
   */
  setPins(pins: readonly RopePoint[]): void {
    if (samePins(pins, this.pins)) return;
    const old = {
      pos: this.pos.slice(0, 3 * this.countValue),
      pinAt: this.pinAt.slice(0, this.pins.length),
      pins: this.pins,
    };
    this.pins = pins.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    this.framesValue = 0;
    this.quiet = 0;
    if (pins.length < 2) {
      this.countValue = 0;
      this.settledValue = true;
      return;
    }
    const t = ROPE_TUNING;
    const chords = this.pins.slice(1).map((p, k) => distance(this.pins[k], p));
    const total = chords.reduce((s, c) => s + c, 0);
    // A long preview takes a wider spacing rather than more particles than the cap.
    const spacing = Math.max(t.spacingMm, total / (t.maxParticles - pins.length));
    const links = chords.map((c) => Math.max(1, Math.ceil(c / spacing)));
    const count = links.reduce((s, n) => s + n, 0) + 1;
    this.reserve(count);
    let i = 0;
    for (let k = 0; k < links.length; k++) {
      const a = this.pins[k];
      const b = this.pins[k + 1];
      const n = links[k];
      for (let j = 0; j < n; j++) {
        const f = j / n;
        let x = a.x + (b.x - a.x) * f;
        let y = a.y + (b.y - a.y) * f;
        let z = a.z + (b.z - a.z) * f;
        if (j > 0 && k + 1 < old.pins.length) {
          // The old span's offset from its own chord at the same fraction.
          const s = old.pinAt[k];
          const e = old.pinAt[k + 1];
          const at = s + (e - s) * f;
          const lo = Math.floor(at);
          const hi = Math.min(e, lo + 1);
          const w = at - lo;
          const oa = old.pins[k];
          const ob = old.pins[k + 1];
          for (let c = 0; c < 3; c++) {
            const rope = old.pos[3 * lo + c] * (1 - w) + old.pos[3 * hi + c] * w;
            const chord =
              c === 0 ? oa.x + (ob.x - oa.x) * f : c === 1 ? oa.y + (ob.y - oa.y) * f : oa.z + (ob.z - oa.z) * f;
            if (c === 0) x += rope - chord;
            else if (c === 1) y += rope - chord;
            else z += rope - chord;
          }
        }
        this.pos[3 * i] = x;
        this.pos[3 * i + 1] = y;
        this.pos[3 * i + 2] = z;
        this.pinned[i] = j === 0 ? 1 : 0;
        if (j === 0) this.pinAt[k] = i;
        this.rest[i] = (chords[k] * (1 + t.slack)) / n;
        this.tetherA[i] = i - j;
        this.tetherB[i] = i - j + n;
        this.tetherLengthA[i] = this.rest[i] * j;
        this.tetherLengthB[i] = this.rest[i] * (n - j);
        i++;
      }
    }
    const last = this.pins[this.pins.length - 1];
    this.pos[3 * i] = last.x;
    this.pos[3 * i + 1] = last.y;
    this.pos[3 * i + 2] = last.z;
    this.pinned[i] = 1;
    this.pinAt[links.length] = i;
    this.countValue = count;
    this.prev.set(this.pos.subarray(0, 3 * count));
    this.settledValue = false;
  }

  /**
   * One frame: {@link ROPE_TUNING}`.substeps` Verlet substeps of a fixed `dt`, each with the distance
   * constraints relaxed `passes` times. Allocation-free. Returns `true` while the rope still moves
   * (another frame is wanted), `false` once it has settled.
   */
  step(): boolean {
    if (this.settledValue) return false;
    const t = ROPE_TUNING;
    const n = this.countValue;
    const pos = this.pos;
    const prev = this.prev;
    const g = -t.gravityMmPerS2 * t.dt * t.dt;
    let moved = 0;
    for (let s = 0; s < t.substeps; s++) {
      for (let i = 0; i < n; i++) {
        if (this.pinned[i] === 1) continue;
        for (let c = 0; c < 3; c++) {
          const k = 3 * i + c;
          const v = (pos[k] - prev[k]) * t.damping;
          prev[k] = pos[k];
          pos[k] += v + (c === 1 ? g : 0);
        }
      }
      for (let pass = 0; pass < t.passes; pass++) {
        // Alternate the sweep direction: sweeping one way only leaves the far end stretched.
        const forward = (pass & 1) === 0;
        for (let k = 0; k + 1 < n; k++) {
          const i = forward ? k : n - 2 - k;
          const a = 3 * i;
          const b = a + 3;
          const dx = pos[b] - pos[a];
          const dy = pos[b + 1] - pos[a + 1];
          const dz = pos[b + 2] - pos[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d === 0) continue;
          const pa = this.pinned[i] === 1;
          const pb = this.pinned[i + 1] === 1;
          if (pa && pb) continue;
          const diff = (d - this.rest[i]) / d;
          const wa = pa ? 0 : pb ? 1 : 0.5;
          const wb = pb ? 0 : pa ? 1 : 0.5;
          pos[a] += dx * diff * wa;
          pos[a + 1] += dy * diff * wa;
          pos[a + 2] += dz * diff * wa;
          pos[b] -= dx * diff * wb;
          pos[b + 1] -= dy * diff * wb;
          pos[b + 2] -= dz * diff * wb;
        }
        for (let i = 0; i < n; i++) {
          if (this.pinned[i] === 1) continue;
          this.tether(i, this.tetherA[i], this.tetherLengthA[i]);
          this.tether(i, this.tetherB[i], this.tetherLengthB[i]);
        }
      }
    }
    // The last substep's largest move tells whether the rope is still going.
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const dx = pos[k] - prev[k];
      const dy = pos[k + 1] - prev[k + 1];
      const dz = pos[k + 2] - prev[k + 2];
      const m = dx * dx + dy * dy + dz * dz;
      if (m > moved) moved = m;
    }
    this.framesValue++;
    this.quiet = moved < t.settleMoveMm * t.settleMoveMm ? this.quiet + 1 : 0;
    if (this.quiet >= t.settleFrames || this.framesValue >= t.maxFrames) this.settledValue = true;
    return !this.settledValue;
  }

  /** Pulls particle `i` back to within `length` of pin particle `pin`. */
  private tether(i: number, pin: number, length: number): void {
    const pos = this.pos;
    const a = 3 * pin;
    const k = 3 * i;
    const dx = pos[k] - pos[a];
    const dy = pos[k + 1] - pos[a + 1];
    const dz = pos[k + 2] - pos[a + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d <= length || d === 0) return;
    const f = length / d;
    pos[k] = pos[a] + dx * f;
    pos[k + 1] = pos[a + 1] + dy * f;
    pos[k + 2] = pos[a + 2] + dz * f;
  }

  /** Grows the buffers (doubling) to hold `count` particles; only on a re-pin, never per frame. */
  private reserve(count: number): void {
    if (this.pinned.length >= count && this.pinAt.length >= this.pins.length) return;
    let capacity = Math.max(16, this.pinned.length);
    while (capacity < count) capacity *= 2;
    this.pos = new Float64Array(3 * capacity);
    this.prev = new Float64Array(3 * capacity);
    this.pinned = new Uint8Array(capacity);
    this.rest = new Float64Array(capacity);
    this.tetherA = new Int32Array(capacity);
    this.tetherB = new Int32Array(capacity);
    this.tetherLengthA = new Float64Array(capacity);
    this.tetherLengthB = new Float64Array(capacity);
    this.pinAt = new Int32Array(Math.max(capacity, this.pins.length));
  }
}

function distance(a: RopePoint, b: RopePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function samePins(a: readonly RopePoint[], b: readonly RopePoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].z !== b[i].z) return false;
  return true;
}
