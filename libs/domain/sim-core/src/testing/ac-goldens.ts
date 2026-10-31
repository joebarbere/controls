import { NEC_REGION } from '@controls/catalog';
import { AcBranchValues } from '../lib/mna/ac-values';
import type { DcSolution } from '../lib/mna/dc';
import { angularFrequency } from '../lib/mna/phasor';
import { type AcCircuit, cabs, cadd, cdiv, cmul, csub, type Phasor, phasorI, phasorV } from './ac';
import { syntheticNetlist } from './mna';

/*
 * Golden phasor fixtures (plan F2.2 part 2), each with its hand calculation. Synthetic netlists: the
 * utility and three-phase sources are F2.4's, so these build the textbook circuits straight from
 * elements. Values are RMS phasors at the NEC region's 60 Hz (`NEC_REGION.frequencyHz`), so
 * ω = 2π · 60 = 376.99111843077515 rad/s. Every source here is ideal (zero series resistance), and the
 * expected values are computed from the closed forms below with + − × ÷ only (D6), so a fixture states
 * its derivation once and the check can't drift from it.
 *
 * gmin (1e-12 S per node) is left out of the closed forms: it moves a result by about gmin × |Z_th|,
 * under 1e-10 relative here (every node sees at most tens of ohms). The plan allows 0.5 %; these hold
 * to 1e-9 unless a check says so.
 */

export interface AcGoldenCheck {
  readonly label: string;
  readonly actual: (solution: DcSolution) => number;
  readonly expected: number;
  /** Overrides the golden's tolerance for this check. */
  readonly tolerance?: number;
  /** An absolute floor in the check's unit, instead of 1e-12. */
  readonly absolute?: number;
}

export interface AcGolden extends AcCircuit {
  readonly name: string;
  readonly checks: readonly AcGoldenCheck[];
  /** Relative tolerance; an absolute floor of 1e-12 applies to expected zeros. */
  readonly tolerance: number;
}

const F = NEC_REGION.frequencyHz.value;
const OMEGA = angularFrequency(F);
const TOLERANCE = 1e-9;

/** Re, Im and |·| checks of one phasor. */
function phasorChecks(
  label: string,
  get: (s: DcSolution) => Phasor,
  expected: Phasor,
  absolute?: number,
): AcGoldenCheck[] {
  return [
    { label: `${label} re`, actual: (s) => get(s)[0], expected: expected[0], absolute },
    { label: `${label} im`, actual: (s) => get(s)[1], expected: expected[1], absolute },
    { label: `|${label}|`, actual: (s) => cabs(get(s)), expected: cabs(expected), absolute },
  ];
}

/**
 * 1. Series RL at 60 Hz: an ideal 120∠0° V source (node 0 → 1), R = 10 Ω (1 → 2), L = 50 mH (2 → 0).
 *
 *    X_L = ωL = 376.99111843 × 0.05 = 18.849555922 Ω;  Z = 10 + j18.849555922 Ω
 *    |Z|² = 100 + 355.305758439 = 455.305758439;  |Z| = 21.337894892 Ω
 *    I = E / Z = E (R − jX) / |Z|² = 2.635591529 − j4.967972991 A
 *    |I| = 120 / 21.337894892 = 5.623797502 A, lagging E by atan(X / R) = 62.053°
 *    V(2) = jX · I = 93.644084711 + j49.679729910 V (across the inductor)
 *    P = E · Re(I) = E² R / |Z|² = 316.270983 W;  Q = −E · Im(I) = E² X / |Z|² = 596.156759 var
 *    power factor R / |Z| = 0.468650 lagging
 */
