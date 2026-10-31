import { ownModel } from '../netlist/models';
import type { Netlist, NetlistBranch } from '../netlist/types';
import { type PhasorAngle, phasorUnit } from './phasor';

/*
 * The electrical values a phasor (AC) solve stamps (plan F2.2 part 2), one per branch of an `ac`
 * island, kept apart from the netlist as the DC values are (`values.ts`): struct-of-arrays on
 * preallocated typed arrays, refilled by the engine without allocating.
 *
 * How a branch is stamped, at the island's angular frequency ω = 2π f:
 *
 * - `resistor` (on a `resistor` element): R, finite and > 0, admittance y = 1 / R;
 * - `inductor` (on a `resistor` element): L, finite and > 0, impedance jωL, admittance
 *   y = 1 / (jωL) = −j / (ωL);
 * - `capacitor` (on a `resistor` element): C, finite and > 0, impedance 1 / (jωC), admittance y = jωC;
 * - `vsource` (on a `vsource` element): a phasor EMF E = `emfRe` + j·`emfIm` (RMS) from `a`
 *   (negative) to `b` (positive) behind a series resistance R ≥ 0, so Vb − Va = E − R·I with I
 *   positive a → b through the source, as in DC.
 *
 * Passive elements are all F2.1 `resistor` elements: inductance and capacitance are stamp modes, as a
 * DC current source is, so F2.1's `ElementKind` and `topologyHash` are unchanged (ADR 0012's adapter
 * decision). Every passive stamp has the same matrix pattern (four entries between its ends), so a
 * resistor turning into an inductor never changes the factorisation cache's key.
 *
 * There is no AC current-source stamp: P2 has no AC device in current limit, and a current source can
 * leave a conductive component held by gmin alone, which needs the DC solver's floating-component
 * pinning (`dc.ts`) in complex form first. With R, L, C and voltage sources only, every element
 * conducts, so an island is one conductive component that holds its reference.
 */

/** How a branch is stamped in a phasor solve. */
export type AcStamp = 'resistor' | 'inductor' | 'capacitor' | 'vsource';

const STAMP_CODES: readonly (AcStamp | null)[] = [null, 'resistor', 'inductor', 'capacitor', 'vsource'];
/** Stamp codes in `AcBranchValues.stamps`. */
export const AC_STAMP_UNSET = 0;
export const AC_STAMP_RESISTOR = 1;
export const AC_STAMP_INDUCTOR = 2;
export const AC_STAMP_CAPACITOR = 3;
export const AC_STAMP_VSOURCE = 4;

function finite(name: string, branch: number, value: number): void {
  if (!Number.isFinite(value))
    throw new RangeError(`AC value ${name} of branch ${branch} must be finite, got ${value}`);
}

function positive(name: string, branch: number, value: number): void {
  finite(name, branch, value);
  if (!(value > 0)) throw new RangeError(`AC value ${name} of branch ${branch} must be > 0, got ${value}`);
}

