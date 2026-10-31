import { READING_SOLVED, type NetlistReading, type NetlistReadout } from '@controls/sim-protocol';
import {
  binWithHysteresis,
  CURRENT_SCALE,
  currentCoordinate,
  STEP_NO_SCALE,
  STEP_UNKNOWN,
  voltageCoordinate,
  type CurrentScale,
  type VoltageScale,
} from './overlay-scale';

/*
 * Display steps for the overlays (ADR 0011 §9.2 step 2): what each drawn terminal and lead shows,
 * from a netlist reading, in preallocated arrays. Pure and allocation-free, so the snapshot listener
 * can run it on every snapshot; the GPU side writes instance colours only for steps that changed.
 *
 * The join between drawn items and the netlist (which node a terminal is in, which branch a lead
 * compiled to) is resolved once per descriptor and per world change ({@link OverlayJoin}), never per
 * snapshot. An item missing from the generation (a lead added since the last descriptor, a device
 * the catalogue doesn't know) is unknown, never 0 V.
 */

/** Drawn items joined to one descriptor's numbering: −1 where the item isn't in the netlist. */
export interface OverlayJoin {
  /** Per drawn terminal: its node. */
  readonly terminalNode: Int32Array;
  /** Per drawn lead: its branch, and the nodes of its two ends (`connection.a`, `connection.b`). */
  readonly leadBranch: Int32Array;
  readonly leadNodeA: Int32Array;
  readonly leadNodeB: Int32Array;
}

/** What is drawn, in drawing order: terminals by (entity, terminal), leads by connection and ends. */
export interface OverlayItems {
  readonly terminals: readonly { readonly entity: number; readonly terminal: string }[];
  readonly leads: readonly {
    readonly connection: number;
    readonly a: { readonly entity: number; readonly terminal: string };
    readonly b: { readonly entity: number; readonly terminal: string };
  }[];
}

/** Joins `items` to `readout`'s descriptor (or to nothing: every item unknown). Once per descriptor or world change. */
export function joinOverlayItems(items: OverlayItems, readout: NetlistReadout | null): OverlayJoin {
  const node = (t: { readonly entity: number; readonly terminal: string }) =>
    readout === null ? -1 : readout.nodeOf(t.entity, t.terminal);
  return {
    terminalNode: Int32Array.from(items.terminals, node),
    leadBranch: Int32Array.from(items.leads, (l) => (readout === null ? -1 : readout.branchOfConnection(l.connection))),
    leadNodeA: Int32Array.from(items.leads, (l) => node(l.a)),
    leadNodeB: Int32Array.from(items.leads, (l) => node(l.b)),
  };
}

/** The steps drawn, one array per channel, kept across snapshots for hysteresis. */
export interface OverlaySteps {
  /** Per terminal: a voltage bin, {@link STEP_NO_SCALE} or {@link STEP_UNKNOWN}. */
  readonly terminalVolts: Uint8Array;
  /** Per lead, its `a` and `b` halves: a voltage step of that end's node. */
  readonly leadVoltsA: Uint8Array;
  readonly leadVoltsB: Uint8Array;
  /** Per lead: a current bin or {@link STEP_UNKNOWN} (current has one scale, so never no-scale). */
  readonly leadAmps: Uint8Array;
  /** Per lead: +1 (from `a` to `b`), −1, or 0 (AC: magnitude only; no current; unknown). */
  readonly leadDirection: Int8Array;
}

/** Steps for `terminals` and `leads` drawn items, all unknown until a reading is applied. */
export function createOverlaySteps(terminals: number, leads: number): OverlaySteps {
  return {
    terminalVolts: new Uint8Array(terminals).fill(STEP_UNKNOWN),
    leadVoltsA: new Uint8Array(leads).fill(STEP_UNKNOWN),
    leadVoltsB: new Uint8Array(leads).fill(STEP_UNKNOWN),
    leadAmps: new Uint8Array(leads).fill(STEP_UNKNOWN),
    leadDirection: new Int8Array(leads),
  };
}

/** Sets every step back to unknown (a new descriptor: no bin carries over). Allocation-free. */
export function resetOverlaySteps(steps: OverlaySteps): void {
  steps.terminalVolts.fill(STEP_UNKNOWN);
  steps.leadVoltsA.fill(STEP_UNKNOWN);
  steps.leadVoltsB.fill(STEP_UNKNOWN);
  steps.leadAmps.fill(STEP_UNKNOWN);
  steps.leadDirection.fill(0);
}

/** Everything a step update needs besides the steps themselves. */
export interface StepInputs {
  readonly readout: NetlistReadout | null;
  /** `null` (no snapshot: a source reset, or none yet) makes every step unknown. */
  readonly reading: NetlistReading | null;
  readonly join: OverlayJoin;
  /** Per `NOMINAL_BANDS` index: its voltage scale, or `null` (band 0, unknown bands): see `scalesByBand`. */
  readonly scales: readonly (VoltageScale | null)[];
  readonly currentScale?: CurrentScale;
}

function voltageStep(inputs: StepInputs, node: number, previous: number): number {
  const { readout, reading } = inputs;
  if (readout === null || reading === null || node < 0) return STEP_UNKNOWN;
  const island = readout.islandOfNode(node);
  if (reading.islandStatus[island] !== READING_SOLVED || reading.islandReferenced[island] !== 1) return STEP_UNKNOWN;
  const band = reading.islandBand[island];
  const scale = band < inputs.scales.length ? inputs.scales[band] : null;
  if (scale === null) return STEP_NO_SCALE;
  return binWithHysteresis(voltageCoordinate(reading.nodeVolts[node], scale), previous);
}

/**
 * Updates `steps` from `inputs` in place. Returns whether any step or direction changed (then, and
 * only then, the renderer rewrites colours and asks for a frame). Allocation-free.
 */
export function updateOverlaySteps(steps: OverlaySteps, inputs: StepInputs): boolean {
  let changed = false;
  const { join, readout, reading } = inputs;
  const currentScale = inputs.currentScale ?? CURRENT_SCALE;
  const t = steps.terminalVolts;
  for (let i = 0; i < t.length; i++) {
    const next = voltageStep(inputs, join.terminalNode[i], t[i]);
    if (next !== t[i]) {
      t[i] = next;
      changed = true;
    }
  }
  for (let j = 0; j < steps.leadAmps.length; j++) {
    const a = voltageStep(inputs, join.leadNodeA[j], steps.leadVoltsA[j]);
    const b = voltageStep(inputs, join.leadNodeB[j], steps.leadVoltsB[j]);
    let amps = STEP_UNKNOWN;
    let direction = 0;
    const branch = join.leadBranch[j];
    if (readout !== null && reading !== null && branch >= 0) {
      if (reading.islandStatus[readout.islandOfBranch(branch)] === READING_SOLVED) {
        amps = binWithHysteresis(currentCoordinate(reading.branchAmps[branch], currentScale), steps.leadAmps[j]);
        direction = amps === 0 ? 0 : reading.branchDirection[branch];
      }
    }
    if (
      a !== steps.leadVoltsA[j] ||
      b !== steps.leadVoltsB[j] ||
      amps !== steps.leadAmps[j] ||
      direction !== steps.leadDirection[j]
    ) {
      steps.leadVoltsA[j] = a;
      steps.leadVoltsB[j] = b;
      steps.leadAmps[j] = amps;
      steps.leadDirection[j] = direction;
      changed = true;
    }
  }
  return changed;
}
