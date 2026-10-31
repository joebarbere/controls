import type { DeviceOutputField } from '@controls/sim-protocol';
import type { LayerContext, SimIslandStatus } from '../engine/device-model';

/*
 * The validity rule for device records (plan F2.4 and F2.5, ADR 0011 §5.4): **a record's solved
 * quantities are a reading only on a solved island.** Every F2.4 record carries a `u8 status` field
 * saying which:
 *
 * - `unsolved` (code 0, so a zeroed record is never a reading): the island isn't solved (unmodelled,
 *   mixed, or no solution yet);
 * - `solved`: a reading;
 * - `unsettled`: the outer loop hit its cap (`nonConverged`). The values are the last linear solve's
 *   and look real, but aren't steady: every readout shows them as unsettled, never as a value;
 * - `singular`: a loop of ideal sources; there is no defined value.
 *
 * Fields computed from the solution (a terminal voltage, a current) are written as 0 unless the status
 * is `solved`, so no reader can show one by mistake. Fields that are the device's own sim state (a
 * state of charge, a supply's mode) are always written: they are true whatever the island's status,
 * and a reader shows them beside the status (an unsettled supply's mode is shown as unsettled too).
 */

/** The `status` field's values, by code. */
export const READING_STATUS_VALUES = Object.freeze(['unsolved', 'solved', 'unsettled', 'singular'] as const);
export type ReadingStatus = (typeof READING_STATUS_VALUES)[number];

export const READING_UNSOLVED = 0;
export const READING_SOLVED = 1;
export const READING_UNSETTLED = 2;
export const READING_SINGULAR = 3;

/** The record status of an island in `status`. */
export function readingStatusCode(status: SimIslandStatus): number {
  switch (status) {
    case 'solved':
      return READING_SOLVED;
    case 'nonConverged':
      return READING_UNSETTLED;
    case 'singular':
      return READING_SINGULAR;
    default:
      return READING_UNSOLVED;
  }
}

/** The record status of `branch`'s island in the context's solution. */
export function branchReading(ctx: LayerContext, branch: number): number {
  return readingStatusCode(ctx.islandStatus(ctx.netlist.branches[branch].island));
}

/** A `u8` enum field with `values` by code. */
export function enumField(name: string, offset: number, values: readonly string[]): DeviceOutputField {
  return { name, type: 'u8', offset, unit: null, values };
}

/** The `status` field at `offset` (a `u8` enum of {@link READING_STATUS_VALUES}). */
export function statusField(offset: number): DeviceOutputField {
  return enumField('status', offset, READING_STATUS_VALUES);
}

/** An `f64` field. */
export function f64Field(name: string, offset: number, unit: string | null): DeviceOutputField {
  return { name, type: 'f64', offset, unit, values: null };
}
