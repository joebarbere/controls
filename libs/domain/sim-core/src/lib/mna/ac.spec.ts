import { NEC_REGION } from '@controls/catalog';
import { AC_SOURCE, benchBus, end, LAMP, LEAD, origin, TEST_CATALOG, TEST_MODELS } from '../../testing/bench';
import { checkAcRows } from '../../testing/ac';
import { syntheticNetlist, type SyntheticBranch } from '../../testing/mna';
import { compileNetlist } from '../netlist/compile';
import { AcSolver, solveAc } from './ac';
import {
  AC_DEFAULT_VALUES,
  AC_STAMP_CAPACITOR,
  AC_STAMP_INDUCTOR,
  AC_STAMP_RESISTOR,
  AC_STAMP_UNSET,
  AC_STAMP_VSOURCE,
  acBranchValues,
  AcBranchValues,
} from './ac-values';
import { createDcSolution, ISLAND_FLAG_SINGULAR } from './dc';
import { angularFrequency, PHASOR_ANGLES, phasorUnit, SIN_120 } from './phasor';

/** Unit cases of the phasor solver (F2.2 part 2): its values, its contract and its argument checks. */

/** A source (0 → 1) and one passive branch (1 → 0). */
const loop = () =>
  syntheticNetlist(
    2,
    [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
    ],
    'ac',
  );

describe('phasor constants', () => {
  it('angles are exact constants (D6), never Math.cos or Math.sin', () => {
    expect(PHASOR_ANGLES).toStrictEqual([0, 180, 120, -120]);
    expect(phasorUnit(0)).toStrictEqual({ re: 1, im: 0 });
    expect(phasorUnit(180)).toStrictEqual({ re: -1, im: 0 });
    expect(phasorUnit(120)).toStrictEqual({ re: -0.5, im: Math.sqrt(3) / 2 });
    expect(phasorUnit(-120)).toStrictEqual({ re: -0.5, im: -SIN_120 });
    // Within an ulp of the libm values: the corpus's ngspice used cos and sin.
    expect(Math.abs(SIN_120 - Math.sin((2 * Math.PI) / 3))).toBeLessThanOrEqual(Number.EPSILON);
    // A balanced set sums to exactly zero.
    const sum = [0, -120, 120].map((a) => phasorUnit(a as 0 | 120 | -120));
    expect(sum.reduce((s, u) => s + u.re, 0)).toBe(0);
    expect(sum.reduce((s, u) => s + u.im, 0)).toBe(0);
  });

  it('ω = 2π f, and the frequency must be finite and positive', () => {
    expect(angularFrequency(60)).toBe(376.99111843077515);
    expect(angularFrequency(NEC_REGION.frequencyHz.value)).toBe(2 * Math.PI * 60);
    for (const bad of [0, -60, NaN, Infinity]) expect(() => angularFrequency(bad)).toThrow(RangeError);
  });
});

describe('AcBranchValues', () => {
  it('stores each stamp and refuses non-finite or non-positive values', () => {
    const v = new AcBranchValues(5);
    v.resistor(0, 10);
    v.inductor(1, 0.1);
    v.capacitor(2, 1e-6);
    v.vsource(3, -0, -0, -0);
    v.vsourcePolar(4, 277, -120, 0.5);
    expect([0, 1, 2, 3, 4].map((b) => v.stamp(b))).toStrictEqual([
      'resistor',
      'inductor',
      'capacitor',
      'vsource',
      'vsource',
    ]);
    expect(Array.from(v.stamps)).toStrictEqual([
      AC_STAMP_RESISTOR,
      AC_STAMP_INDUCTOR,
      AC_STAMP_CAPACITOR,
      AC_STAMP_VSOURCE,
      AC_STAMP_VSOURCE,
    ]);
    // −0 is stored as +0.
    expect([Object.is(v.emfRe[3], 0), Object.is(v.emfIm[3], 0), Object.is(v.ohms[3], 0)]).toStrictEqual([
      true,
      true,
      true,
    ]);
    expect([v.emfRe[4], v.emfIm[4], v.ohms[4]]).toStrictEqual([-138.5, -277 * SIN_120, 0.5]);
    for (const set of [
      () => v.resistor(0, 0),
      () => v.resistor(0, -1),
      () => v.inductor(0, 0),
      () => v.capacitor(0, NaN),
      () => v.vsource(0, Infinity, 0, 0),
      () => v.vsource(0, 0, NaN, 0),
      () => v.vsource(0, 0, 0, -1),
      () => v.vsource(0, 0, 0, 1, -1e-3),
      () => v.vsource(0, 0, 0, 1, NaN),
      // A series inductance needs a series resistance: "zero impedance" stays "zero ohm" (F2.4).
      () => v.vsource(0, 0, 0, 0, 1e-3),
    ]) {
      expect(set).toThrow(RangeError);
    }
    v.clear();
    expect(v.stamp(0)).toBeNull();
    expect(Array.from(v.stamps).every((s) => s === AC_STAMP_UNSET)).toBe(true);
  });
});

