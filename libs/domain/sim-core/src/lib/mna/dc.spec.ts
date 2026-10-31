import { BUILTIN_CATALOG } from '@controls/catalog';
import {
  AC_SOURCE,
  BATTERY,
  benchBus,
  benchLamp,
  end,
  LAMP,
  LEAD,
  origin,
  run,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
} from '../../testing/bench';
import { branchOf, current, nodeOf, syntheticNetlist, voltage } from '../../testing/mna';
import { GMIN_S } from '../constants';
import { compileNetlist } from '../netlist/compile';
import { createDcSolution, DcSolver, islandReferenceNode, ISLAND_FLAG_SINGULAR, solveDc } from './dc';
import { DC_DEFAULT_VALUES, dcBranchValues, DcBranchValues } from './values';

const lampHook = (ohms: number) => (branch: { model: string; index: number }, values: DcBranchValues) => {
  if (branch.model !== 'lamp.incandescent') return false;
  values.resistor(branch.index, ohms);
  return true;
};

describe('GMIN_S', () => {
  it('is the conventional 1e-12 S, marked numerical, with a source', () => {
    expect(GMIN_S).toMatchObject({ value: 1e-12, unit: 'S', kind: 'numerical' });
    expect(GMIN_S.source).toMatch(/^numerical: /);
  });
});

describe('DcBranchValues', () => {
  it('stores each stamp and refuses non-finite or out-of-range values', () => {
    const values = new DcBranchValues(3);
    expect(values.stamp(0)).toBeNull();
    values.resistor(0, 2);
    values.vsource(1, 12, -0);
    values.isource(2, -1.5);
    expect([values.stamp(0), values.stamp(1), values.stamp(2)]).toStrictEqual(['resistor', 'vsource', 'isource']);
    expect(Object.is(values.ohms[1], 0)).toBe(true); // −0 normalised, so the zero-ohm check is exact
    expect(() => values.resistor(0, 0)).toThrow(RangeError);
    expect(() => values.resistor(0, -1)).toThrow(RangeError);
    expect(() => values.resistor(0, Infinity)).toThrow(RangeError);
    expect(() => values.vsource(1, NaN, 0)).toThrow(RangeError);
    expect(() => values.vsource(1, 12, -0.1)).toThrow(RangeError);
    expect(() => values.isource(2, Infinity)).toThrow(RangeError);
    values.clear();
    expect(values.stamp(0)).toBeNull();
  });

  it('stores and refuses exactly the same by slot as by value (resistorFrom, vsourceAt, isourceAt)', () => {
    const cases = [2, 0.5, 0, -0, -1, 12.9, NaN, Infinity, -Infinity, Number.MIN_VALUE];
    const outcome = (set: () => void, values: DcBranchValues) => {
      try {
        set();
        return { stamps: [...values.stamps], ohms: [...values.ohms], emfV: [...values.emfV], amps: [...values.amps] };
      } catch (error) {
        return (error as Error).message;
      }
    };
    for (const a of cases) {
      for (const b of cases) {
        const byValue = new DcBranchValues(1);
        const bySlot = new DcBranchValues(1);
        const slot = (x: number) => Float64Array.of(7, x);
        expect(outcome(() => bySlot.resistorFrom(0, { ohms: a }, 'ohms'), bySlot)).toStrictEqual(
          outcome(() => byValue.resistor(0, a), byValue),
        );
        expect(outcome(() => bySlot.vsourceAt(0, slot(a), slot(b), 1), bySlot)).toStrictEqual(
          outcome(() => byValue.vsource(0, a, b), byValue),
        );
        expect(outcome(() => bySlot.isourceAt(0, slot(a), 1), bySlot)).toStrictEqual(
          outcome(() => byValue.isource(0, a), byValue),
        );
      }
    }
    // −0 normalised by slot too (toStrictEqual tells −0 from +0).
    const values = new DcBranchValues(1);
    values.vsourceAt(0, Float64Array.of(12), Float64Array.of(-0), 0);
    expect(Object.is(values.ohms[0], 0)).toBe(true);
  });
});

