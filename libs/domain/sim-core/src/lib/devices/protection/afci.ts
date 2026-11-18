import type { AfciLimits } from '@controls/catalog';
import { INTERMITTENT_MIN_DWELL_TICKS, intermittentDrawU32 } from '../../contact/regimes';
import type { Netlist } from '../../netlist/types';

/*
 * The combination AFCI's series-arc detection (P4 D8, ADR 0019 "PRNG stream keys", ADR 0021 part 2):
 * a probabilistic trip on series arcing (ADR 0018's `arcing` end state) downstream of the breaker.
 *
 * - **Buckets.** Arcing is judged per intermittent bucket (100 ticks, absolute boundaries), the bucket
 *   a conductor end's state is decided for (ADR 0018 §6). At each boundary the AFCI looks at the state
 *   of the bucket that just ended: an end arcing on a connection **downstream** of it (in its load-side
 *   cut set, below), carrying I ≥ 5 A (the region's `minArcCurrentA`; nothing is required below it,
 *   and the model never trips on less).
 * - **Exposure.** Each counted bucket adds Δt / T(I) to the persisted `arcExposure` x (clamped at 1);
 *   "only arcing buckets count" is game-design (D8). T(I) is the region's detection limit rounded down
 *   to whole buckets (at least one), so the bucket that takes x to 1 is never later than the limit:
 *   the limit is 1 s at 5 A (`maxTripAtMinS`) and under 0.2 s at 1.5 × the rating
 *   (`maxTripAtRatedMultipleS`, `ratedMultiple`), and between the two the model interpolates linearly
 *   **in rate** (1/t), the GFCI's rule; those in-between points are labelled interpolation, not the
 *   standard's. At and above 1.5 × rated, "under 0.2 s" with 100 ms buckets is one bucket.
 * - **The draw.** At the boundary the AFCI trips if u < (x − x_prev) / (1 − x_prev), u from the
 *   `entity:<id>:afci` stream's first output mixed with the ended bucket's index by integer operations
 *   (`intermittentDrawU32`, ADR 0018's helper), so the probability of no trip by a boundary is exactly
 *   1 − x, and the cumulative trip probability reaches 1 by the limit. The outcome is a pure function
 *   of (seed, id, bucket) and the persisted keys: the same after a save and load, on replay and on
 *   either transport.
 * - **Quiet reset.** x resets to 0 a quiet gap (`AFCI_QUIET_RESET_TICKS`) after the last counted
 *   bucket (`arcLastSeenTick`).
 *
 * **Downstream** is a cut set, computed lazily (only when some end is arcing) and cached per netlist:
 * every node reached from the breaker's load-side terminals (`load`, `loadNeutral`) without crossing
 * its own poles. An arcing connection with either end in that set is downstream; one on the line side,
 * on another breaker's circuit or anywhere not reached is not. **Abstraction:** a second path from the
 * load side back to the line side (a ground fault into the EGC, a neutral shared with another circuit)
 * widens the set to what that path reaches; the realistic share of the arc current through the AFCI
 * is not computed.
 */

/** The region's AFCI limits as the model reads them (plain numbers). */
export interface AfciLimitValues {
  readonly minArcCurrentA: number;
  readonly maxTripAtMinS: number;
  readonly ratedMultiple: number;
  readonly maxTripAtRatedMultipleS: number;
}

export function afciLimitValues(limits: AfciLimits): AfciLimitValues {
  return {
    minArcCurrentA: limits.minArcCurrentA.value,
    maxTripAtMinS: limits.maxTripAtMinS.value,
    ratedMultiple: limits.ratedMultiple.value,
    maxTripAtRatedMultipleS: limits.maxTripAtRatedMultipleS.value,
  };
}

const BUCKET_TICKS = INTERMITTENT_MIN_DWELL_TICKS.value;
const BUCKET_S = BUCKET_TICKS / 1000;
const TWO_POW_32 = 4294967296;

/**
 * The region's detection limit (s) at an arc current `amps` on a device rated `ratedA`: 1 / rate, the
 * rate linear between the two published points (labelled interpolation); `Infinity` below the minimum
 * arc current. At and above the rated multiple it is the multiple's limit, which is a strict bound.
 */
