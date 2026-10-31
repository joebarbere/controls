import { BUILTIN_CATALOG } from '@controls/catalog';
import type { World } from '@controls/save-format';
import fc from 'fast-check';
import {
  BATTERY,
  benchBus,
  end,
  LAMP,
  LEAD,
  origin,
  SPST,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
} from '../../testing/bench';
import { kcl, power, syntheticNetlist, type SyntheticBranch } from '../../testing/mna';
import { compileNetlist } from '../netlist/compile';
import type { Netlist } from '../netlist/types';
import { DcSolver, type DcSolution, ISLAND_FLAG_SINGULAR, solveDc } from './dc';
import { DC_STAMP_ISOURCE, DC_STAMP_VSOURCE, dcBranchValues, DcBranchValues } from './values';

/*
 * Plan F2.2 part 1 properties over random linear circuits:
 *
 * - KCL holds at every node within 1e-9 · max|I| + 1e-12 A;
 * - the power the sources deliver equals what the resistances and gmin dissipate, within 1e-9
 *   relative (plus the KCL floor carried through Tellegen's theorem, see `power`);
 * - the solution is linear in the sources and obeys superposition;
 * - a singular island is flagged and all +0, every value is finite, and solves are bit-identical.
 *
 * Synthetic circuits: 2–14 nodes in 1–3 islands, each island connected by a random spanning tree of
 * conducting elements (resistors, and voltage sources, some ideal), then up to 14 extra elements that
 * close loops, join islands or loop back on one node, including current sources. Current sources only
 * ever close loops, so no part of a circuit hangs on gmin alone (a 1e9 V node, see the golden "a
 * current source into nothing but gmin"); a separate property drives that case for finiteness. Real
 * circuits: bench worlds of batteries, lamps, switches and a test supply joined by random leads,
 * compiled by `compileNetlist`. Arbitraries are built once at module level, never inside `.chain`,
 * and the generator-health test pins floors on what the circuits contain.
 */

const MAX_NODES = 14;
const MAX_EXTRA = 14;
/**
 * Resistances run 0.1 Ω to 100 kΩ (sources ±48 V). Not lower: a resistor's current is g · (Va − Vb),
 * and node voltages are known only to an ulp, so a branch's current carries an irreducible
 * g · ulp(V) of rounding (1000 S × ulp(48 V) ≈ 7e-12 A for 1 mΩ), above the plan's 1e-12 A KCL floor.
 * At 0.1 Ω it is ≈ 7e-14 A. The bench's leads (0.041 Ω at 12 V) give ≈ 4e-14 A; see the caveats.
 */
const DECADES = [1e-1, 1, 10, 100, 1e3, 1e4];

/** An element and its value, drawn without `.chain`: indices are reduced modulo what they pick from. */
interface ElementDraw {
  /** 0–5 resistor, 6–8 vsource, 9 isource on a resistor element, 10 vsource element in current limit. */
  readonly kind: number;
  readonly mantissa: number;
  readonly decade: number;
  readonly sourceValue: number;
  /** Zero series resistance for a vsource (an ideal source) when 0. */
  readonly ideal: number;
}
const elementArb: fc.Arbitrary<ElementDraw> = fc.record({
  kind: fc.nat({ max: 10 }),
  mantissa: fc.nat({ max: 8999 }),
  decade: fc.nat({ max: DECADES.length - 1 }),
  sourceValue: fc.integer({ min: -4800, max: 4800 }),
  ideal: fc.nat({ max: 7 }),
});
interface CircuitDraw {
  readonly nodes: number;
  readonly islands: number;
  readonly tree: readonly (readonly [number, ElementDraw])[];
  readonly extra: readonly (readonly [number, number, ElementDraw])[];
}
const circuitArb: fc.Arbitrary<CircuitDraw> = fc.record({
  nodes: fc.integer({ min: 2, max: MAX_NODES }),
  islands: fc.integer({ min: 1, max: 3 }),
  tree: fc.array(fc.tuple(fc.nat({ max: 1000 }), elementArb), { minLength: MAX_NODES, maxLength: MAX_NODES }),
  extra: fc.array(fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), elementArb), { maxLength: MAX_EXTRA }),
});