describe('dcBranchValues', () => {
  it('defaults leads to their resistance and batteries to their full-charge EMF behind internal R (never the nominal)', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    const values = dcBranchValues(netlist, lampHook(28.8));
    const cell = branchOf(netlist, 1, 'cell');
    expect(values.stamp(cell)).toBe('vsource');
    // A new battery (state of charge 1): the catalogue's 12.9 V open-circuit EMF, never the nominal 12 V.
    expect(values.emfV[cell]).toBe(12.9);
    expect(values.ohms[cell]).toBe(0.023);
    const lead = branchOf(netlist, 1);
    expect(values.ohms[lead]).toBe(netlist.branches[lead].values['resistanceOhm']);
    expect(values.ohms[branchOf(netlist, 3, 'filament')]).toBe(28.8);
    expect(Object.keys(DC_DEFAULT_VALUES)).toStrictEqual(['lead', 'resistor', 'heater', 'battery']);
  });

  it('refuses a branch without a value, and a hook that claims one it did not set', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    expect(() => dcBranchValues(netlist)).toThrow(/no DC value for branch 1 \(lamp.incandescent, entity 3 filament\)/);
    expect(() => dcBranchValues(netlist, () => true)).toThrow(/without setting a value/);
    const lone = syntheticNetlist(2, [{ a: 0, b: 1, kind: 'resistor' }]);
    expect(() => dcBranchValues(lone)).toThrow(/test.element, connection 1/);
  });

  it('reuses `out` when it fits and clears stale values', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    const out = new DcBranchValues(netlist.branches.length);
    out.isource(0, 5);
    expect(dcBranchValues(netlist, lampHook(10), out)).toBe(out);
    expect(out.stamp(0)).toBe('vsource');
    expect(dcBranchValues(netlist, lampHook(10), new DcBranchValues(1))).not.toBe(out);
  });

  it('leaves AC and mixed islands unset', () => {
    const bus = benchBus(TEST_CATALOG);
    run(bus, 'entity.place', { ref: AC_SOURCE, positionMm: origin });
    run(bus, 'entity.place', { ref: LAMP, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'l'), b: end(2, 'a') });
    run(bus, 'lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'n') });
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    expect(netlist.islands.map((i) => i.kind)).toStrictEqual(['ac']);
    const values = dcBranchValues(netlist); // no lamp hook needed: nothing is DC
    expect(netlist.branches.every((b) => values.stamp(b.index) === null)).toBe(true);
    const solution = solveDc(netlist, values);
    expect(solution.islands[0]).toStrictEqual({
      solved: false,
      referenceNode: nodeOf(netlist, 1, 'n'),
      unknowns: 0,
      flags: 0,
      iterations: 0,
    });
    expect(solution.nodes.every((v) => v === 0)).toBe(true);
  });
});

