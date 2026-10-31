import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import { GMIN_S } from '../lib/constants';
import type { DcSolution } from '../lib/mna/dc';
import { dcBranchValues, type DcBranchValues } from '../lib/mna/values';
import { compileNetlist } from '../lib/netlist/compile';
import type { Netlist } from '../lib/netlist/types';
import { BATTERY, benchBus, end, LAMP, LEAD, origin, run } from './bench';
import { branchOf, current, nodeOf, syntheticNetlist, voltage } from './mna';

/*
 * Golden DC fixtures (plan F2.2 part 1), each with its hand calculation. Built from real worlds via
 * `compileNetlist` where the catalogue has the parts (battery, lamp, leads), and as synthetic
 * netlists where a clean textbook circuit needs resistors the P2 catalogue doesn't have yet (the
 * Wheatstone bridge, a current source).
 *
 * Values every real-world fixture shares:
 *
 * - E = 12 V, the battery's EMF: its `nominalVoltageV`, the default until F2.4's state-of-charge curve;
 * - r = 0.023 Ω, the battery's `internalResistanceOhm` (catalogue entry battery.ferrovane-12v-7ah);
 * - R_L = 0.040948155 Ω per 1 m test lead: ρ·L/A = 1.724137931034483e-8 Ω·m × 1 m ÷ 8.2305e-7 m²
 *   = 0.020948155 Ω, plus 2 × 0.01 Ω of clip contact (F2.1's hand calculation, `compile.spec.ts`);
 * - a lamp filament's resistance is set by the fixture's hook, as F2.5's R(T) model will set it.
 *
 * Node voltages are against the island's reference node, which here is always a battery's `neg`.
 * `gmin` (1e-12 S per node) is left out of the closed forms. It moves a result by a relative error of
 * about gmin × R_th, the Thévenin resistance a node sees: 1e-10 at 100 Ω, 1e-6 at 1 MΩ. Here R_th is
 * at most a few hundred ohms, so the effect is ≤ ~1e-9 (the bridge, which notes its own margin) and
 * far below elsewhere. The plan allows up to 0.5 %; these goldens hold to 1e-9 unless a check says so.
 */

export interface DcGoldenCheck {
  readonly label: string;
  readonly actual: (solution: DcSolution) => number;
  readonly expected: number;
  /** Overrides the golden's tolerance for this check. */
  readonly tolerance?: number;
  /** An absolute floor in the check's unit, instead of 1e-12. */
  readonly absolute?: number;
}

export interface DcGolden {
  readonly name: string;
  readonly netlist: Netlist;
  readonly values: DcBranchValues;
  readonly checks: readonly DcGoldenCheck[];
  /** Islands expected to be flagged singular. */
  readonly singular?: readonly number[];
  /** Relative tolerance; an absolute floor of 1e-12 applies to expected zeros. */
  readonly tolerance: number;
}

const E = 12;
const r = 0.023;
const TOLERANCE = 1e-9;

/** A world built with the real commands: `place` refs at ids 1, 2, … then leads `[a, b]` with ids 1, 2, … */
function bench(
  refs: readonly { id: string; version: number }[],
  leads: readonly (readonly [number, string, number, string])[],
): World {
  const bus = benchBus();
  for (const ref of refs) run(bus, 'entity.place', { ref, positionMm: origin });
  for (const [ea, ta, eb, tb] of leads) run(bus, 'lead.connect', { ref: LEAD, a: end(ea, ta), b: end(eb, tb) });
  return bus.state;
}

/** DC values with lamp filaments set to `ohms[entity]` and batteries' EMF overridden by `emf[entity]`. */
function valuesFor(
  netlist: Netlist,
  lampOhms: Readonly<Record<number, number>>,
  emf: Readonly<Record<number, number>> = {},
) {
  return dcBranchValues(netlist, (branch, values) => {
    if (branch.element.kind !== 'entity') return false;
    const entity = branch.element.entity;
    if (branch.model === 'lamp.incandescent') {
      values.resistor(branch.index, lampOhms[entity]);
      return true;
    }
    if (branch.model === 'battery' && emf[entity] !== undefined) {
      values.vsource(branch.index, emf[entity], branch.values['internalResistanceOhm']);
      return true;
    }
    return false;
  });
}