function seriesRl(): AcGolden {
  const netlist = syntheticNetlist(
    3,
    [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 2, kind: 'resistor' },
      { a: 2, b: 0, kind: 'resistor' },
    ],
    'ac',
  );
  const E = 120;
  const R = 10;
  const L = 0.05;
  const values = new AcBranchValues(3);
  values.vsourcePolar(0, E, 0, 0);
  values.resistor(1, R);
  values.inductor(2, L);
  const X = OMEGA * L;
  const d = R * R + X * X;
  const I: Phasor = [(E * R) / d, -(E * X) / d];
  const V2 = cmul([0, X], I);
  return {
    name: 'series RL at 60 Hz: 120 V into 10 Ω and 50 mH',
    netlist,
    values,
    frequencyHz: F,
    tolerance: TOLERANCE,
    checks: [
      ...phasorChecks('I (≈ 2.635592 − j4.967973 A)', (s) => phasorI(s, 1), I),
      ...phasorChecks('I through L', (s) => phasorI(s, 2), I),
      ...phasorChecks('I through the source', (s) => phasorI(s, 0), I),
      ...phasorChecks('V(2) across L (≈ 93.644085 + j49.679730 V)', (s) => phasorV(s, 2), V2),
      { label: 'V(1) is the source, 120 V', actual: (s) => phasorV(s, 1)[0], expected: E },
      { label: 'Im I / Re I = −X / R (the lag)', actual: (s) => phasorI(s, 1)[1] / phasorI(s, 1)[0], expected: -X / R },
      { label: 'P = E² R / |Z|² (≈ 316.270983 W)', actual: (s) => E * phasorI(s, 0)[0], expected: (E * E * R) / d },
      { label: 'Q = E² X / |Z|² (≈ 596.156759 var)', actual: (s) => -E * phasorI(s, 0)[1], expected: (E * E * X) / d },
    ],
  };
}

/**
 * 2. Unbalanced 120/240 V split-phase: a centre-tapped secondary as two ideal sources from the centre
 *    tap N (node 0, the reference) to L1 (node 1, 120∠0° V) and L2 (node 2, 120∠180° V), a service
 *    neutral R_n = 0.05 Ω from the neutral bar (node 3) back to N, and three loads:
 *
 *    - A, L1–neutral: 12 Ω (a 1.2 kW heater at 120 V);
 *    - B, L2–neutral: 8 Ω (L2 → node 4) in series with X_B = ωL_B, L_B = 6 / ω H (node 4 → bar), so
 *      Z_B = 8 + j6 Ω (an inductive load at power factor 0.8);
 *    - C, L1–L2: 48 Ω (a 240 V load, 5 A, which never touches the neutral).
 *
 *    The neutral bar floats on R_n. KCL there: (V1 − V3) / Z_A + (V2 − V3) / Z_B = V3 / R_n, so
 *
 *    V3 = (V1 / Z_A + V2 / Z_B) / (1 / Z_A + 1 / Z_B + 1 / R_n) = 0.018775250 + j0.357139685 V
 *    I_A = (V1 − V3) / Z_A = 9.998435396 − j0.029761640 A
 *    I_B = (V2 − V3) / Z_B = −9.622930401 + j7.172555340 A
 *    I_C = (V1 − V2) / 48 = 5 A
 *
 *    The line currents are the sources' (out of L1 and L2): I_L1 = I_A + I_C = 14.998435396 − j0.029762 A
 *    (|I_L1| = 14.998465 A) and I_L2 = I_B − I_C = −14.622930401 + j7.172555 A (|I_L2| = 16.287285 A).
 *    The neutral current is their **phasor** sum, I_N = I_L1 + I_L2 = I_A + I_B = V3 / R_n
 *    = 0.375504995 + j7.142793700 A: |I_N| = 7.152657 A, not the 1.29 A difference of the magnitudes,
 *    because L2's load current lags. The 240 V load cancels out of it.
 */