interface Circuit {
  readonly netlist: Netlist;
  readonly values: DcBranchValues;
}

const ohmsOf = (e: ElementDraw) => (1 + e.mantissa / 1000) * DECADES[e.decade];

/** Builds a synthetic circuit. `conducting` restricts an element to a resistor or a voltage-mode source. */
function build(draw: CircuitDraw): Circuit {
  const n = draw.nodes;
  const groups = Math.min(draw.islands, n);
  const groupStart = (g: number) => Math.floor((g * n) / groups);
  const groupOf = (node: number) => {
    let g = groups - 1;
    while (groupStart(g) > node) g--;
    return g;
  };
  const edges: { a: number; b: number; e: ElementDraw; conducting: boolean }[] = [];
  for (let node = 1; node < n; node++) {
    const start = groupStart(groupOf(node));
    if (node === start) continue;
    const [pick, e] = draw.tree[node];
    const other = start + (pick % (node - start));
    // Alternate the orientation so sources point both ways.
    edges.push(
      pick % 2 === 0 ? { a: other, b: node, e, conducting: true } : { a: node, b: other, e, conducting: true },
    );
  }
  for (const [x, y, e] of draw.extra) {
    const a = x % n;
    if (e.kind <= 8) {
      // A conducting extra may join any two nodes, merging islands.
      edges.push({ a, b: y % n, e, conducting: false });
    } else {
      // A current source stays inside its node's group, whose tree already conducts, so it closes a
      // loop and never leaves a node that only gmin returns.
      const group = groupOf(a);
      const start = groupStart(group);
      const size = (group + 1 < groups ? groupStart(group + 1) : n) - start;
      edges.push({ a, b: start + (y % size), e, conducting: false });
    }
  }

  const kindOf = (e: ElementDraw, conducting: boolean) => {
    const k = conducting ? e.kind % 9 : e.kind;
    return k >= 6 && k !== 9 ? 'vsource' : 'resistor';
  };
  const branches: SyntheticBranch[] = edges.map(({ a, b, e, conducting }) => ({ a, b, kind: kindOf(e, conducting) }));
  const netlist = syntheticNetlist(n, branches);
  const values = dcBranchValues(netlist, (branch, v) => {
    const { e, conducting } = edges[branch.index];
    const k = conducting ? e.kind % 9 : e.kind;
    const source = e.sourceValue / 100;
    if (k <= 5) v.resistor(branch.index, ohmsOf(e));
    else if (k <= 8) v.vsource(branch.index, source, e.ideal === 0 ? 0 : ohmsOf(e) / 100);
    else v.isource(branch.index, source / 10);
    return true;
  });
  return { netlist, values };
}

const singular = (solution: DcSolution, island: number) =>
  (solution.islands[island].flags & ISLAND_FLAG_SINGULAR) !== 0;

/** Checks the physics on every solved, non-singular island, and the singular contract on the rest. */
function checkPhysics({ netlist, values }: Circuit, solution: DcSolution): void {
  for (const v of solution.nodes) expect(Number.isFinite(v)).toBe(true);
  for (const v of solution.branches) expect(Number.isFinite(v)).toBe(true);
  for (const island of netlist.islands) {
    if (!solution.islands[island.index].solved) continue;
    if (singular(solution, island.index)) {
      for (const node of island.nodes) expect(Object.is(solution.nodes[2 * node], 0)).toBe(true);
      for (const b of island.branches) expect(Object.is(solution.branches[2 * b], 0)).toBe(true);
      continue;
    }
    const { worst, maxI } = kcl(netlist, solution, island);
    expect(worst, `KCL on island ${island.index}`).toBeLessThanOrEqual(1e-9 * maxI + 1e-12);
    const { delivered, dissipated, scale, voltageSum } = power(netlist, values, solution, island);
    expect(Math.abs(delivered - dissipated), `power on island ${island.index}`).toBeLessThanOrEqual(
      1e-9 * scale + 1e-12 * voltageSum,
    );
  }
}

