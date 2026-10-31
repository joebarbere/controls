import { ownModel } from '../netlist/models';
import type { Netlist, NetlistBranch } from '../netlist/types';

/*
 * The electrical values a DC solve stamps (plan F2.2 part 1), one per branch, kept apart from the
 * netlist: values change every solve (a filament's R(T), a battery's EMF against state of charge, a
 * supply switching to current limit), the netlist only on topology changes. Struct-of-arrays on
 * preallocated typed arrays, so the engine (F2.3a) refills them without allocating.
 *
 * How a branch is stamped:
 *
 * - `resistor` (on a `resistor` element): `ohms`, finite and > 0. Current flows a → b as (Va − Vb) / R;
 * - `vsource` (on a `vsource` element): an EMF `emfV` from `a` (negative) to `b` (positive) behind a
 *   series `ohms` ≥ 0, so Vb − Va = emfV − ohms · I with I positive a → b through the source (the
 *   direction a discharging battery drives);
 * - `isource` (on either kind): exactly `amps` a → b through the element, whatever the voltage (a
 *   supply in current limit, F2.4).
 *
 * Which unknowns an island has depends only on the element kinds (topology), never on these modes:
 * a `vsource` element has a branch-current unknown even while it is stamped as a current source. So
 * the matrix layout is a function of `topologyHash`, which F2.2 part 3's factorisation cache keys on.
 */

/** How a branch is stamped in a DC solve. */
export type DcStamp = 'resistor' | 'vsource' | 'isource';

const STAMP_CODES: readonly (DcStamp | null)[] = [null, 'resistor', 'vsource', 'isource'];
/** Stamp codes in `DcBranchValues.stamps`. */
export const DC_STAMP_UNSET = 0;
export const DC_STAMP_RESISTOR = 1;
export const DC_STAMP_VSOURCE = 2;
export const DC_STAMP_ISOURCE = 3;

function finite(name: string, branch: number, value: number): void {
  if (!Number.isFinite(value))
    throw new RangeError(`DC value ${name} of branch ${branch} must be finite, got ${value}`);
}

/** One DC value per branch, in the netlist's branch order. */
export class DcBranchValues {
  readonly count: number;
  /** Per branch: a `DC_STAMP_*` code. */
  readonly stamps: Uint8Array;
  /** `resistor`: R; `vsource`: the series R. */
  readonly ohms: Float64Array;
  /** `vsource`: the EMF. */
  readonly emfV: Float64Array;
  /** `isource`: the current, a → b. */
  readonly amps: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.stamps = new Uint8Array(count);
    this.ohms = new Float64Array(count);
    this.emfV = new Float64Array(count);
    this.amps = new Float64Array(count);
  }

  /** Forgets every branch's value. */
  clear(): void {
    this.stamps.fill(DC_STAMP_UNSET);
  }

  /** The branch's stamp, or `null` if it has none. */
  stamp(branch: number): DcStamp | null {
    return STAMP_CODES[this.stamps[branch]];
  }

  resistor(branch: number, ohms: number): void {
    finite('ohms', branch, ohms);
    if (!(ohms > 0)) throw new RangeError(`resistor branch ${branch} needs ohms > 0, got ${ohms}`);
    this.stamps[branch] = DC_STAMP_RESISTOR;
    this.ohms[branch] = ohms;
  }

  vsource(branch: number, emfV: number, ohms: number): void {
    finite('emfV', branch, emfV);
    finite('ohms', branch, ohms);
    if (!(ohms >= 0)) throw new RangeError(`vsource branch ${branch} needs ohms ≥ 0, got ${ohms}`);
    this.stamps[branch] = DC_STAMP_VSOURCE;
    this.emfV[branch] = emfV;
    // `+ 0` turns −0 into +0, so a zero-ohm source is always the exact zero the singular check tests.
    this.ohms[branch] = ohms + 0;
  }

  isource(branch: number, amps: number): void {
    finite('amps', branch, amps);
    this.stamps[branch] = DC_STAMP_ISOURCE;
    this.amps[branch] = amps;
  }
}

/**
 * Supplies a branch's value when the netlist alone can't (a battery's EMF at a state of charge,
 * F2.5's filament R(T)). It writes the value into `values` (by `branch.index`) and returns `true`, or
 * returns `false` to fall back to the model kind's default. It must be pure in its inputs.
 */
export type DcValueHook = (branch: NetlistBranch, values: DcBranchValues) => boolean;

/** A model kind's default DC value, read from the branch's netlist `values`. */
export type DcDefaultValue = (branch: NetlistBranch, values: DcBranchValues) => void;

/**
 * Defaults by model kind, for branches no hook sets:
 *
 * - `lead`: its `resistanceOhm` (resistivity × length ÷ area, F2.1);
 * - `battery`: its full-charge open-circuit EMF (`openCircuitVoltageFullV`) behind `internalResistanceOhm`:
 *   a new battery (state of charge 1, its kind's initial value) for callers that run no engine model.
 *   The engine's battery model (F2.4) always sets the EMF from the live state of charge instead. The
 *   nominal voltage is never an EMF: a lead-acid battery resting at its nominal 12.0 V is only about a
 *   quarter charged (plan F2.4, #46 review).
 *
 * Kinds whose value is sim-owned state with no placeholder (the lamp's filament R(T), F2.5) have no
 * default: the engine's hook must set them.
 */
export const DC_DEFAULT_VALUES: Readonly<Record<string, DcDefaultValue>> = Object.freeze({
  lead: (branch, values) => values.resistor(branch.index, branch.values['resistanceOhm']),
  battery: (branch, values) =>
    values.vsource(branch.index, branch.values['openCircuitVoltageFullV'], branch.values['internalResistanceOhm']),
});

/**
 * Fills `out` (allocated if missing or the wrong size) with every DC-solvable branch's value: the
 * hook's, else the model kind's default. Branches of `ac` and `mixed` islands are left unset: the DC
 * solver doesn't solve them (part 2's phasor solver does). Throws when a branch the DC solver needs
 * has no value, or a value is not finite: a programming error in a device model, never a world error.
 */
export function dcBranchValues(netlist: Netlist, hook?: DcValueHook, out?: DcBranchValues): DcBranchValues {
  const values =
    out !== undefined && out.count === netlist.branches.length ? out : new DcBranchValues(netlist.branches.length);
  values.clear();
  for (const island of netlist.islands) {
    if (island.kind !== 'dc' && island.kind !== 'empty') continue;
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      if (hook !== undefined && hook(branch, values)) {
        if (values.stamps[index] === DC_STAMP_UNSET) {
          throw new Error(`DC value hook returned true for branch ${index} without setting a value`);
        }
        continue;
      }
      const fallback = ownModel(DC_DEFAULT_VALUES, branch.model);
      if (fallback === undefined) {
        const what =
          branch.element.kind === 'entity'
            ? `entity ${branch.element.entity} ${branch.element.part}`
            : `connection ${branch.element.connection}`;
        throw new Error(`no DC value for branch ${index} (${branch.model}, ${what}): its device model must supply one`);
      }
      fallback(branch, values);
    }
  }
  return values;
}