function leadOhms(netlist: Netlist): number {
  return netlist.branches[branchOf(netlist, 1)].values['resistanceOhm'];
}

/**
 * 1. Voltage divider: battery (1), lamps 2 (30 Ω) and 3 (10 Ω) in series through three leads:
 *    + → 2a, 2b → 3a, 3b → −.
 *
 *    I = E / (r + 30 + 10 + 3 R_L) = 12 / 40.145844466 = 0.298910140 A
 *    V(+) = E − r I = 12 − 0.023 × 0.298910140 = 11.993125067 V
 *    V across lamp 3 = 10 I = 2.989101403 V (the divider's tap: E · 10 / (R_total) )
 *    V(3a) = I (10 + R_L) = 3.001341221 V (lamp 3 plus the return lead)
 */
function divider(): DcGolden {
  const netlist = compileNetlist(
    bench(
      [BATTERY, LAMP, LAMP],
      [
        [1, 'pos', 2, 'a'],
        [2, 'b', 3, 'a'],
        [3, 'b', 1, 'neg'],
      ],
    ),
    BUILTIN_CATALOG,
  );
  const RL = leadOhms(netlist);
  const I = E / (r + 30 + 10 + 3 * RL);
  const lamp3 = branchOf(netlist, 3, 'filament');
  return {
    name: 'voltage divider: a battery and two lamps in series',
    netlist,
    values: valuesFor(netlist, { 2: 30, 3: 10 }),
    tolerance: TOLERANCE,
    checks: [
      { label: 'loop current (≈ 0.298910 A)', actual: (s) => current(s, lamp3), expected: I },
      {
        label: 'battery terminal V(+) (≈ 11.993125 V)',
        actual: (s) => voltage(s, nodeOf(netlist, 1, 'pos')),
        expected: E - r * I,
      },
      {
        label: 'tap across lamp 3 (≈ 2.989101 V)',
        actual: (s) => voltage(s, nodeOf(netlist, 3, 'a')) - voltage(s, nodeOf(netlist, 3, 'b')),
        expected: 10 * I,
      },
      { label: 'V(3a) (≈ 3.001341 V)', actual: (s) => voltage(s, nodeOf(netlist, 3, 'a')), expected: I * (10 + RL) },
      {
        label: 'battery current equals the loop current',
        actual: (s) => current(s, branchOf(netlist, 1, 'cell')),
        expected: I,
      },
    ],
  };
}

/**
 * 2. Wheatstone bridge (synthetic): an ideal 10 V source (R = 0) from B (node 0) to T (node 1);
 *    R1 = 100 Ω T–L, R2 = 200 Ω L–B, R3 = 300 Ω T–R, R4 = 400 Ω R–B, and the bridge R5 = 50 Ω L–R.
 *    Nodes: B 0, T 1, L 2, R 3. By Thévenin across L–R with R5 removed:
 *
 *    V_L,oc = 10 · 200/300 = 20/3 V,   V_R,oc = 10 · 400/700 = 40/7 V,   difference 20/21 V
 *    R_th = 100‖200 + 300‖400 = 200/3 + 1200/7 = 5000/21 Ω
 *    I5 = (20/21) / (5000/21 + 50) = 20/6050 = 2/605 A ≈ 3.305785 mA, L → R
 *    V_L = 20/3 − I5 · 200/3 = 11700/1815 ≈ 6.446281 V
 *    V_R = 40/7 + I5 · 1200/7 = 26600/4235 ≈ 6.280992 V   (check: V_L − V_R = 50 I5)
 *    The source delivers I = (10 − V_L)/100 + (10 − V_R)/300 ≈ 0.047934 A.
 *
 *    gmin margin: I5 is a small difference current, so gmin's leak at L and R (≈ 6.4e-12 A each,
 *    through Thévenin resistances of 66.7 Ω and 171 Ω) moves it by about 7e-10 relative (measured
 *    6.8e-10). That is too close to 1e-9, so the I5 check allows 1e-8; the node voltages move only
 *    ~1e-10 and keep 1e-9.
 */
