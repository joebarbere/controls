import type { SourcedConstant } from '../../constants';
import type { DcSolution } from '../../mna/dc';
import { DC_STAMP_ISOURCE, type DcBranchValues } from '../../mna/values';
import type { NetlistBranch } from '../../netlist/types';

/*
 * Constant-voltage / constant-current regulation (plan F2.4), shared by the bench supply and the DIN
 * PSU. A regulated output is one `vsource` element from `neg` (a) to `pos` (b), stamped either way:
 *
 * - **CV:** the setpoint E behind the output resistance R (`vsource(E, R)`), so V = E − R·I;
 * - **CC:** exactly the current limit I_lim out of `pos` (`isource(I_lim)`), whatever the voltage.
 *
 * The two meet at the **crossover**, where the CV output reaches the limit: I = I_lim and
 * V = V_knee = E − R · I_lim, so a resistive load R_L crosses over at R_L = V_knee / I_lim = E / I_lim − R
 * (within R / (E / I_lim) of E / I_lim: 0.008 % for 12 V and 1 A behind 1 mΩ).
 *
 * The mode is a discrete choice inside the nonlinear outer loop (`DcIterationHook`): each iteration
 * looks at the iterate and the mode it was solved in (the branch's current stamp) and decides:
 *
 * - CV → CC when the current exceeds the limit by more than the hysteresis band;
 * - CC → CV when the voltage exceeds the knee by more than the band.
 *
 * Inside the band the mode stays, so a load sitting exactly at the crossover (or rounding noise, or a
 * damped iterate) can never make the loop or successive solves flip between modes: **no chatter**.
 * The cost is that the output may exceed a setpoint by the band, which is the tolerance the
 * never-exceeds property checks: in CV, I ≤ I_lim (1 + h) + i₀; in CC, V ≤ V_knee + h · E + v₀.
 *
 * The supply's mode is committed after each solve from the stamp it was solved with (`afterSolve`),
 * kept in its `sim` bag, and starts the next solve, so a save, a load and a topology change all
 * continue in the same mode (ADR 0011 §9.6).
 *
 * Sinking: in CV the element is an ideal source behind R, so a higher source driving current into a
 * supply's `pos` makes it sink current (I < 0). Real bench supplies mostly can't sink; an abstraction
 * recorded in the simulation caveats.
 */

/** The relative hysteresis band of the CV/CC crossover. */
export const CV_CC_HYSTERESIS: SourcedConstant = {
  value: 1e-3,
  unit: '1',
  kind: 'numerical',
  source:
    "numerical: a band of 0.1 % of the setpoint either side of the crossover, inside which the regulation mode keeps its last value, so a load at the crossover (or a damped outer-loop iterate, or rounding) never flips the mode back and forth. 0.1 % is far above the solver's noise (about 1e-15 relative) and below a 4-digit bench meter's resolution at full scale (30.00 V reads to 0.03 %), and well inside the 0.5 % crossover tolerance of plan F2.4. A real supply's crossover is a soft knee over a similar fraction of the setpoint; its shape is not modelled.",
};

/** The absolute current floor of the band, for limits near 0 A. */
export const CV_CC_HYSTERESIS_AMPS: SourcedConstant = {
  value: 1e-6,
  unit: 'A',
  kind: 'numerical',
  source:
    "numerical: 1 µA added to the current band, so a limit of 0 A (or a few µA) still has a band above the outer loop's current resolution (OUTER_LOOP_ABSTOL is 1 pA); below any bench meter's current resolution.",
};

/** The absolute voltage floor of the band, for setpoints near 0 V. */
export const CV_CC_HYSTERESIS_VOLTS: SourcedConstant = {
  value: 1e-6,
  unit: 'V',
  kind: 'numerical',
  source:
    "numerical: 1 µV added to the voltage band, so a setpoint of 0 V still has a band above the outer loop's voltage tolerance (OUTER_LOOP_VNTOL is 1 nV); below any bench meter's resolution.",
};