/** A copy of `values` with each source's value scaled by `k` where `keep(branch)`, and zeroed elsewhere. */
function scaledSources(values: DcBranchValues, k: number, keep: (branch: number) => boolean): DcBranchValues {
  const out = new DcBranchValues(values.count);
  out.stamps.set(values.stamps);
  out.ohms.set(values.ohms);
  for (let b = 0; b < values.count; b++) {
    const factor = keep(b) ? k : 0;
    out.emfV[b] = values.emfV[b] * factor;
    out.amps[b] = values.amps[b] * factor;
  }
  return out;
}

const maxAbs = (xs: Float64Array) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/**
 * |x − y| ≤ 1e-9 · scale + floor componentwise, over node voltages and branch currents. The floor is
 * the 1e-12 a single solve is held to, times how many solves' errors `y` carries (k for k · x̂, 2
 * for a sum of two).
 */
function expectClose(
  x: DcSolution,
  y: { nodes: Float64Array; branches: Float64Array },
  scaleV: number,
  scaleI: number,
  floor: number,
): void {
  x.nodes.forEach((v, i) => expect(Math.abs(v - y.nodes[i])).toBeLessThanOrEqual(1e-9 * scaleV + floor));
  x.branches.forEach((v, i) => expect(Math.abs(v - y.branches[i])).toBeLessThanOrEqual(1e-9 * scaleI + floor));
}

const isSource = (values: DcBranchValues, b: number) =>
  values.stamps[b] === DC_STAMP_VSOURCE || values.stamps[b] === DC_STAMP_ISOURCE;

// Real bench circuits.
const BENCH_DEVICES = [BATTERY, LAMP, LAMP, SPST, SUPPLY];
interface BenchDraw {
  readonly devices: readonly number[];
  readonly leads: readonly (readonly [number, number])[];
  readonly closed: readonly boolean[];
  readonly lampOhms: readonly number[];
  /** Wire the devices in a ring first (each one's last terminal to the next one's first): series loops. */
  readonly ring: boolean;
}
const benchArb: fc.Arbitrary<BenchDraw> = fc.record({
  devices: fc.array(fc.nat({ max: BENCH_DEVICES.length - 1 }), { minLength: 2, maxLength: 6 }),
  leads: fc.array(fc.tuple(fc.nat({ max: 63 }), fc.nat({ max: 63 })), { minLength: 1, maxLength: 10 }),
  closed: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  lampOhms: fc.array(fc.integer({ min: 1, max: 2000 }), { minLength: 6, maxLength: 6 }),
  ring: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
});

function buildBench(draw: BenchDraw): Circuit & { world: World } {
  const bus = benchBus(TEST_CATALOG);
  const terminals: { entity: number; terminal: string }[] = [];
  draw.devices.forEach((d, i) => {
    const ref = BENCH_DEVICES[d];
    bus.exec('entity.place', { ref, positionMm: origin });
    for (const t of TEST_CATALOG.device(ref)?.terminals ?? []) terminals.push({ entity: i + 1, terminal: t.id });
    if (ref === SPST) bus.exec('device.operate', { id: i + 1, control: 'closed', value: draw.closed[i] });
  });
  if (draw.ring) {
    const count = draw.devices.length;
    for (let i = 0; i < count; i++) {
      const from = TEST_CATALOG.device(BENCH_DEVICES[draw.devices[i]])?.terminals ?? [];
      const to = TEST_CATALOG.device(BENCH_DEVICES[draw.devices[(i + 1) % count]])?.terminals ?? [];
      const a = end(i + 1, from[from.length - 1].id);
      const b = end(((i + 1) % count) + 1, to[0].id);
      bus.exec('lead.connect', { ref: LEAD, a, b });
    }
  }
  for (const [x, y] of draw.leads) {
    const a = terminals[x % terminals.length];
    const b = terminals[(x + 1 + (y % (terminals.length - 1))) % terminals.length];
    bus.exec('lead.connect', { ref: LEAD, a: end(a.entity, a.terminal), b: end(b.entity, b.terminal) });
  }
  const world = bus.state;
  const netlist = compileNetlist(world, TEST_CATALOG, { models: TEST_MODELS });
  const values = dcBranchValues(netlist, (branch, v) => {
    if (branch.element.kind !== 'entity') return false;
    if (branch.model === 'lamp.incandescent') {
      v.resistor(branch.index, draw.lampOhms[branch.element.entity - 1] / 10);
      return true;
    }
    if (branch.model === 'test.supply') {
      v.vsource(branch.index, branch.values['setpointV'], 0.01);
      return true;
    }
    return false;
  });
  return { world, netlist, values };
}