function wheatstone(): Netlist {
  return syntheticNetlist(4, [
    { a: 0, b: 1, kind: 'vsource' },
    { a: 1, b: 2, kind: 'resistor' },
    { a: 2, b: 0, kind: 'resistor' },
    { a: 1, b: 3, kind: 'resistor' },
    { a: 3, b: 0, kind: 'resistor' },
    { a: 2, b: 3, kind: 'resistor' },
  ]);
}

function bridgeValues(netlist: Netlist, r4: number): DcBranchValues {
  return dcBranchValues(netlist, (branch, values) => {
    if (branch.index === 0) values.vsource(0, 10, 0);
    else values.resistor(branch.index, [0, 100, 200, 300, r4, 50][branch.index]);
    return true;
  });
}

function unbalancedBridge(): DcGolden {
  const netlist = wheatstone();
  const vl = 11700 / 1815;
  const vr = 26600 / 4235;
  return {
    name: 'Wheatstone bridge, unbalanced (Thévenin)',
    netlist,
    values: bridgeValues(netlist, 400),
    tolerance: TOLERANCE,
    checks: [
      {
        label: 'bridge current I5 = 2/605 A (gmin moves it ≈ 7e-10 relative)',
        actual: (s) => current(s, 5),
        expected: 2 / 605,
        tolerance: 1e-8,
      },
      { label: 'V_L = 11700/1815 V', actual: (s) => voltage(s, 2), expected: vl },
      { label: 'V_R = 26600/4235 V', actual: (s) => voltage(s, 3), expected: vr },
      { label: 'V_T = 10 V (ideal source)', actual: (s) => voltage(s, 1), expected: 10 },
      { label: 'source current', actual: (s) => current(s, 0), expected: (10 - vl) / 100 + (10 - vr) / 300 },
    ],
  };
}

/**
 * 2b. The same bridge balanced (R1/R2 = R3/R4 = 1/2 with R4 = 600 Ω): I5 = 0 and V_L = V_R = 20/3 V.
 *     gmin unbalances it very slightly, because L and R see different Thévenin resistances (200/3 Ω
 *     and 200 Ω): ΔV ≈ gmin · 20/3 · (200 − 200/3) ≈ 8.9e-10 V, so I5 ≈ ΔV / (R_th + 50) ≈ 2.8e-12 A.
 *     The check allows 1e-11 A.
 */
function balancedBridge(): DcGolden {
  const netlist = wheatstone();
  return {
    name: 'Wheatstone bridge, balanced',
    netlist,
    values: bridgeValues(netlist, 600),
    tolerance: TOLERANCE,
    checks: [
      {
        label: 'bridge current is 0 (gmin leaves ≈ 2.8e-12 A)',
        actual: (s) => current(s, 5),
        expected: 0,
        absolute: 1e-11,
      },
      { label: 'V_L = 20/3 V', actual: (s) => voltage(s, 2), expected: 20 / 3 },
      { label: 'V_R = 20/3 V', actual: (s) => voltage(s, 3), expected: 20 / 3 },
    ],
  };
}

/**
 * 3. Battery with internal resistance into a load: battery (1), lamp 2 at 28.8 Ω (a 12 V 5 W lamp's
 *    hot resistance, V²/P), leads + → 2a and 2b → −.
 *
 *    I = E / (r + 28.8 + 2 R_L) = 12 / 28.904896311 = 0.415154577 A
 *    V_terminal = E − r I = 12 − 0.023 × 0.415154577 = 11.990451445 V
 *    P_lamp = I² × 28.8 = 4.963775696 W
 */