/** Regulation modes, as banks store them. */
export const REG_CV = 0;
export const REG_CC = 1;

/** The band above the limit before CV gives way to CC (A). */
export function currentBand(limitA: number): number {
  return CV_CC_HYSTERESIS.value * limitA + CV_CC_HYSTERESIS_AMPS.value;
}

/** The band above the knee before CC gives way to CV (V). */
export function voltageBand(setpointV: number): number {
  return CV_CC_HYSTERESIS.value * setpointV + CV_CC_HYSTERESIS_VOLTS.value;
}

/**
 * The next mode for an output solved in `mode` that carried `amps` (out of `pos`) at `volts`
 * (V(pos) − V(neg)), with setpoint `setpointV`, limit `limitA` and output resistance `ohms`.
 */
export function regulate(
  mode: number,
  amps: number,
  volts: number,
  setpointV: number,
  limitA: number,
  ohms: number,
): number {
  if (mode === REG_CV) return amps > limitA + currentBand(limitA) ? REG_CC : REG_CV;
  return volts > setpointV - limitA * ohms + voltageBand(setpointV) ? REG_CV : REG_CC;
}

/**
 * A bank's regulated outputs' settings, one slot per device: what `stampRegulated` and
 * `iterateRegulated` read by index. They take a slot, never the values: a non-integer double passed
 * to a call V8 doesn't inline is boxed into a heap number, and these run in the outer loop of every
 * solve (simulation caveats, "Allocation that depends on inlining").
 */
export class RegulatorSettings {
  readonly setpointV: Float64Array;
  readonly limitA: Float64Array;
  readonly ohms: Float64Array;

  constructor(count: number) {
    this.setpointV = new Float64Array(count);
    this.limitA = new Float64Array(count);
    this.ohms = new Float64Array(count);
  }
}

/** Stamps `branch` in `mode`, with slot `i`'s settings. */
export function stampRegulated(
  values: DcBranchValues,
  branch: number,
  mode: number,
  settings: RegulatorSettings,
  i: number,
): void {
  if (mode === REG_CC) values.isourceAt(branch, settings.limitA, i);
  else values.vsourceAt(branch, settings.setpointV, settings.ohms, i);
}

/** The mode `branch` is stamped in: CC for a current source, else CV. */
export function stampedMode(values: DcBranchValues, branch: number): number {
  return values.stamps[branch] === DC_STAMP_ISOURCE ? REG_CC : REG_CV;
}

/**
 * The outer loop's step for a regulated output that is on: from `iterate` and the mode `branch` was
 * solved in (its stamp in `values`), or from `start` on a cold start (`iterate` null).
 */
export function iterateRegulated(
  branch: NetlistBranch,
  iterate: DcSolution | null,
  values: DcBranchValues,
  start: number,
  settings: RegulatorSettings,
  i: number,
): void {
  const b = branch.index;
  let mode = start;
  if (iterate !== null) {
    // `regulate`, written out on the slot's settings (so no double crosses a call): the same
    // expressions in the same order, so the same bits (`bench-supply.spec.ts` checks the two agree).
    const setpointV = settings.setpointV[i];
    const limitA = settings.limitA[i];
    if (stampedMode(values, b) === REG_CV) {
      const band = CV_CC_HYSTERESIS.value * limitA + CV_CC_HYSTERESIS_AMPS.value;
      mode = iterate.branches[2 * b] > limitA + band ? REG_CC : REG_CV;
    } else {
      const volts = iterate.nodes[2 * branch.b] - iterate.nodes[2 * branch.a];
      const band = CV_CC_HYSTERESIS.value * setpointV + CV_CC_HYSTERESIS_VOLTS.value;
      mode = volts > setpointV - limitA * settings.ohms[i] + band ? REG_CV : REG_CC;
    }
  }
  stampRegulated(values, b, mode, settings, i);
}