describe('DcSolver', () => {
  it('solves the bench lamp: closed, the lamp is lit; open, the lamp carries nothing', () => {
    for (const closed of [true, false]) {
      const netlist = compileNetlist(benchLamp(closed), BUILTIN_CATALOG);
      const solution = solveDc(netlist, dcBranchValues(netlist, lampHook(28.8)));
      const lamp = current(solution, branchOf(netlist, 3, 'filament'));
      if (closed) expect(lamp).toBeCloseTo(12.9 / (0.023 + 28.8 + 3 * 0.040948155), 8);
      else expect(Math.abs(lamp)).toBeLessThan(1e-10);
      expect(solution.topologyHash).toBe(netlist.topologyHash);
      expect(solution.islands[0]).toMatchObject({
        solved: true,
        flags: 0,
        iterations: 1,
        referenceNode: nodeOf(netlist, 1, 'neg'),
      });
    }
  });

  it('lays out node unknowns then one current unknown per vsource element', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    // Five nodes (one is the reference) and one cell.
    expect(solveDc(netlist, dcBranchValues(netlist, lampHook(5))).islands[0].unknowns).toBe(4 + 1);
  });

  it('picks the negative end of the first source as reference, else the smallest node', () => {
    const net = syntheticNetlist(3, [
      { a: 1, b: 0, kind: 'resistor' },
      { a: 2, b: 1, kind: 'vsource' },
    ]);
    expect(islandReferenceNode(net, net.islands[0])).toBe(2);
    const passive = syntheticNetlist(2, [{ a: 1, b: 0, kind: 'resistor' }]);
    expect(islandReferenceNode(passive, passive.islands[0])).toBe(0);
  });

  it('accepts branches whose ends are one node: a resistor carries nothing, a source its short-circuit current', () => {
    const netlist = syntheticNetlist(1, [
      { a: 0, b: 0, kind: 'resistor' },
      { a: 0, b: 0, kind: 'vsource' },
      { a: 0, b: 0, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(3);
    values.resistor(0, 1);
    values.vsource(1, 12, 0.023);
    values.isource(2, 3);
    const solution = solveDc(netlist, values);
    expect(current(solution, 0)).toBe(0);
    expect(current(solution, 1)).toBeCloseTo(12 / 0.023, 9);
    expect(current(solution, 2)).toBe(3);
    // With no series resistance the same source is a contradiction: singular.
    values.vsource(1, 12, 0);
    expect(solveDc(netlist, values).islands[0].flags).toBe(ISLAND_FLAG_SINGULAR);
  });

  it('stamps a vsource element in current limit as exactly that current', () => {
    const netlist = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(2);
    values.isource(0, 0.5);
    values.resistor(1, 10);
    const solution = solveDc(netlist, values);
    expect(current(solution, 0)).toBe(0.5);
    expect(voltage(solution, 1)).toBeCloseTo(5, 9);
  });

  it('refuses stamps that do not suit the element, missing values and a size mismatch', () => {
    const netlist = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(2);
    expect(() => solveDc(netlist, values)).toThrow(/branch 0 has no DC value/);
    values.resistor(0, 1);
    values.resistor(1, 1);
    expect(() => solveDc(netlist, values)).toThrow(/vsource branch 0 stamped as a resistor/);
    values.vsource(0, 1, 0);
    values.vsource(1, 1, 0);
    expect(() => solveDc(netlist, values)).toThrow(/resistor branch 1 stamped as a vsource/);
    expect(() => solveDc(netlist, new DcBranchValues(5))).toThrow(RangeError);
  });

  it('flags an island whose solve overflows, with every value +0', () => {
    const netlist = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(2);
    values.vsource(0, 1e308, 1e-300);
    values.resistor(1, 1e-300);
    const solution = solveDc(netlist, values);
    expect(solution.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect([...solution.nodes, ...solution.branches].every((v) => Object.is(v, 0))).toBe(true);
  });

  it('flags an island whose pivot vanishes numerically', () => {
    // A resistor of 5e-324 Ω has an infinite conductance, so the first pivot is infinite.
    const netlist = syntheticNetlist(2, [{ a: 0, b: 1, kind: 'resistor' }]);
    const values = new DcBranchValues(1);
    values.resistor(0, 5e-324);
    expect(solveDc(netlist, values).islands[0].flags).toBe(ISLAND_FLAG_SINGULAR);
  });

  it('writes into `out` when it fits and clears a previous singular flag', () => {
    const netlist = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 0, b: 1, kind: 'vsource' },
    ]);
    const values = new DcBranchValues(2);
    values.vsource(0, 1, 0);
    values.vsource(1, 2, 0);
    const solver = new DcSolver();
    const out = createDcSolution(netlist);
    expect(solver.solve(netlist, values, out)).toBe(out);
    expect(out.islands[0].flags).toBe(ISLAND_FLAG_SINGULAR);
    values.vsource(1, 2, 1);
    expect(solver.solve(netlist, values, out)).toBe(out);
    expect(out.islands[0].flags).toBe(0);
    expect(current(out, 1)).toBeCloseTo(1, 12); // (1 − 2) / 1 through the second, back through the first
    const other = syntheticNetlist(1, []);
    expect(solver.solve(other, new DcBranchValues(0), out)).not.toBe(out);
  });

  it('holds a floating cluster stiffer than gmin / ε by gmin alone, never singular', () => {
    // Nodes 1 and 2 joined by two parallel 0.1 mΩ resistors (2e4 S, where G + gmin rounds to G),
    // fed from node 0 (the reference) only by a current source. With a per-node KCL row the second
    // pivot is G − G = 0 exactly; the cluster's sum row gives 2 gmin instead.
    const netlist = syntheticNetlist(3, [
      { a: 0, b: 1, kind: 'resistor' },
      { a: 1, b: 2, kind: 'resistor' },
      { a: 2, b: 1, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(3);
    values.resistor(1, 1e-4);
    values.resistor(2, 1e-4);
    for (const amps of [0, 1e-3]) {
      values.isource(0, amps);
      const solution = solveDc(netlist, values);
      expect(solution.islands[0]).toMatchObject({ flags: 0, referenceNode: 0, unknowns: 2 });
      // Σ gmin V = I with V1 ≈ V2: each node at I / (2 gmin), 5e8 V for 1 mA (0 V for 0 A).
      expect(voltage(solution, 1)).toBeCloseTo(amps / (2 * GMIN_S.value), 0);
      expect(voltage(solution, 2)).toBeCloseTo(amps / (2 * GMIN_S.value), 0);
      expect(current(solution, 0)).toBe(amps);
      // Node 2's gmin current (amps / 2) arrives through the two equal resistors, amps / 4 each,
      // whatever the 5e8 V common mode: internal currents come from u, not c + u.
      expect(Math.abs(current(solution, 1) - amps / 4)).toBeLessThanOrEqual(1e-15);
      expect(Math.abs(current(solution, 2) + amps / 4)).toBeLessThanOrEqual(1e-15);
    }
  });

  it('a vsource element in current limit feeds a floating cluster through the sum row', () => {
    // F2.4's supply in current limit into a lamp with one end dangling: a vsource element 0 → 1 at
    // 1 mA (its current unknown's column must reach the cluster's sum row), then 0.1 mΩ from 1 to 2.
    // Σ gmin V = 1 mA over nodes 1 and 2, so each sits at 5e8 V, and the resistor carries node 2's
    // gmin current, 5e-4 A.
    const netlist = syntheticNetlist(3, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 2, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(2);
    values.isource(0, 1e-3);
    values.resistor(1, 1e-4);
    const solution = solveDc(netlist, values);
    expect(solution.islands[0]).toMatchObject({ flags: 0, referenceNode: 0 });
    const sum = voltage(solution, 1) + voltage(solution, 2);
    expect(Math.abs(GMIN_S.value * sum - 1e-3)).toBeLessThanOrEqual(1e-15 * 1e-3);
    expect(voltage(solution, 1)).toBeCloseTo(5e8, 0);
    expect(current(solution, 0)).toBe(1e-3);
    expect(Math.abs(current(solution, 1) - GMIN_S.value * voltage(solution, 2))).toBeLessThanOrEqual(1e-15);
  });

  it('pins a floating cluster that holds a voltage source, against another source as the reference', () => {
    // Island reference: branch 0, a 5 V source behind 1 Ω from node 0 to node 3, loaded by 10 Ω.
    // A 1 mA current source from 3 feeds node 1 of a floating cluster {1, 2, 4}: a 2 V source behind
    // 0.5 Ω from 1 to 2, then 0.1 mΩ from 2 to 4 and 100 Ω from 4 back to 1, a loop of ≈ 0.0199 A.
    // The cluster sits at ≈ 3.3e8 V, set by gmin · (V1 + V2 + V4) = 1 mA.
    const netlist = syntheticNetlist(5, [
      { a: 0, b: 3, kind: 'vsource' },
      { a: 3, b: 0, kind: 'resistor' },
      { a: 3, b: 1, kind: 'resistor' },
      { a: 1, b: 2, kind: 'vsource' },
      { a: 2, b: 4, kind: 'resistor' },
      { a: 4, b: 1, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(6);
    values.vsource(0, 5, 1);
    values.resistor(1, 10);
    values.isource(2, 1e-3);
    values.vsource(3, 2, 0.5);
    values.resistor(4, 1e-4);
    values.resistor(5, 100);
    const solution = solveDc(netlist, values);
    expect(solution.islands[0]).toMatchObject({ flags: 0, referenceNode: 0 });
    const gmin = GMIN_S.value;
    const [v1, v2, v4] = [voltage(solution, 1), voltage(solution, 2), voltage(solution, 4)];
    // The common mode, exactly.
    expect(Math.abs(gmin * (v1 + v2 + v4) - 1e-3)).toBeLessThanOrEqual(1e-15 * 1e-3);
    // KCL inside the cluster: node 2 passes the source current on less its gmin leak, and so does
    // node 4. The bound is the 0.1 mΩ branch's own rounding measured relative to the cluster,
    // 16 ε g (|u2| + |u4|) ≈ 1.4e-10 A with u ≈ 2 V; computing currents from c + u instead would be
    // off by g · ulp(3.3e8 V) ≈ 6e-4 A.
    const [is, i24, i41] = [current(solution, 3), current(solution, 4), current(solution, 5)];
    const relative = 16 * Number.EPSILON * 1e4 * (Math.abs(v2 - v1) + Math.abs(v4 - v1));
    expect(relative).toBeLessThan(1e-9);
    expect(Math.abs(i24 - (is - gmin * v2))).toBeLessThanOrEqual(relative);
    expect(Math.abs(i41 - (i24 - gmin * v4))).toBeLessThanOrEqual(relative);
    // The cluster's source row: V2 − V1 = 2 − 0.5 · I_s, to the ulps of the 3.3e8 V voltages.
    expect(Math.abs(v2 - v1 - (2 - 0.5 * is))).toBeLessThanOrEqual(8 * Number.EPSILON * Math.abs(v1));
    // The rest of the island is unaffected: 5 V behind 1 Ω into 10 Ω, less the 1 mA fed away.
    expect(voltage(solution, 3)).toBeCloseTo((5 / 1 - 1e-3) / (1 / 1 + 1 / 10), 9);
  });

  it('normalises −0 sources to +0 everywhere', () => {
    // A −0 V source behind 2 Ω, a 3 Ω load and a −0 A current source on a resistor element: every
    // node voltage and branch current is zero, and each must be +0, not −0.
    const netlist = syntheticNetlist(3, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
      { a: 1, b: 2, kind: 'resistor' },
      { a: 2, b: 0, kind: 'vsource' },
    ]);
    const values = new DcBranchValues(4);
    values.vsource(0, -0, 2);
    values.resistor(1, 3);
    values.isource(2, -0);
    values.isource(3, -0);
    const solution = solveDc(netlist, values);
    expect(solution.islands[0].flags).toBe(0);
    for (const v of [...solution.nodes, ...solution.branches]) expect(Object.is(v, 0)).toBe(true);
  });

  it('gives every value one bit pattern: no −0 and the imaginary parts +0', () => {
    const netlist = compileNetlist(benchLamp(false), BUILTIN_CATALOG);
    const solution = solveDc(netlist, dcBranchValues(netlist, lampHook(28.8)));
    for (const v of [...solution.nodes, ...solution.branches]) expect(Object.is(v, -0)).toBe(false);
    for (let i = 1; i < solution.nodes.length; i += 2) expect(solution.nodes[i]).toBe(0);
  });

  it('solves a supply set by a hook beside a battery at its default (full-charge) EMF', () => {
    const bus = benchBus(TEST_CATALOG);
    run(bus, 'entity.place', { ref: SUPPLY, positionMm: origin });
    run(bus, 'entity.place', { ref: BATTERY, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'pos') });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'neg'), b: end(2, 'neg') });
    run(bus, 'device.operate', { id: 1, control: 'setpointV', value: 12.9 });
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    const values = dcBranchValues(netlist, (branch, v) => {
      if (branch.model !== 'test.supply') return false;
      v.vsource(branch.index, branch.values['setpointV'], 0);
      return true;
    });
    const solution = solveDc(netlist, values);
    const RL = netlist.branches[branchOf(netlist, 1)].values['resistanceOhm'];
    // An ideal supply at the battery's full-charge EMF (12.9 V) against it: no current flows.
    expect(Math.abs(current(solution, branchOf(netlist, 2, 'cell')))).toBeLessThan(1e-9);
    expect(RL).toBeGreaterThan(0);
  });
});