describe('acBranchValues', () => {
  /** An AC source (1) and a lamp (2) in a loop of two leads. */
  function acBench() {
    const bus = benchBus(TEST_CATALOG);
    for (const ref of [AC_SOURCE, LAMP]) bus.exec('entity.place', { ref, positionMm: origin });
    bus.exec('lead.connect', { ref: LEAD, a: end(1, 'l'), b: end(2, 'a') });
    bus.exec('lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'n') });
    return compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
  }

  it("takes a hook's values, else the kind's default (a lead's resistance), and reuses `out`", () => {
    const netlist = acBench();
    const hook = (branch: (typeof netlist.branches)[number], v: AcBranchValues) => {
      if (branch.model === 'lamp.incandescent') v.resistor(branch.index, 144);
      else if (branch.model === 'test.acSource') v.vsourcePolar(branch.index, 120, 0, 0);
      else return false;
      return true;
    };
    const values = acBranchValues(netlist, hook);
    const lead = netlist.branches.find((b) => b.model === 'lead');
    expect(lead).toBeDefined();
    expect(values.ohms[lead?.index ?? -1]).toBe(lead?.values['resistanceOhm']);
    expect(Object.keys(AC_DEFAULT_VALUES)).toStrictEqual(['lead']);
    expect(acBranchValues(netlist, hook, values)).toBe(values);
    expect(acBranchValues(netlist, hook, new AcBranchValues(1))).not.toBe(values);
    const solution = solveAc(netlist, values, 60);
    checkAcRows({ netlist, values, frequencyHz: 60 }, solution, true);
  });

  it('throws for a branch with no value, or a hook that claims one without setting it', () => {
    const netlist = acBench();
    expect(() => acBranchValues(netlist)).toThrow(/no AC value for branch .* entity 1 winding/);
    expect(() => acBranchValues(netlist, () => true)).toThrow(/without setting a value/);
    // A connection with no default (a synthetic model kind).
    expect(() => acBranchValues(loop())).toThrow(/no AC value for branch 0 \(test.element, connection 1\)/);
  });

  it('leaves branches outside `ac` islands unset', () => {
    const netlist = syntheticNetlist(2, [{ a: 0, b: 1, kind: 'vsource' }], 'dc');
    const values = acBranchValues(netlist, () => false);
    expect(values.stamp(0)).toBeNull();
  });
});

describe('AcSolver contract', () => {
  it('solves a source into each passive stamp: I = E y', () => {
    const omega = angularFrequency(60);
    for (const [stamp, y] of [
      [(v: AcBranchValues) => v.resistor(1, 4), [0.25, 0]],
      [(v: AcBranchValues) => v.inductor(1, 1 / omega), [0, -1]],
      [(v: AcBranchValues) => v.capacitor(1, 2 / omega), [0, 2]],
    ] as const) {
      const values = new AcBranchValues(2);
      values.vsource(0, 3, 4, 0);
      stamp(values);
      const s = solveAc(loop(), values, 60);
      const i: [number, number] = [3 * y[0] - 4 * y[1], 3 * y[1] + 4 * y[0]];
      expect(Math.abs(s.branches[2] - i[0])).toBeLessThan(1e-14);
      expect(Math.abs(s.branches[3] - i[1])).toBeLessThan(1e-14);
      // The source's own current is the load current plus gmin's leak at node 1 (1e-12 S × 5 V).
      expect(Math.abs(s.branches[0] - i[0])).toBeLessThan(1e-11);
      expect([s.nodes[2], s.nodes[3]]).toStrictEqual([3, 4]);
      expect(s.islands[0]).toStrictEqual({ solved: true, referenceNode: 0, unknowns: 2, flags: 0, iterations: 1 });
    }
  });

  it('solves a source behind R + jωL: I = E / (Z + Z_load), on the dense and the sparse path (F2.4)', () => {
    // E = 120 V behind 0.3 Ω + j0.4 Ω (L = 0.4 / ω) into 4 Ω: Z_t = 4.3 + j0.4, so
    // I = 120 / (4.3 + j0.4) = 120 (4.3 − j0.4) / 18.65 = 27.667560 − j2.573727 A.
    const omega = angularFrequency(60);
    const values = new AcBranchValues(2);
    values.vsource(0, 120, 0, 0.3, 0.4 / omega);
    values.resistor(1, 4);
    for (const solver of [new AcSolver(), new AcSolver({ sparseMinUnknowns: 1 })]) {
      const s = solver.solve(loop(), values, 60);
      expect(s.branches[2]).toBeCloseTo((120 * 4.3) / 18.65, 9);
      expect(s.branches[3]).toBeCloseTo((-120 * 0.4) / 18.65, 9);
      expect((120 * 4.3) / 18.65).toBeCloseTo(27.66756, 5);
    }
  });

  it('flags a loop of ideal sources (and a shorted ideal source) singular, all +0', () => {
    const parallel = syntheticNetlist(
      2,
      [
        { a: 0, b: 1, kind: 'vsource' },
        { a: 0, b: 1, kind: 'vsource' },
        { a: 1, b: 0, kind: 'resistor' },
      ],
      'ac',
    );
    const values = new AcBranchValues(3);
    values.vsource(0, 120, 0, 0);
    values.vsource(1, 0, 120, 0);
    values.resistor(2, 10);
    const s = solveAc(parallel, values, 60);
    expect(s.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect([...s.nodes, ...s.branches].every((v) => Object.is(v, 0))).toBe(true);
    // A series resistance on one breaks the loop.
    values.vsource(1, 0, 120, 0.1);
    expect(solveAc(parallel, values, 60).islands[0].flags).toBe(0);
    // An ideal source whose ends are one node (a closed switch across it).
    const shorted = syntheticNetlist(
      2,
      [
        { a: 1, b: 1, kind: 'vsource' },
        { a: 0, b: 1, kind: 'resistor' },
      ],
      'ac',
    );
    const v2 = new AcBranchValues(2);
    v2.vsource(0, 5, 0, 0);
    v2.resistor(1, 1);
    expect(solveAc(shorted, v2, 60).islands[0].flags).toBe(ISLAND_FLAG_SINGULAR);
    // With a series resistance it drives E / R around itself.
    v2.vsource(0, 5, 0, 2);
    const s2 = solveAc(shorted, v2, 60);
    expect([s2.branches[0], s2.branches[1]]).toStrictEqual([2.5, 0]);
  });

  it('flags a numerically singular island (a non-finite result) as the backstop', () => {
    // 1e-300 F at 60 Hz: an admittance that underflows the factorisation to a non-finite current.
    const values = new AcBranchValues(2);
    values.vsource(0, 1e300, 1e300, 0);
    values.capacitor(1, 1e300);
    const s = solveAc(loop(), values, 60);
    expect(s.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect([...s.nodes, ...s.branches].every((v) => Object.is(v, 0))).toBe(true);
  });

  it('flags an island whose pivot is not finite', () => {
    const values = new AcBranchValues(2);
    values.vsource(0, 1, 0, 0);
    values.resistor(1, Number.MIN_VALUE);
    const s = new AcSolver({ sparseMinUnknowns: 1 }).solve(loop(), values, 60);
    expect(s.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect(solveAc(loop(), values, 60).islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
  });

  it('refuses mismatched values, a bad frequency, missing values and stamps that do not suit the element', () => {
    const netlist = loop();
    const solver = new AcSolver();
    expect(() => solver.solve(netlist, new AcBranchValues(1), 60)).toThrow(/1 values for 2 branches/);
    const good = new AcBranchValues(2);
    good.vsource(0, 1, 0, 0);
    good.resistor(1, 1);
    expect(() => solver.solve(netlist, good, 0)).toThrow(RangeError);
    const unset = new AcBranchValues(2);
    unset.vsource(0, 1, 0, 0);
    expect(() => solver.solve(netlist, unset, 60)).toThrow(/branch 1 has no AC value/);
    const sourceAsPassive = new AcBranchValues(2);
    sourceAsPassive.resistor(0, 1);
    sourceAsPassive.resistor(1, 1);
    expect(() => solver.solve(netlist, sourceAsPassive, 60)).toThrow(/vsource branch 0 stamped as passive/);
    const passiveAsSource = new AcBranchValues(2);
    passiveAsSource.vsource(0, 1, 0, 0);
    passiveAsSource.vsource(1, 1, 0, 0);
    expect(() => solver.solve(netlist, passiveAsSource, 60)).toThrow(/resistor branch 1 stamped as a vsource/);
    const unknown = new AcBranchValues(2);
    unknown.vsource(0, 1, 0, 0);
    unknown.stamps[1] = 9;
    expect(() => solver.solve(netlist, unknown, 60)).toThrow(/unknown AC stamp 9/);
  });

  it('writes into a fitting `out`, allocates otherwise, and leaves non-AC islands as they were', () => {
    const netlist = syntheticNetlist(
      4,
      [
        { a: 0, b: 1, kind: 'vsource' },
        { a: 1, b: 0, kind: 'resistor' },
        { a: 2, b: 3, kind: 'resistor' },
      ],
      'ac',
    );
    expect(netlist.islands.map((i) => i.kind)).toStrictEqual(['ac', 'empty']);
    const values = new AcBranchValues(3);
    values.vsource(0, 1, 0, 0);
    values.resistor(1, 1);
    const out = createDcSolution(netlist);
    out.nodes[4] = 7;
    out.islands[1].referenceNode = 42;
    const solver = new AcSolver();
    expect(solver.solve(netlist, values, 60, out)).toBe(out);
    expect(out.nodes[4]).toBe(7);
    expect(out.islands[1].referenceNode).toBe(42);
    expect(out.islands[1].solved).toBe(false);
    const fresh = solver.solve(netlist, values, 60, createDcSolution(loop()));
    expect(fresh.nodes.length).toBe(8);
    expect(fresh.islands[1]).toStrictEqual({ solved: false, referenceNode: -1, unknowns: 0, flags: 0, iterations: 0 });
  });

  it('grows its storage for larger netlists and its stamp program past its first buffers', () => {
    // A ladder of 300 nodes: about 1,500 stamp calls on the sparse path (over the first 256).
    const n = 300;
    const branches: SyntheticBranch[] = [{ a: 0, b: 1, kind: 'vsource' }];
    for (let node = 2; node < n; node++) branches.push({ a: node - 1, b: node, kind: 'vsource' });
    for (let node = 1; node < n; node++) branches.push({ a: node, b: 0, kind: 'resistor' });
    const netlist = syntheticNetlist(n, branches, 'ac');
    const values = new AcBranchValues(branches.length);
    branches.forEach((b, i) => {
      if (b.kind === 'vsource') values.vsource(i, 1, 0.5, 0.01);
      else if (i % 3 === 0) values.inductor(i, 0.01);
      else if (i % 3 === 1) values.capacitor(i, 1e-5);
      else values.resistor(i, 50);
    });
    const solver = new AcSolver();
    solver.solve(
      loop(),
      (() => {
        const v = new AcBranchValues(2);
        v.vsource(0, 1, 0, 0);
        v.resistor(1, 1);
        return v;
      })(),
      60,
    );
    const s = solver.solve(netlist, values, 60);
    expect(s.islands[0].unknowns).toBe(2 * n - 2);
    checkAcRows({ netlist, values, frequencyHz: 60 }, s, true);
  });
});
