import type { AcSourceParams } from '@controls/catalog';
import {
  SPLIT_PHASE_HALF_WINDING_R_FACTOR,
  SPLIT_PHASE_HALF_WINDING_X_FACTOR,
  type SourcedConstant,
} from '../../constants';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { AC_STAMP_VSOURCE, AcBranchValues } from '../../mna/ac-values';
import { angularFrequency, type PhasorAngle } from '../../mna/phasor';

/*
 * AC sources behind a transformer's or an alternator's impedance (plan F2.4): the utility services,
 * 120/240 V split-phase (`utility.splitPhase`) and three-phase wye (`utility.threePhase`, 208Y/120 V
 * and 480Y/277 V), and the portable generator stub (`generator.portable`). Headless in P2: no recipe,
 * no record (the service entrance and load centre are P4, three-phase gameplay P6).
 *
 * **Impedance from kVA and %Z** (never a table). On the source's own base, Z_base = V_LL² / S, and
 *
 *   |Z| = (%Z / 100) · Z_base,   R = |Z| / √(1 + (X/R)²),   X = R · (X/R),
 *
 * with only `Math.sqrt` (D6). Each winding is a phasor source behind R + jωL with L = X / ω at the
 * region frequency (`AcBranchValues.vsource`'s series inductance), so the solver sees X again.
 *
 * - **Three-phase:** V_LL = √3 · V_LN (from `Math.sqrt`, never the 208 or 480 name), and Z_base is the
 *   per-phase wye impedance base, so each phase gets the whole R + jX. Phases at 0°, −120°, +120°
 *   (L1, L2, L3), from the exact constants (`phasorUnit`). A bolted three-phase fault draws V_LN / |Z|.
 * - **Split-phase** (engine 8, D4, ADR 0021): V_LL = 2 · V_LN and the full winding's Z_full on that
 *   base, held as a **T-equivalent**: Z_full / 2 in each of L1 and L2 and a neutral branch
 *   Z_n = Z_LN − Z_full / 2, where Z_LN is the half winding's own impedance (R_LN = 1.5 R and
 *   X_LN = 1.2 X of the full winding in per-unit on the 120 V base, {@link SPLIT_PHASE_HALF_WINDING_R_FACTOR}
 *   and {@link SPLIT_PHASE_HALF_WINDING_X_FACTOR}; 0.375 R and 0.3 X in ohms). Z_n is negative, so it is
 *   never a branch: it is eliminated into a coupled 2 × 2 source impedance, each winding's row
 *   carrying Z_h + Z_n on its own current and Z_n on the other's (`AcBranchValues.couple`), whose real
 *   part [[R_h + R_n, R_n], [R_n, R_h + R_n]] is positive definite (eigenvalues R_h and R_h + 2 R_n).
 *   A bolted L1–N fault then draws V_LN / |Z_LN| and an L1–L2 fault V_LL / |Z_full|, about 1.58 : 1
 *   (8230 A and 5208 A on the 25 kVA unit; 1.5 is the rule of thumb). L1 at 0°, L2 at 180°. The
 *   factors are for typical single-phase centre-tapped distribution transformers (Kersting's
 *   approximation, ADR 0021 reference notes); applying them to
 *   the generator stub is a labelled abstraction (its alternator has no centre-tapped winding of that
 *   construction). The terminals' structure is unchanged, so no `topologyHash` moves.
 * - The EMF is the open-circuit (no-load) voltage: the source impedance alone gives the voltage drop
 *   under load. No tap changer, regulation or frequency dynamics.
 */

/** A winding's series impedance: resistance (Ω) and inductance (H) at the region frequency. */
export interface SourceImpedance {
  readonly ohms: number;
  readonly henries: number;
  /** |Z| = √(R² + X²) (Ω). */
  readonly magnitudeOhm: number;
}

/** The impedance of a full winding at the source's rating: |Z|, R and X (Ω). */
export function ratedImpedance(params: AcSourceParams, lineToLineV: number): { z: number; r: number; x: number } {
  const z = ((params.percentImpedance / 100) * lineToLineV * lineToLineV) / (params.ratedKva * 1000);
  const r = z / Math.sqrt(1 + params.xOverR * params.xOverR);
  return { z, r, x: r * params.xOverR };
}

/** A split-phase source's line-to-line voltage, 2 · V_LN (V). */
export const splitPhaseLineToLineV = (params: AcSourceParams): number => 2 * params.lineToNeutralV;

/** A three-phase wye source's line-to-line voltage, √3 · V_LN (V), from `Math.sqrt` (D6). */
export const threePhaseLineToLineV = (params: AcSourceParams): number => Math.sqrt(3) * params.lineToNeutralV;

function series(r: number, x: number, frequencyHz: number): SourceImpedance {
  return { ohms: r, henries: x / angularFrequency(frequencyHz), magnitudeOhm: Math.sqrt(r * r + x * x) };
}