/** One phasor-solve value per branch, in the netlist's branch order. */
export class AcBranchValues {
  readonly count: number;
  /** Per branch: an `AC_STAMP_*` code. */
  readonly stamps: Uint8Array;
  /** `resistor`: R; `vsource`: the series R. */
  readonly ohms: Float64Array;
  /** `inductor`: L. */
  readonly henries: Float64Array;
  /** `capacitor`: C. */
  readonly farads: Float64Array;
  /** `vsource`: the EMF phasor's real and imaginary parts (RMS). */
  readonly emfRe: Float64Array;
  readonly emfIm: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.stamps = new Uint8Array(count);
    this.ohms = new Float64Array(count);
    this.henries = new Float64Array(count);
    this.farads = new Float64Array(count);
    this.emfRe = new Float64Array(count);
    this.emfIm = new Float64Array(count);
  }

  /** Forgets every branch's value. */
  clear(): void {
    this.stamps.fill(AC_STAMP_UNSET);
  }

  /** The branch's stamp, or `null` if it has none. */
  stamp(branch: number): AcStamp | null {
    return STAMP_CODES[this.stamps[branch]];
  }

  resistor(branch: number, ohms: number): void {
    positive('ohms', branch, ohms);
    this.stamps[branch] = AC_STAMP_RESISTOR;
    this.ohms[branch] = ohms;
  }

  inductor(branch: number, henries: number): void {
    positive('henries', branch, henries);
    this.stamps[branch] = AC_STAMP_INDUCTOR;
    this.henries[branch] = henries;
  }

  capacitor(branch: number, farads: number): void {
    positive('farads', branch, farads);
    this.stamps[branch] = AC_STAMP_CAPACITOR;
    this.farads[branch] = farads;
  }

  /** A phasor EMF `emfRe` + j·`emfIm` (RMS) behind a series resistance `ohms` ≥ 0. */
  vsource(branch: number, emfRe: number, emfIm: number, ohms: number): void {
    finite('emfRe', branch, emfRe);
    finite('emfIm', branch, emfIm);
    finite('ohms', branch, ohms);
    if (!(ohms >= 0)) throw new RangeError(`vsource branch ${branch} needs ohms ≥ 0, got ${ohms}`);
    this.stamps[branch] = AC_STAMP_VSOURCE;
    // `+ 0` turns −0 into +0: one bit pattern per value, and a zero-ohm source is exactly 0.
    this.emfRe[branch] = emfRe + 0;
    this.emfIm[branch] = emfIm + 0;
    this.ohms[branch] = ohms + 0;
  }

  /**
   * A phasor EMF `rmsV`∠`angle` behind `ohms`, from the exact angle constants (D6): `rmsV · cos θ`
   * and `rmsV · sin θ` with cos and sin from `phasorUnit`.
   */
  vsourcePolar(branch: number, rmsV: number, angle: PhasorAngle, ohms: number): void {
    const unit = phasorUnit(angle);
    this.vsource(branch, rmsV * unit.re, rmsV * unit.im, ohms);
  }
}

/**
 * Supplies a branch's phasor value when the netlist alone can't (F2.4's utility and three-phase
 * sources, a load's impedance). It writes the value into `values` (by `branch.index`) and returns
 * `true`, or returns `false` to fall back to the model kind's default. It must be pure in its inputs.
 */
export type AcValueHook = (branch: NetlistBranch, values: AcBranchValues) => boolean;

/** A model kind's default AC value, read from the branch's netlist `values`. */
export type AcDefaultValue = (branch: NetlistBranch, values: AcBranchValues) => void;

/**
 * Defaults by model kind, for branches no hook sets: a `lead`'s `resistanceOhm` (resistivity × length
 * ÷ area, F2.1), its resistance at 60 Hz too (P2's leads are short enough that their inductance and
 * skin effect are ignored, as in DC). Sources and loads come from their device models' hooks (F2.4,
 * F2.5).
 */
export const AC_DEFAULT_VALUES: Readonly<Record<string, AcDefaultValue>> = Object.freeze({
  lead: (branch, values) => values.resistor(branch.index, branch.values['resistanceOhm']),
});

/**
 * Fills `out` (allocated if missing or the wrong size) with every `ac` island branch's value: the
 * hook's, else the model kind's default. Branches of other islands are left unset: `dc` and `empty`
 * islands are the DC solver's, and `mixed` islands are a diagnostic, solved by neither (P2 has no
 * converters). Throws when a branch has no value: a programming error in a device model.
 */
export function acBranchValues(netlist: Netlist, hook?: AcValueHook, out?: AcBranchValues): AcBranchValues {
  const values =
    out !== undefined && out.count === netlist.branches.length ? out : new AcBranchValues(netlist.branches.length);
  values.clear();
  for (const island of netlist.islands) {
    if (island.kind !== 'ac') continue;
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      if (hook !== undefined && hook(branch, values)) {
        if (values.stamps[index] === AC_STAMP_UNSET) {
          throw new Error(`AC value hook returned true for branch ${index} without setting a value`);
        }
        continue;
      }
      const fallback = ownModel(AC_DEFAULT_VALUES, branch.model);
      if (fallback === undefined) {
        const what =
          branch.element.kind === 'entity'
            ? `entity ${branch.element.entity} ${branch.element.part}`
            : `connection ${branch.element.connection}`;
        throw new Error(`no AC value for branch ${index} (${branch.model}, ${what}): its device model must supply one`);
      }
      fallback(branch, values);
    }
  }
  return values;
}