function splitPhase(): AcGolden {
  const netlist = syntheticNetlist(
    5,
    [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 0, b: 2, kind: 'vsource' },
      { a: 3, b: 0, kind: 'resistor' },
      { a: 1, b: 3, kind: 'resistor' },
      { a: 2, b: 4, kind: 'resistor' },
      { a: 4, b: 3, kind: 'resistor' },
      { a: 1, b: 2, kind: 'resistor' },
    ],
    'ac',
  );
  const E = NEC_REGION.splitPhase.lineToNeutralV.value;
  const Rn = 0.05;
  const LB = 6 / OMEGA;
  const values = new AcBranchValues(7);
  values.vsourcePolar(0, E, 0, 0);
  values.vsourcePolar(1, E, 180, 0);
  values.resistor(2, Rn);
  values.resistor(3, 12);
  values.resistor(4, 8);
  values.inductor(5, LB);
  values.resistor(6, 48);
  const V1: Phasor = [E, 0];
  const V2: Phasor = [-E, 0];
  const ZA: Phasor = [12, 0];
  const ZB: Phasor = [8, OMEGA * LB];
  const one: Phasor = [1, 0];
  const V3 = cdiv(cadd(cdiv(V1, ZA), cdiv(V2, ZB)), cadd(cadd(cdiv(one, ZA), cdiv(one, ZB)), [1 / Rn, 0]));
  const IA = cdiv(csub(V1, V3), ZA);
  const IB = cdiv(csub(V2, V3), ZB);
  const IC: Phasor = [(2 * E) / 48, 0];
  const IL1 = cadd(IA, IC);
  const IL2 = csub(IB, IC);
  const IN = cadd(IL1, IL2);
  return {
    name: 'unbalanced 120/240 V split-phase: the neutral carries the phasor sum of the line currents',
    netlist,
    values,
    frequencyHz: F,
    tolerance: TOLERANCE,
    checks: [
      ...phasorChecks('I_N in the neutral (≈ 0.375505 + j7.142794 A)', (s) => phasorI(s, 2), IN),
      ...phasorChecks('I_L1 + I_L2, from the solved line currents', (s) => cadd(phasorI(s, 0), phasorI(s, 1)), IN),
      { label: 'I_N = V3 / R_n', actual: (s) => cabs(phasorV(s, 3)) / Rn, expected: cabs(IN) },
      ...phasorChecks('I_L1 (≈ 14.998435 − j0.029762 A)', (s) => phasorI(s, 0), IL1),
      ...phasorChecks('I_L2 (≈ −14.622930 + j7.172555 A)', (s) => phasorI(s, 1), IL2),
      ...phasorChecks('V3, the neutral bar (≈ 0.018775 + j0.357140 V)', (s) => phasorV(s, 3), V3),
      ...phasorChecks('I_A', (s) => phasorI(s, 3), IA),
      ...phasorChecks('I_B', (s) => phasorI(s, 4), IB),
      ...phasorChecks('I_C, the 240 V load (5 A)', (s) => phasorI(s, 6), IC),
      { label: 'V(L1) − V(L2) = 240 V', actual: (s) => phasorV(s, 1)[0] - phasorV(s, 2)[0], expected: 2 * E },
    ],
  };
}

/**
 * 3. Balanced 208Y/120 V wye load: three ideal sources from the neutral N (node 0) to phases A, B, C
 *    (nodes 1, 2, 3) at 120∠0°, 120∠−120° and 120∠+120° V; each phase feeds Z = 8 + j6 Ω (8 Ω to an
 *    inner node 5–7, then L = 6 / ω H to the load's star point S, node 4); S returns to N through a
 *    neutral R_n = 0.05 Ω.
 *
 *    The three EMFs sum to exactly 0 (1 − 0.5 − 0.5 and 0 − √3/2 + √3/2 in doubles too), so by symmetry
 *    V_S = 0 and the neutral carries **no current**: I_N ≈ 0 (rounding only, checked absolutely
 *    against 1e-9 A, against 12 A phase currents).
 *
 *    I_A = 120 / (8 + j6) = 120 (8 − j6) / 100 = 9.6 − j7.2 A, |I| = 12 A. ABC sequence: B lags A by
 *    120° and C leads it by 120°, so
 *    I_B = I_A · (−1/2 − j√3/2) = (−4.8 − 3.6√3) + j(3.6 − 4.8√3) = −11.035383 − j4.713844 A,
 *    I_C = I_A · (−1/2 + j√3/2) = (−4.8 + 3.6√3) + j(3.6 + 4.8√3) = 1.435383 + j11.913844 A
 *    (hand constants, not derived from the fixture's sources, so a B↔C swap fails). V_B lags V_A:
 *    V_A · conj(V_B) = 14 400 ∠+120°, whose imaginary part is 14 400 · √3/2 = 12 470.77 > 0. Line to line |V_A − V_B| = 120 √3 = 207.846097 V (the "208" of 208Y/120).
 *    P = 3 |I|² · 8 = 3456 W, Q = 3 |I|² · 6 = 2592 var: S = 4320 VA at power factor 0.8.
 */