/**
 * A split-phase source's T-equivalent (engine 8, D4): `line` is Z_full / 2 (each of L1 and L2),
 * `lineToNeutral` the half winding's Z_LN (a winding's own series impedance in the coupled block) and
 * `neutral` Z_n = Z_LN − Z_full / 2 (the block's mutual impedance; negative R and L). R_LN and X_LN are
 * the full winding's R and X times the half-winding factors on the 120 V base: (V_LN / V_LL)² = 1/4 of
 * the factor, exactly.
 */
export interface SplitPhaseImpedance {
  readonly line: SourceImpedance;
  readonly lineToNeutral: SourceImpedance;
  readonly neutral: { readonly ohms: number; readonly henries: number };
}

export function splitPhaseTEquivalent(params: AcSourceParams, frequencyHz: number): SplitPhaseImpedance {
  const { r, x } = ratedImpedance(params, splitPhaseLineToLineV(params));
  const line = series(r / 2, x / 2, frequencyHz);
  const lineToNeutral = series(
    (SPLIT_PHASE_HALF_WINDING_R_FACTOR.value * r) / 4,
    (SPLIT_PHASE_HALF_WINDING_X_FACTOR.value * x) / 4,
    frequencyHz,
  );
  return {
    line,
    lineToNeutral,
    neutral: { ohms: lineToNeutral.ohms - line.ohms, henries: lineToNeutral.henries - line.henries },
  };
}

/**
 * The bolted line-to-neutral fault current at a split-phase source's terminals (A, RMS): V_LN / |Z_LN|
 * (engine 8's T-equivalent). Transformer limited, as {@link boltedFaultCurrentA}.
 */
export function splitPhaseLineToNeutralFaultA(params: AcSourceParams, frequencyHz: number): number {
  return params.lineToNeutralV / splitPhaseTEquivalent(params, frequencyHz).lineToNeutral.magnitudeOhm;
}

/** Each phase's impedance of a three-phase wye source. */
export function threePhaseWinding(params: AcSourceParams, frequencyHz: number): SourceImpedance {
  const { r, x } = ratedImpedance(params, threePhaseLineToLineV(params));
  return series(r, x, frequencyHz);
}

/**
 * The available bolted fault current at the source's terminals (A, RMS): a split-phase source's
 * L1–L2 fault, V_LL / |Z|; a three-phase source's three-phase fault, V_LN / |Z_phase|. Transformer
 * limited: the primary is an infinite bus (no utility system impedance), so this is the upper bound
 * of what a real service can deliver.
 */
export function boltedFaultCurrentA(params: AcSourceParams, phases: 1 | 3): number {
  if (phases === 1) return splitPhaseLineToLineV(params) / ratedImpedance(params, splitPhaseLineToLineV(params)).z;
  return params.lineToNeutralV / ratedImpedance(params, threePhaseLineToLineV(params)).z;
}

const SPLIT_ANGLES: Readonly<Record<string, PhasorAngle>> = { l1: 0, l2: 180 };
const THREE_PHASE_ANGLES: Readonly<Record<string, PhasorAngle>> = { l1: 0, l2: -120, l3: 120 };

/** One winding's series values: its own R and L, and for a coupled split-phase winding the mutual R and L. */
interface WindingValues {
  readonly ohms: number;
  readonly henries: number;
  /** The mutual impedance to the other winding of the pair, or null (three-phase: uncoupled). */
  readonly mutual: { readonly ohms: number; readonly henries: number } | null;
}

/** A three-phase winding: the phase impedance, uncoupled. */
const threePhaseValues = (p: AcSourceParams, f: number): WindingValues => {
  const z = threePhaseWinding(p, f);
  return { ohms: z.ohms, henries: z.henries, mutual: null };
};

/** A split-phase winding (engine 8): Z_LN on its own current, Z_n on the other's (the T-equivalent's block). */
const splitPhaseValues = (p: AcSourceParams, f: number): WindingValues => {
  const t = splitPhaseTEquivalent(p, f);
  return { ohms: t.lineToNeutral.ohms, henries: t.lineToNeutral.henries, mutual: t.neutral };
};