function batteryIntoLoad(): DcGolden {
  const netlist = compileNetlist(
    bench(
      [BATTERY, LAMP],
      [
        [1, 'pos', 2, 'a'],
        [2, 'b', 1, 'neg'],
      ],
    ),
    BUILTIN_CATALOG,
  );
  const RL = leadOhms(netlist);
  const I = E / (r + 28.8 + 2 * RL);
  const lamp = branchOf(netlist, 2, 'filament');
  return {
    name: 'battery with internal resistance into a load',
    netlist,
    values: valuesFor(netlist, { 2: 28.8 }),
    tolerance: TOLERANCE,
    checks: [
      { label: 'battery current (≈ 0.415155 A)', actual: (s) => current(s, branchOf(netlist, 1, 'cell')), expected: I },
      {
        label: 'terminal voltage (≈ 11.990451 V)',
        actual: (s) => voltage(s, nodeOf(netlist, 1, 'pos')),
        expected: E - r * I,
      },
      {
        label: 'lamp power (≈ 4.963776 W)',
        actual: (s) => {
          const i = current(s, lamp);
          return i * i * 28.8;
        },
        expected: I * I * 28.8,
      },
      { label: 'lamp current equals the battery current', actual: (s) => current(s, lamp), expected: I },
    ],
  };
}

/**
 * 4. Two unequal batteries in parallel: battery 1 at E1 = 12 V, battery 2 at E2 = 12.6 V (a fuller
 *    charge, set by the hook as F2.4's state of charge will), both r = 0.023 Ω, leads + → + and − → −.
 *
 *    No load: a circulating current I = (E2 − E1) / (2r + 2R_L) = 0.6 / 0.127896311 = 4.691300 A
 *    flows out of battery 2's + and into battery 1's + (battery 1 charges, so its source current,
 *    − → + inside the cell, is −I). The common voltage V = E1 + r I = 12.107900 V.
 */
function parallelBatteries(): DcGolden {
  const netlist = compileNetlist(
    bench(
      [BATTERY, BATTERY],
      [
        [1, 'pos', 2, 'pos'],
        [1, 'neg', 2, 'neg'],
      ],
    ),
    BUILTIN_CATALOG,
  );
  const RL = leadOhms(netlist);
  const I = (12.6 - E) / (2 * r + 2 * RL);
  return {
    name: 'two unequal batteries in parallel, no load',
    netlist,
    values: valuesFor(netlist, {}, { 2: 12.6 }),
    tolerance: TOLERANCE,
    checks: [
      {
        label: 'battery 2 discharges I (≈ 4.691300 A)',
        actual: (s) => current(s, branchOf(netlist, 2, 'cell')),
        expected: I,
      },
      { label: 'battery 1 charges at −I', actual: (s) => current(s, branchOf(netlist, 1, 'cell')), expected: -I },
      {
        label: 'V(1+) = E1 + r I (≈ 12.107900 V)',
        actual: (s) => voltage(s, nodeOf(netlist, 1, 'pos')),
        expected: E + r * I,
      },
      {
        label: 'the + lead carries I from 1 to 2, so −I',
        actual: (s) => current(s, branchOf(netlist, 1)),
        expected: -I,
      },
    ],
  };
}

/**
 * 4b. The same batteries sharing a load: a 28.8 Ω lamp 3 across battery 1 (+1 → 3a, 3b → −1), with
 *     leads +1 → +2 and −1 → −2 as before. Seen from battery 1's terminals, battery 2 is E2 behind
 *     r2 = r + 2R_L and the lamp is R' = 28.8 + 2R_L. By Millman's theorem:
 *
 *     V = (E1/r + E2/r2) / (1/r + 1/r2 + 1/R') = 12.099997 V
 *     I1 = (E1 − V)/r ≈ −4.347693 A (battery 1 still charging), I2 = (E2 − V)/r2 ≈ 4.766641 A,
 *     I_lamp = V/R' ≈ 0.418947 A, and I1 + I2 = I_lamp.
 */
