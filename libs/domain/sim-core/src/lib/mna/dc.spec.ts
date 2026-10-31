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
});

describe('dcBranchValues', () => {
  it('defaults leads to their resistance and batteries to nominal EMF behind internal R', () => {
    const netlist = compileNetlist(benchLamp(true), BUILTIN_CATALOG);
    const values = dcBranchValues(netlist, lampHook(28.8));
    const cell = branchOf(netlist, 1, 'cell');
    expect(values.stamp(cell)).toBe('vsource');
    expect(values.emfV[cell]).toBe(12);
    expect(values.ohms[cell]).toBe(0.023);
    const lead = branchOf(netlist, 1);
    expect(values.ohms[lead]).toBe(netlist.branches[lead].values['resistanceOhm']);
    expect(values.ohms[branchOf(netlist, 3, 'filament')]).toBe(28.8);
    expect(Object.keys(DC_DEFAULT_VALUES)).toStrictEqual(['lead', 'battery']);
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
      if (closed) expect(lamp).toBeCloseTo(12 / (0.023 + 28.8 + 3 * 0.040948155), 8);
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

  it('solves a supply set by a hook beside a battery, as F2.4 will', () => {
    const bus = benchBus(TEST_CATALOG);
    run(bus, 'entity.place', { ref: SUPPLY, positionMm: origin });
    run(bus, 'entity.place', { ref: BATTERY, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'pos') });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'neg'), b: end(2, 'neg') });
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    const values = dcBranchValues(netlist, (branch, v) => {
      if (branch.model !== 'test.supply') return false;
      v.vsource(branch.index, branch.values['setpointV'], 0);
      return true;
    });
    const solution = solveDc(netlist, values);
    const RL = netlist.branches[branchOf(netlist, 1)].values['resistanceOhm'];
    // An ideal 12 V supply against a 12 V battery: no current flows.
    expect(Math.abs(current(solution, branchOf(netlist, 2, 'cell')))).toBeLessThan(1e-9);
    expect(RL).toBeGreaterThan(0);
  });
});