// A current source into an otherwise floating resistor cluster: gmin alone sets its level.
const floatingArb = fc.record({
  cluster: fc.array(fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 }), elementArb), { minLength: 1, maxLength: 8 }),
  amps: fc.integer({ min: -500, max: 500 }),
});

/**
 * A loop of ideal sources inside a resistive mesh: nodes 1–3 joined by three zero-ohm sources in a
 * triangle, and by resistors to each other and to node 0. Pivoting on the mesh's conductances makes
 * the elimination inexact, so the singular pivot comes out as rounding noise rather than an exact 0:
 * only the structural check catches it (planted-fault finding: without it, about 3 in 4 of these
 * returned garbage currents unflagged).
 */
const meshLoopArb = fc.record({
  conductances: fc.array(fc.integer({ min: 3, max: 30_000 }), { minLength: 6, maxLength: 6 }),
  emfs: fc.array(fc.integer({ min: -5000, max: 5000 }), { minLength: 3, maxLength: 3 }),
});
const MESH = syntheticNetlist(4, [
  { a: 0, b: 1, kind: 'resistor' },
  { a: 0, b: 2, kind: 'resistor' },
  { a: 0, b: 3, kind: 'resistor' },
  { a: 1, b: 2, kind: 'resistor' },
  { a: 2, b: 3, kind: 'resistor' },
  { a: 3, b: 1, kind: 'resistor' },
  { a: 1, b: 2, kind: 'vsource' },
  { a: 2, b: 3, kind: 'vsource' },
  { a: 3, b: 1, kind: 'vsource' },
]);