function parallelBatteriesWithLoad(): DcGolden {
  const netlist = compileNetlist(
    bench(
      [BATTERY, BATTERY, LAMP],
      [
        [1, 'pos', 2, 'pos'],
        [1, 'neg', 2, 'neg'],
        [1, 'pos', 3, 'a'],
        [3, 'b', 1, 'neg'],
      ],
    ),
    BUILTIN_CATALOG,
  );
  const RL = leadOhms(netlist);
  const r2 = r + 2 * RL;
  const Rp = 28.8 + 2 * RL;
  const V = (E / r + 12.6 / r2) / (1 / r + 1 / r2 + 1 / Rp);
  return {
    name: 'two unequal batteries in parallel sharing a load (Millman)',
    netlist,
    values: valuesFor(netlist, { 3: 28.8 }, { 2: 12.6 }),
    tolerance: TOLERANCE,
    checks: [
      { label: 'V(1+) (≈ 12.099997 V)', actual: (s) => voltage(s, nodeOf(netlist, 1, 'pos')), expected: V },
      { label: 'battery 1 current', actual: (s) => current(s, branchOf(netlist, 1, 'cell')), expected: (E - V) / r },
      {
        label: 'battery 2 current',
        actual: (s) => current(s, branchOf(netlist, 2, 'cell')),
        expected: (12.6 - V) / r2,
      },
      { label: 'lamp current', actual: (s) => current(s, branchOf(netlist, 3, 'filament')), expected: V / Rp },
    ],
  };
}

/**
 * 5. Floating island under gmin: a lamp 2 left on its own (no leads) is an `empty` island, and
 *    battery 1 has one lead from + to lamp 3's `a`, with lamp 3's `b` dangling.
 *
 *    - The lone lamp has no source, so its node voltages and current are exactly 0, and it is not
 *      singular: gmin holds its non-reference node at the reference.
 *    - The dangling lamp's only return path is gmin at each of +, 3a and 3b. To first order in gmin,
 *      the battery supplies I_b = 3 gmin E = 3.6e-11 A, the lead carries 2 gmin E (3a's and 3b's) and
 *      the lamp gmin E = 1.2e-11 A, so V(3b) = E − gmin E (3r + 2R_L + 28.8) ≈ 12 − 3.5e-10 V.
 *    - Precision: each of these currents is resolved against KCL rows holding the lead's 24 S, so
 *      the solve can leave an absolute error of about ε · G · V ≈ 2.2e-16 × 24 × 12 ≈ 6.4e-14 A,
 *      whatever the pivot order. Relative to the currents that is ≈ 1.8e-3 of the battery's 3.6e-11 A
 *      and ≈ 5e-3 of the lamp's 1.2e-11 A, so a relative bound would rest on luck (this LU happens to
 *      give 2e-4 and 3e-6; another pivot order gave 1.4e-3). Both checks are bounded by that stated
 *      floor instead: 1e-13 A absolute, no relative term.
 */