function acSourceModel(
  kind: string,
  angles: Readonly<Record<string, PhasorAngle>>,
  winding: (p: AcSourceParams, f: number) => WindingValues,
): SimDeviceModel {
  return {
    kind,
    output: null,
    bank(devices: readonly SimDevice[]): SimDeviceBank {
      // Every winding's value is fixed for the bank's life, so it is worked out here once (validated by
      // `vsourcePolar` into a scratch value set) and copied in at each solve: building it per solve
      // allocated (a phasor unit and boxed doubles) on the engine's AC allocation gate.
      const scratch = new AcBranchValues(1);
      const slot = new Int32Array(Math.max(0, ...devices.flatMap((d) => d.branches)) + 1).fill(-1);
      const winds = devices.flatMap((d) => d.branches).length;
      const re = new Float64Array(winds);
      const im = new Float64Array(winds);
      const ohms = new Float64Array(winds);
      const henries = new Float64Array(winds);
      // A coupled winding's partner branch (−1: none) and the mutual impedance (engine 8's split phase).
      const partner = new Int32Array(winds).fill(-1);
      const mutualOhms = new Float64Array(winds);
      const mutualHenries = new Float64Array(winds);
      let w = 0;
      devices.forEach((d) => {
        const p = d.params as AcSourceParams;
        const z = winding(p, d.frequencyHz);
        // A device's branches are its windings in part order: l1, l2 (, l3).
        d.branches.forEach((branch, j) => {
          scratch.vsourcePolar(0, p.lineToNeutralV, angles[`l${j + 1}`], z.ohms, z.henries);
          re[w] = scratch.emfRe[0];
          im[w] = scratch.emfIm[0];
          ohms[w] = scratch.ohms[0];
          henries[w] = scratch.seriesHenries[0];
          if (z.mutual !== null) {
            // The pair's two windings couple to each other (l1 ↔ l2).
            partner[w] = d.branches[1 - j];
            mutualOhms[w] = z.mutual.ohms;
            mutualHenries[w] = z.mutual.henries;
          }
          slot[branch] = w++;
        });
      });
      return {
        bag: () => ({}),
        acValue: (_i, b, values) => {
          const k = b.index;
          const at = slot[k];
          values.stamps[k] = AC_STAMP_VSOURCE;
          values.emfRe[k] = re[at];
          values.emfIm[k] = im[at];
          values.ohms[k] = ohms[at];
          values.seriesHenries[k] = henries[at];
          const other = partner[at];
          if (other >= 0) {
            values.partner[k] = other;
            values.mutualOhms[k] = mutualOhms[at];
            values.mutualHenries[k] = mutualHenries[at];
          }
          return true;
        },
      };
    },
  };
}

/** The utility service, 120/240 V split-phase (headless in P2). */
export const UTILITY_SPLIT_PHASE_MODEL = acSourceModel('utility.splitPhase', SPLIT_ANGLES, splitPhaseValues);

/** The utility service, three-phase wye: 208Y/120 V or 480Y/277 V by its catalogue entry (headless in P2). */
export const UTILITY_THREE_PHASE_MODEL = acSourceModel('utility.threePhase', THREE_PHASE_ANGLES, threePhaseValues);

/**
 * The portable generator, **a stub** (plan F2.4): its nameplate EMF behind its source impedance, as
 * the split-phase utility is modelled, with no engine, governor or voltage-regulator dynamics, no fuel
 * and no overload. It has no catalogue entry, so it can't be placed; generators and transfer switches
 * are in the backlog. Its nameplate is {@link GENERATOR_STUB_NAMEPLATE}. It takes the split-phase
 * T-equivalent above (engine 8): the half-winding factors are for distribution transformers, so on the
 * stub they are a labelled abstraction.
 */
export const GENERATOR_PORTABLE_MODEL = acSourceModel('generator.portable', SPLIT_ANGLES, splitPhaseValues);

/** The generator stub's nameplate, for a catalogue entry once generators are placeable (and for tests). */
export const GENERATOR_STUB_NAMEPLATE: Readonly<Record<keyof AcSourceParams, SourcedConstant>> = Object.freeze({
  ratedKva: {
    value: 7.5,
    unit: 'kVA',
    kind: 'real-world',
    source:
      "A 7.5 kW-class portable generator with a 120/240 V outlet panel, a common home-standby and job-site size (typical of published spec sheets for the class, paraphrased, not one vendor's); its rating taken as 7.5 kVA at unity power factor.",
  },
  lineToNeutralV: {
    value: 120,
    unit: 'V',
    kind: 'real-world',
    source:
      "120 V from each line to the neutral of the class's 120/240 V split-phase output (the region profile's split-phase system).",
  },
  percentImpedance: {
    value: 15,
    unit: '%',
    kind: 'game-design',
    source:
      "game-design inside published ranges: small synchronous alternators have a subtransient reactance of about 10–25 % on their own rating (electrical machines texts and alternator data sheets, paraphrased); 15 % is taken as the source impedance, so a bolted L1–L2 fault draws about 6.7× rated current (about 208 A). The stub ignores the decay to transient and synchronous reactance and the regulator's response.",
  },
  xOverR: {
    value: 5,
    unit: '1',
    kind: 'game-design',
    source:
      'game-design: an X/R of 5, inside the low single digits to about 10 published for small alternators; it only sets the angle of the fault current in the stub.',
  },
});