function balancedWye(): AcGolden {
  const netlist = syntheticNetlist(
    8,
    [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 0, b: 2, kind: 'vsource' },
      { a: 0, b: 3, kind: 'vsource' },
      { a: 1, b: 5, kind: 'resistor' },
      { a: 2, b: 6, kind: 'resistor' },
      { a: 3, b: 7, kind: 'resistor' },
      { a: 5, b: 4, kind: 'resistor' },
      { a: 6, b: 4, kind: 'resistor' },
      { a: 7, b: 4, kind: 'resistor' },
      { a: 4, b: 0, kind: 'resistor' },
    ],
    'ac',
  );
  const E = NEC_REGION.threePhaseCommercial.lineToNeutralV.value;
  const L = 6 / OMEGA;
  const values = new AcBranchValues(10);
  values.vsourcePolar(0, E, 0, 0);
  values.vsourcePolar(1, E, -120, 0);
  values.vsourcePolar(2, E, 120, 0);
  for (const b of [3, 4, 5]) values.resistor(b, 8);
  for (const b of [6, 7, 8]) values.inductor(b, L);
  values.resistor(9, 0.05);
  const Z: Phasor = [8, OMEGA * L];
  const phase = (b: number): Phasor => [values.emfRe[b], values.emfIm[b]];
  const IA: Phasor = [9.6, -7.2];
  const R3 = Math.sqrt(3);
  const IB: Phasor = [-4.8 - 3.6 * R3, 3.6 - 4.8 * R3];
  const IC: Phasor = [-4.8 + 3.6 * R3, 3.6 + 4.8 * R3];
  const I2 = 3 * (IA[0] * IA[0] + IA[1] * IA[1]);
  const totalP = (s: DcSolution) =>
    [0, 1, 2].reduce((p, b) => p + cmul(phase(b), [phasorI(s, b)[0], -phasorI(s, b)[1]])[0], 0);
  const totalQ = (s: DcSolution) =>
    [0, 1, 2].reduce((q, b) => q + cmul(phase(b), [phasorI(s, b)[0], -phasorI(s, b)[1]])[1], 0);
  return {
    name: 'balanced 208Y/120 V wye load: the neutral current is about 0',
    netlist,
    values,
    frequencyHz: F,
    tolerance: TOLERANCE,
    checks: [
      { label: '|I_N| ≈ 0', actual: (s) => cabs(phasorI(s, 9)), expected: 0, absolute: 1e-9 },
      { label: '|V_S| ≈ 0', actual: (s) => cabs(phasorV(s, 4)), expected: 0, absolute: 1e-10 },
      ...phasorChecks('I_A (9.6 − j7.2 A)', (s) => phasorI(s, 0), IA),
      ...phasorChecks('I_B', (s) => phasorI(s, 1), IB),
      ...phasorChecks('I_C', (s) => phasorI(s, 2), IC),
      {
        label: 'ABC sequence: Im(V_A · conj V_B) = 14 400 · √3/2 > 0 (V_B lags V_A by 120°)',
        actual: (s) => cmul(phasorV(s, 1), [phasorV(s, 2)[0], -phasorV(s, 2)[1]])[1],
        expected: (14400 * R3) / 2,
      },
      ...phasorChecks('I_A through its load', (s) => phasorI(s, 3), IA),
      {
        label: '|V_A − V_B| = 120 √3 (≈ 207.846097 V)',
        actual: (s) => cabs(csub(phasorV(s, 1), phasorV(s, 2))),
        expected: E * Math.sqrt(3),
      },
      { label: 'P = 3 |I|² R (3456 W)', actual: totalP, expected: I2 * 8 },
      { label: 'Q = 3 |I|² X (2592 var)', actual: totalQ, expected: I2 * OMEGA * L },
    ],
  };
}

/** Every AC golden fixture. */
export function acGoldens(): AcGolden[] {
  return [seriesRl(), splitPhase(), balancedWye()];
}