function floating(): DcGolden {
  const netlist = compileNetlist(bench([BATTERY, LAMP, LAMP], [[1, 'pos', 3, 'a']]), BUILTIN_CATALOG);
  const gmin = GMIN_S.value;
  const RL = leadOhms(netlist);
  return {
    name: 'floating islands under gmin',
    netlist,
    values: valuesFor(netlist, { 2: 28.8, 3: 28.8 }),
    tolerance: 1e-9,
    checks: [
      { label: 'lone lamp a', actual: (s) => voltage(s, nodeOf(netlist, 2, 'a')), expected: 0, absolute: 0 },
      { label: 'lone lamp b', actual: (s) => voltage(s, nodeOf(netlist, 2, 'b')), expected: 0, absolute: 0 },
      {
        label: 'lone lamp current',
        actual: (s) => current(s, branchOf(netlist, 2, 'filament')),
        expected: 0,
        absolute: 0,
      },
      {
        label: 'dangling end 3b (≈ 12 − 3.5e-10 V)',
        actual: (s) => voltage(s, nodeOf(netlist, 3, 'b')),
        expected: E - gmin * E * (3 * r + 2 * RL + 28.8),
        absolute: 0,
      },
      {
        label: 'dangling lamp carries gmin · E',
        actual: (s) => current(s, branchOf(netlist, 3, 'filament')),
        expected: gmin * E,
        tolerance: 0,
        absolute: 1e-13,
      },
      {
        label: 'battery supplies 3 gmin E',
        actual: (s) => current(s, branchOf(netlist, 1, 'cell')),
        expected: 3 * gmin * E,
        tolerance: 0,
        absolute: 1e-13,
      },
    ],
  };
}

/**
 * 5b. A node only a current source reaches (synthetic): 1 mA from node 0 into node 1, nothing else.
 *     Without gmin the matrix is singular (node 1's KCL row is empty); with it, node 1 settles where
 *     gmin carries the 1 mA back: V = I / gmin = 1e-3 / 1e-12 = 1e9 V. Finite and not singular,
 *     though no real supply could do it: a current-limited supply's compliance voltage caps it, and
 *     F2.2 part 3's CV/CC loop models that.
 */
function currentSourceIntoGmin(): DcGolden {
  const netlist = syntheticNetlist(2, [{ a: 0, b: 1, kind: 'resistor' }]);
  return {
    name: 'a current source into nothing but gmin',
    netlist,
    values: dcBranchValues(netlist, (branch, values) => {
      values.isource(branch.index, 1e-3);
      return true;
    }),
    tolerance: 1e-9,
    checks: [
      { label: 'V = I / gmin', actual: (s) => voltage(s, 1), expected: 1e-3 / GMIN_S.value },
      { label: 'the source current is exact', actual: (s) => current(s, 0), expected: 1e-3 },
    ],
  };
}

/**
 * 6. Singular: two ideal (zero-ohm) sources of 12 V and 12.6 V in parallel (synthetic) contradict
 *    each other, so no solution exists. The island is flagged singular and every value is +0. A
 *    third, independent island (an ideal source into 6 Ω: I = 2 A) still solves.
 */
function idealSourcesInParallel(): DcGolden {
  const netlist = syntheticNetlist(4, [
    { a: 0, b: 1, kind: 'vsource' },
    { a: 0, b: 1, kind: 'vsource' },
    { a: 2, b: 3, kind: 'vsource' },
    { a: 3, b: 2, kind: 'resistor' },
  ]);
  return {
    name: 'ideal sources in parallel are singular; other islands still solve',
    netlist,
    values: dcBranchValues(netlist, (branch, values) => {
      if (branch.index === 3) values.resistor(3, 6);
      else values.vsource(branch.index, [12, 12.6, 12][branch.index], 0);
      return true;
    }),
    singular: [0],
    tolerance: 1e-9,
    checks: [
      { label: 'singular island node', actual: (s) => voltage(s, 1), expected: 0 },
      { label: 'singular island source', actual: (s) => current(s, 1), expected: 0 },
      { label: 'healthy island current', actual: (s) => current(s, 3), expected: 2 },
      { label: 'healthy island voltage', actual: (s) => voltage(s, 3), expected: 12 },
    ],
  };
}

/** Every golden, built fresh. */
export function dcGoldens(): DcGolden[] {
  return [
    divider(),
    unbalancedBridge(),
    balancedBridge(),
    batteryIntoLoad(),
    parallelBatteries(),
    parallelBatteriesWithLoad(),
    floating(),
    currentSourceIntoGmin(),
    idealSourcesInParallel(),
  ];
}
