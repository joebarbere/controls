import { lampDisplayLevel } from './display-curve';

/*
 * The lamp validity rule (plan F2.5, ADR 0011 §9.6): a lamp whose island isn't solved is never drawn
 * as an off lamp. A pure module (lint-fenced, like the display curve).
 *
 * - `solved`: drawn at its display level (dark when the level is 0, which is a real "off").
 * - `unsettled` (non-converged): drawn at its display level, but marked unsettled (a distinct tint).
 * - `unsolved` (unmodelled, AC pending, mixed) or `singular`: its values are no reading, so it is drawn
 *   "unknown", with no glow and a distinct blue-grey tint, never as a dark lamp.
 * - No output for the lamp (before the first snapshot, after a source reset, or missing from the
 *   map): unknown too.
 */

/** A lamp island's solve status, as the simulator's lamp record reports it. */
export type LampSolveStatus = 'unsolved' | 'solved' | 'unsettled' | 'singular';

/** One lamp's sim output, decoded from its device record by the host. */
export interface LampOutput {
  /** Light output relative to rated (1 = rated, above 1 over-voltage, 0 dark). A reading only when `solved`. */
  readonly lightOutputRel: number;
  readonly status: LampSolveStatus;
}

/** How a lamp is drawn: lit by its level, unknown (no reading), or lit but unsettled. */
export type LampDrawStatus = 'solved' | 'unknown' | 'unsettled';

/** What a lamp is drawn as; the scene-graph snapshot records it as `lamp`. */
export interface DrawnLamp {
  /** Emissive level, 0…255 (always 0 for an unknown lamp). */
  readonly level: number;
  readonly status: LampDrawStatus;
}

/** The validity rule's status for `output` (see the module comment). */
export function lampDrawStatus(output: LampOutput | undefined): LampDrawStatus {
  if (output === undefined) return 'unknown';
  if (output.status === 'solved') return 'solved';
  if (output.status === 'unsettled') return 'unsettled';
  return 'unknown';
}

/** The emissive level drawn for `output`: its display level when solved or unsettled, else 0. */
export function lampDrawLevel(output: LampOutput | undefined): number {
  if (output === undefined || lampDrawStatus(output) === 'unknown') return 0;
  return lampDisplayLevel(output.lightOutputRel);
}