export function afciLimitS(amps: number, ratedA: number, limits: AfciLimitValues): number {
  if (!(amps >= limits.minArcCurrentA)) return Infinity;
  const top = limits.ratedMultiple * ratedA;
  if (amps >= top) return limits.maxTripAtRatedMultipleS;
  const r0 = 1 / limits.maxTripAtMinS;
  const r1 = 1 / limits.maxTripAtRatedMultipleS;
  return 1 / (r0 + ((r1 - r0) * (amps - limits.minArcCurrentA)) / (top - limits.minArcCurrentA));
}

/**
 * How many whole 100 ms buckets fit within the detection limit at `amps` (at least 1), the model's
 * T(I) / Δt; 0 below the minimum arc current (the bucket doesn't count). At and above the rated
 * multiple the limit is strict ("under 0.2 s"), so a bucket count reaching it exactly is one fewer.
 */
export function afciDetectionBuckets(amps: number, ratedA: number, limits: AfciLimitValues): number {
  const limit = afciLimitS(amps, ratedA, limits);
  if (limit === Infinity) return 0;
  const strict = amps >= limits.ratedMultiple * ratedA;
  // Tick counts are integers: the limit in ticks, then whole buckets in it (a hair of tolerance for the
  // division's rounding at a whole number of buckets, such as 1 s = 10 buckets).
  const buckets = Math.floor(limit / BUCKET_S + 1e-9);
  const whole = strict && buckets * BUCKET_S >= limit - 1e-12 ? buckets - 1 : buckets;
  return Math.max(1, whole);
}

/** The AFCI's draw for `bucket` from its stream's first output `first`: u in [0, 1). */
export function afciDraw(first: number, bucket: number): number {
  return intermittentDrawU32(first, bucket) / TWO_POW_32;
}

/** The exposure after one counted bucket of `buckets` (≥ 1) from `x`, and whether u trips it. */
export function afciBucket(x: number, buckets: number, u: number): { readonly x: number; readonly trip: boolean } {
  const next = Math.min(1, x + 1 / buckets);
  const trip = next >= 1 || u < (next - x) / (1 - x);
  return { x: next, trip };
}

/** A netlist's node → branch adjacency (compressed rows), built once per netlist object. */
interface Adjacency {
  readonly start: Int32Array;
  readonly branches: Int32Array;
}

const adjacencies = new WeakMap<Netlist, Adjacency>();

function adjacencyOf(netlist: Netlist): Adjacency {
  const cached = adjacencies.get(netlist);
  if (cached !== undefined) return cached;
  const nodes = netlist.nodes.length;
  const start = new Int32Array(nodes + 1);
  for (const b of netlist.branches) {
    start[b.a + 1]++;
    if (b.b !== b.a) start[b.b + 1]++;
  }
  for (let n = 0; n < nodes; n++) start[n + 1] += start[n];
  const fill = start.slice(0, nodes);
  const branches = new Int32Array(start[nodes]);
  for (const b of netlist.branches) {
    branches[fill[b.a]++] = b.index;
    if (b.b !== b.a) branches[fill[b.b]++] = b.index;
  }
  const adjacency = { start, branches };
  adjacencies.set(netlist, adjacency);
  return adjacency;
}

/**
 * Marks in `out` (one byte per node, cleared first) every node reached from `from` without crossing a
 * branch in `excluded`: the load side of a protective device whose poles are `excluded`. Allocates a
 * stack (lazy, only when some end is arcing).
 */
export function markDownstream(
  netlist: Netlist,
  from: readonly number[],
  excluded: readonly number[],
  out: Uint8Array,
): void {
  out.fill(0);
  const { start, branches } = adjacencyOf(netlist);
  const stack: number[] = [];
  for (const n of from) {
    if (n >= 0 && out[n] === 0) {
      out[n] = 1;
      stack.push(n);
    }
  }
  while (stack.length > 0) {
    const n = stack.pop() as number;
    for (let k = start[n]; k < start[n + 1]; k++) {
      const index = branches[k];
      if (excluded.includes(index)) continue;
      const branch = netlist.branches[index];
      const other = branch.a === n ? branch.b : branch.a;
      if (out[other] === 0) {
        out[other] = 1;
        stack.push(other);
      }
    }
  }
}
