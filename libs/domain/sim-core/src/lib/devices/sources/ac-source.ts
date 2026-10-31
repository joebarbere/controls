import type { AcSourceParams } from '@controls/catalog';
import type { SourcedConstant } from '../../constants';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { angularFrequency, type PhasorAngle } from '../../mna/phasor';
import type { ElementRef } from '../../netlist/types';

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
 * - **Split-phase:** V_LL = 2 · V_LN, the full winding's |Z| on that base, and each half (L1–N, L2–N)
 *   takes half of it; L1 at 0°, L2 at 180°. A bolted L1–L2 fault draws V_LL / |Z|. **Abstraction:** a
 *   real centre-tapped transformer's half-winding impedance is less than half the full winding's, so
 *   its line-to-neutral bolted fault current is higher than the line-to-line one (about 1.5× is the
 *   usual rule of thumb in short-circuit guides); here they are equal. Two independent halves can't
 *   give both, and the difference matters only for fault studies (P4's service entrance).
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

/** Each half winding's impedance of a split-phase source: half the full winding's. */
export function splitPhaseWinding(params: AcSourceParams, frequencyHz: number): SourceImpedance {
  const { r, x } = ratedImpedance(params, splitPhaseLineToLineV(params));
  return series(r / 2, x / 2, frequencyHz);
}

/** Each phase's impedance of a three-phase wye source. */
export function threePhaseWinding(params: AcSourceParams, frequencyHz: number): SourceImpedance {
  const { r, x } = ratedImpedance(params, threePhaseLineToLineV(params));
  return series(r, x, frequencyHz);
}

/**
 * The available bolted fault current at the source's terminals (A, RMS): a split-phase source's
 * L1–L2 fault, V_LL / |Z|; a three-phase source's three-phase fault, V_LN / |Z_phase|.
 */
export function boltedFaultCurrentA(params: AcSourceParams, phases: 1 | 3): number {
  if (phases === 1) return splitPhaseLineToLineV(params) / ratedImpedance(params, splitPhaseLineToLineV(params)).z;
  return params.lineToNeutralV / ratedImpedance(params, threePhaseLineToLineV(params)).z;
}

const SPLIT_ANGLES: Readonly<Record<string, PhasorAngle>> = { l1: 0, l2: 180 };
const THREE_PHASE_ANGLES: Readonly<Record<string, PhasorAngle>> = { l1: 0, l2: -120, l3: 120 };

function acSourceModel(
  kind: string,
  angles: Readonly<Record<string, PhasorAngle>>,
  winding: (p: AcSourceParams, f: number) => SourceImpedance,
): SimDeviceModel {
  return {
    kind,
    output: null,
    bank(devices: readonly SimDevice[]): SimDeviceBank {
      const emf = devices.map((d) => (d.params as AcSourceParams).lineToNeutralV);
      const z = devices.map((d) => winding(d.params as AcSourceParams, d.frequencyHz));
      return {
        bag: () => ({}),
        acValue: (i, b, values) => {
          // A device's branch is always one of its own elements: the winding's part names its line.
          const { part } = b.element as Extract<ElementRef, { kind: 'entity' }>;
          values.vsourcePolar(b.index, emf[i], angles[part], z[i].ohms, z[i].henries);
          return true;
        },
      };
    },
  };
}

/** The utility service, 120/240 V split-phase (headless in P2). */
export const UTILITY_SPLIT_PHASE_MODEL = acSourceModel('utility.splitPhase', SPLIT_ANGLES, splitPhaseWinding);

/** The utility service, three-phase wye: 208Y/120 V or 480Y/277 V by its catalogue entry (headless in P2). */
export const UTILITY_THREE_PHASE_MODEL = acSourceModel('utility.threePhase', THREE_PHASE_ANGLES, threePhaseWinding);

/**
 * The portable generator, **a stub** (plan F2.4): its nameplate EMF behind its source impedance, as
 * the split-phase utility is modelled, with no engine, governor or voltage-regulator dynamics, no fuel
 * and no overload. It has no catalogue entry, so it can't be placed; generators and transfer switches
 * are in the backlog. Its nameplate is {@link GENERATOR_STUB_NAMEPLATE}.
 */
export const GENERATOR_PORTABLE_MODEL = acSourceModel('generator.portable', SPLIT_ANGLES, splitPhaseWinding);

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
