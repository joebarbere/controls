import {
  CONNECTION_END_NONE,
  CONNECTION_VALUE_COUNT,
  CONNECTION_VALUE_INDEX,
  type NetlistReading,
  type NetlistReadout,
} from '@controls/sim-protocol';
import { HEAT_SCALE, heatStep, type HeatScale } from './heat-scale';
import { STEP_UNKNOWN } from './overlay-scale';

/*
 * Heat display steps (plan F3.6 part 3): what each drawn conductor or lead shows in the heat overlay,
 * from the protocol 7 connection records, in preallocated arrays. Pure and allocation-free, like
 * `overlay-steps`, so the snapshot listener runs it on every snapshot.
 *
 * **Each half shows the hottest node it contains** (D15's per-end halves): the conductor node is the
 * whole body, so half `a` holds it and end `a`'s hot spot, and shows max(T_c, T_a); likewise `b`. An
 * end with no termination node (state `none`: a lead's clip, an unlanded end, a terminal without a
 * method spec) has its temperature written 0 and is treated as absent (ADR 0011, protocol 7), so its
 * half shows the conductor. A loose termination therefore lights its own half, and a conductor
 * overloaded along its length lights both.
 *
 * **Temperatures are own state, always written**, whatever the record's `status` (`open`, unsolved,
 * …): a wire with a free end still has a temperature (the engine's thermal bank holds every lead and
 * conductor, netlisted or not), and an intermittent end that is open this dwell is still hot. So a
 * record's heat is shown for every status. **No reading** (unknown, never cold) is only: no snapshot
 * (none yet, a source reset), a connection with no record in the descriptor (one added since, or of a
 * kind the readout doesn't know, whose values read 0), or a conductor temperature that isn't a
 * positive number.
 *
 * Heat is a per-connection channel (ADR 0011 amendment §6): a new descriptor re-joins by connection id
 * ({@link joinHeat}) but keeps the steps, so an intermittent toggle's recompile doesn't reset them.
 */

const TC = CONNECTION_VALUE_INDEX['conductorTempK'];
const TA = CONNECTION_VALUE_INDEX['endATempK'];
const TB = CONNECTION_VALUE_INDEX['endBTempK'];
const SA = CONNECTION_VALUE_INDEX['endAState'];
const SB = CONNECTION_VALUE_INDEX['endBState'];

/** Per drawn item, its record's index in the descriptor's `connections` (and a reading), or −1. */
export function joinHeat(connections: readonly number[], readout: NetlistReadout | null): Int32Array {
  return Int32Array.from(connections, (c) => (readout === null ? -1 : readout.recordOfConnection(c)));
}

/** Heat steps per drawn item: half `a` and half `b` (a heat bin, over range or {@link STEP_UNKNOWN}). */
export interface HeatSteps {
  readonly a: Uint8Array;
  readonly b: Uint8Array;
}

/** Steps for `count` items, all unknown until a reading is applied. */
export function createHeatSteps(count: number): HeatSteps {
  return { a: new Uint8Array(count).fill(STEP_UNKNOWN), b: new Uint8Array(count).fill(STEP_UNKNOWN) };
}

/**
 * Updates `steps` from `reading` through `records` (from {@link joinHeat}) in place. Returns whether any
 * step changed. Allocation-free.
 */
export function updateHeatSteps(
  steps: HeatSteps,
  reading: NetlistReading | null,
  records: Int32Array,
  scale: HeatScale = HEAT_SCALE,
): boolean {
  let changed = false;
  const values = reading?.connectionValues;
  const recordCount = values === undefined ? 0 : values.length / CONNECTION_VALUE_COUNT;
  for (let j = 0; j < steps.a.length; j++) {
    const r = records[j];
    let a = STEP_UNKNOWN;
    let b = STEP_UNKNOWN;
    if (values !== undefined && r >= 0 && r < recordCount) {
      const base = r * CONNECTION_VALUE_COUNT;
      const tc = values[base + TC];
      if (tc > 0) {
        const ta = values[base + SA] !== CONNECTION_END_NONE && values[base + TA] > tc ? values[base + TA] : tc;
        const tb = values[base + SB] !== CONNECTION_END_NONE && values[base + TB] > tc ? values[base + TB] : tc;
        a = heatStep(ta, steps.a[j], scale);
        b = heatStep(tb, steps.b[j], scale);
      }
    }
    if (a !== steps.a[j] || b !== steps.b[j]) {
      steps.a[j] = a;
      steps.b[j] = b;
      changed = true;
    }
  }
  return changed;
}