describe('DC MNA properties (synthetic circuits)', () => {
  it('KCL holds at every node and power balances, gmin losses included', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const circuit = build(draw);
        checkPhysics(circuit, solveDc(circuit.netlist, circuit.values));
      }),
      { numRuns: 300 },
    );
  });

  it('is linear: scaling every source by k scales the solution by k', () => {
    fc.assert(
      fc.property(circuitArb, fc.constantFrom(-3, 0.5, 2.5, 1e3, 0), (draw, k) => {
        const circuit = build(draw);
        const base = solveDc(circuit.netlist, circuit.values);
        const scaled = solveDc(
          circuit.netlist,
          scaledSources(circuit.values, k, () => true),
        );
        const expected = { nodes: base.nodes.map((v) => k * v), branches: base.branches.map((v) => k * v) };
        expectClose(
          scaled,
          expected,
          Math.abs(k) * maxAbs(base.nodes),
          Math.abs(k) * maxAbs(base.branches),
          (1 + Math.abs(k)) * 1e-12,
        );
        expect(scaled.islands.map((i) => i.flags)).toStrictEqual(base.islands.map((i) => i.flags));
      }),
      { numRuns: 200 },
    );
  });

  it('obeys superposition: the response to two sets of sources is the sum of each alone', () => {
    fc.assert(
      fc.property(circuitArb, fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }), (draw, mask) => {
        const circuit = build(draw);
        const keep = (b: number) => mask[b % mask.length];
        const all = solveDc(circuit.netlist, circuit.values);
        const first = solveDc(circuit.netlist, scaledSources(circuit.values, 1, keep));
        const second = solveDc(
          circuit.netlist,
          scaledSources(circuit.values, 1, (b) => !keep(b)),
        );
        const sum = {
          nodes: first.nodes.map((v, i) => v + second.nodes[i]),
          branches: first.branches.map((v, i) => v + second.branches[i]),
        };
        const scaleV = Math.max(maxAbs(all.nodes), maxAbs(first.nodes), maxAbs(second.nodes));
        const scaleI = Math.max(maxAbs(all.branches), maxAbs(first.branches), maxAbs(second.branches));
        expectClose(all, sum, scaleV, scaleI, 3e-12);
      }),
      { numRuns: 200 },
    );
  });

  it('flags exactly the islands whose ideal sources close a loop, and never produces NaN', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const { netlist, values } = build(draw);
        const solution = solveDc(netlist, values);
        for (const island of netlist.islands) {
          // Reference check: is there a cycle among zero-ohm voltage-mode sources? (Kruskal-style.)
          const parent = new Map<number, number>(island.nodes.map((n) => [n, n]));
          const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x) as number));
          let loop = false;
          for (const b of island.branches) {
            if (values.stamps[b] !== DC_STAMP_VSOURCE || values.ohms[b] !== 0) continue;
            const ra = find(netlist.branches[b].a);
            const rb = find(netlist.branches[b].b);
            if (ra === rb) loop = true;
            else parent.set(ra, rb);
          }
          expect(singular(solution, island.index)).toBe(loop);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('flags a loop of ideal sources inside a resistive mesh, where pivots are inexact', () => {
    fc.assert(
      fc.property(meshLoopArb, ({ conductances, emfs }) => {
        const values = new DcBranchValues(MESH.branches.length);
        conductances.forEach((g, i) => values.resistor(i, 10 / g));
        emfs.forEach((e, i) => values.vsource(6 + i, e / 100, 0));
        const solution = solveDc(MESH, values);
        expect(solution.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
        expect([...solution.nodes, ...solution.branches].every((v) => Object.is(v, 0))).toBe(true);
        // One source given a series resistance breaks the loop: then it solves.
        values.vsource(8, emfs[2] / 100, 0.5);
        const broken = solveDc(MESH, values);
        expect(broken.islands[0].flags).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('is bit-identical across solver instances and after solving other circuits', () => {
    const shared = new DcSolver();
    fc.assert(
      fc.property(circuitArb, circuitArb, (draw, other) => {
        const circuit = build(draw);
        const fresh = new DcSolver().solve(circuit.netlist, circuit.values);
        const otherCircuit = build(other);
        shared.solve(otherCircuit.netlist, otherCircuit.values);
        const reused = shared.solve(circuit.netlist, circuit.values);
        expect(fresh.nodes.every((v, i) => Object.is(v, reused.nodes[i]))).toBe(true);
        expect(fresh.branches.every((v, i) => Object.is(v, reused.branches[i]))).toBe(true);
        expect(fresh.islands).toStrictEqual(reused.islands);
      }),
      { numRuns: 150 },
    );
  });

  it('a current source into a floating cluster gives finite values held by gmin, never singular', () => {
    fc.assert(
      fc.property(floatingArb, ({ cluster, amps }) => {
        // Node 0 feeds node 1 through a current source; nodes 1–6 are a resistor cluster with no other way back.
        const edges: SyntheticBranch[] = [{ a: 0, b: 1, kind: 'resistor' }];
        for (const [x, y] of cluster) edges.push({ a: 1 + x, b: 1 + y, kind: 'resistor' });
        const netlist = syntheticNetlist(7, edges);
        const values = new DcBranchValues(edges.length);
        values.isource(0, amps / 1000);
        cluster.forEach(([, , e], i) => values.resistor(i + 1, ohmsOf(e)));
        const solution = solveDc(netlist, values);
        for (const v of [...solution.nodes, ...solution.branches]) expect(Number.isFinite(v)).toBe(true);
        expect(solution.islands.every((i) => (i.flags & ISLAND_FLAG_SINGULAR) === 0)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('DC MNA properties (compiled bench circuits)', () => {
  it('KCL and power balance hold on random bench worlds', () => {
    fc.assert(
      fc.property(benchArb, (draw) => {
        const circuit = buildBench(draw);
        checkPhysics(circuit, solveDc(circuit.netlist, circuit.values));
      }),
      { numRuns: 100 },
    );
  });
});

describe('generator health (the properties above are not vacuous)', () => {
  it('synthetic circuits are sizeable, loopy, multi-island and hold every stamp', () => {
    const draws = fc.sample(circuitArb, { seed: 20261030, numRuns: 300 });
    let nodes = 0;
    let withLoop = 0;
    let multiIsland = 0;
    let withVsource = 0;
    let withIsource = 0;
    let withIdeal = 0;
    let withSelfLoop = 0;
    let withSingular = 0;
    let withCurrent = 0;
    for (const draw of draws) {
      const { netlist, values } = build(draw);
      const solution = solveDc(netlist, values);
      nodes += netlist.nodes.length;
      if (netlist.branches.length > netlist.nodes.length - netlist.islands.length) withLoop++;
      if (netlist.islands.length > 1) multiIsland++;
      if (netlist.branches.some((b) => values.stamps[b.index] === DC_STAMP_VSOURCE)) withVsource++;
      if (netlist.branches.some((b) => values.stamps[b.index] === DC_STAMP_ISOURCE)) withIsource++;
      if (netlist.branches.some((b) => values.stamps[b.index] === DC_STAMP_VSOURCE && values.ohms[b.index] === 0))
        withIdeal++;
      if (netlist.branches.some((b) => b.a === b.b)) withSelfLoop++;
      if (netlist.islands.some((i) => singular(solution, i.index))) withSingular++;
      // A non-singular island with a real current (more than gmin leakage) somewhere.
      if (
        netlist.islands.some(
          (i) => !singular(solution, i.index) && i.branches.some((b) => Math.abs(solution.branches[2 * b]) > 1e-6),
        )
      ) {
        withCurrent++;
      }
    }
    const share = (count: number) => count / draws.length;
    expect(nodes / draws.length).toBeGreaterThanOrEqual(6);
    expect(share(withLoop)).toBeGreaterThanOrEqual(0.8);
    expect(share(multiIsland)).toBeGreaterThanOrEqual(0.15);
    expect(share(withVsource)).toBeGreaterThanOrEqual(0.8);
    expect(share(withIsource)).toBeGreaterThanOrEqual(0.4);
    expect(share(withIdeal)).toBeGreaterThanOrEqual(0.2);
    expect(share(withSelfLoop)).toBeGreaterThanOrEqual(0.1);
    expect(share(withSingular)).toBeGreaterThanOrEqual(0.02);
    expect(share(withSingular)).toBeLessThanOrEqual(0.25);
    expect(share(withCurrent)).toBeGreaterThanOrEqual(0.7);
  });

  it('bench worlds hold powered circuits with current flowing', () => {
    const draws = fc.sample(benchArb, { seed: 20261030, numRuns: 150 });
    let powered = 0;
    let withLeads = 0;
    let multiIsland = 0;
    for (const draw of draws) {
      const { netlist, values } = buildBench(draw);
      const solution = solveDc(netlist, values);
      if (netlist.branches.filter((b) => b.element.kind === 'connection').length >= 2) withLeads++;
      if (netlist.islands.length > 1) multiIsland++;
      const flowing = netlist.branches.some(
        (b) => b.kind === 'resistor' && b.element.kind === 'entity' && Math.abs(solution.branches[2 * b.index]) > 1e-3,
      );
      if (flowing) powered++;
    }
    expect(withLeads / draws.length).toBeGreaterThanOrEqual(0.6);
    expect(multiIsland / draws.length).toBeGreaterThanOrEqual(0.1);
    expect(powered / draws.length).toBeGreaterThanOrEqual(0.3);
    // The built-in catalogue's refs are all here: these are real worlds, not synthetic kinds alone.
    expect(BUILTIN_CATALOG.device(BATTERY)).toBeDefined();
  });
});
