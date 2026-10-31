import fc from 'fast-check';
import type { World } from '@controls/save-format';
import {
  BATTERY,
  benchBus,
  end,
  LAMP,
  LEAD,
  origin,
  run,
  SPST,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
} from '../../testing/bench';
import { dcGoldens } from '../../testing/dc-goldens';
import { islandUnknowns, largeCircuit, type LargeCircuitSpec } from '../../testing/large-circuits';
import { syntheticNetlist, type SyntheticBranch } from '../../testing/mna';
import { checkPhysics, checkRows, type Circuit, expectSameBits, isSingular } from '../../testing/solver-checks';
import { GMIN_S, SPARSE_MIN_UNKNOWNS } from '../constants';
import { compileNetlist } from '../netlist/compile';
import { amdOrder } from '../lu/amd';
import { SparseFactors, SparseLu } from '../lu/sparse-lu';
import { DcSolver, type DcSolution, ISLAND_FLAG_SINGULAR } from './dc';
import { FactorisationCache } from './factorisation-cache';
import { DC_STAMP_VSOURCE, dcBranchValues, DcBranchValues } from './values';

/*
 * F2.2 part 3: the sparse path of `DcSolver` (Gilbert–Peierls LU in AMD order), its factorisation
 * cache and the dense/sparse agreement, under the plan's F2.2 floor policy:
 *
 * - residuals on every circuit: each solver's solution passes KCL and the source rows;
 * - values on the well-conditioned subset only (resistances 1 Ω–10 kΩ, every source behind ≥ 0.1 Ω):
 *   there a value comparison measures something, since the forward error is small; elsewhere it is
 *   unbounded (near-ideal source loops held by weak ties), and two correct solvers may differ.
 *
 * `sparseMinUnknowns: 1` forces every island onto the sparse path; a huge one forces dense.
 */

const dense = () => new DcSolver({ sparseMinUnknowns: Number.MAX_SAFE_INTEGER });
const sparse = (cache?: FactorisationCache) => new DcSolver({ sparseMinUnknowns: 1, cache });

/** Dense/sparse agreement on values: 1e-9 relative to the island's largest |V| (or |I|). */
const AGREEMENT = 1e-9;
const EPS = Number.EPSILON;

/**
 * The worst ratio of a dense/sparse difference to its bound (≤ 1 agrees). Voltages: 1e-9 of the
 * island's largest |V|. Currents: 1e-9 of its largest |I|, plus the floor policy's absolute term: a
 * current is resolved only to about ε · G · V (a resistor's g · ulp(V), and a source current from KCL
 * rows holding G), so where only gmin carries current (a radial tree has no loop) the two LUs may
 * differ by 2 · 16 ε · G_max · V_max however well-conditioned the circuit.
 */
function worstDisagreement(circuit: Circuit, a: DcSolution, b: DcSolution): number {
  let worst = 0;
  for (const island of circuit.netlist.islands) {
    if (isSingular(a, island.index)) continue;
    let vScale = 0;
    let iScale = 0;
    let gMax = GMIN_S.value;
    for (const node of island.nodes) vScale = Math.max(vScale, Math.abs(a.nodes[2 * node]));
    for (const br of island.branches) {
      iScale = Math.max(iScale, Math.abs(a.branches[2 * br]));
      if (circuit.values.stamp(br) === 'resistor') gMax = Math.max(gMax, 1 / circuit.values.ohms[br]);
      if (circuit.values.stamp(br) === 'vsource' && circuit.values.ohms[br] > 0) {
        gMax = Math.max(gMax, 1 / circuit.values.ohms[br]);
      }
    }
    for (const node of island.nodes) {
      const d = Math.abs(a.nodes[2 * node] - b.nodes[2 * node]);
      worst = Math.max(worst, d / (AGREEMENT * vScale + 1e-15));
    }
    const currentFloor = 2 * 16 * EPS * gMax * vScale + 1e-15;
    for (const br of island.branches) {
      const d = Math.abs(a.branches[2 * br] - b.branches[2 * br]);
      worst = Math.max(worst, d / (AGREEMENT * iScale + currentFloor));
    }
  }
  return worst;
}

// Arbitraries, built once at module level.
const largeArb: fc.Arbitrary<LargeCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 40, max: 260 }),
  islands: fc.integer({ min: 1, max: 3 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.boolean(),
});
const smallArb: fc.Arbitrary<LargeCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 2, max: 24 }),
  islands: fc.integer({ min: 1, max: 4 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.boolean(),
});

/**
 * A floating cluster of `size` nodes behind a current source: node 0 feeds member `into` through a
 * current source (a resistor element, or a `vsource` element in current limit), and the cluster is a
 * random tree of resistors down to 0.1 mΩ with some loops: no other way back.
 */
const floatingArb = fc.record({
  size: fc.integer({ min: 70, max: 160 }),
  seed: fc.integer(),
  amps: fc.integer({ min: -500, max: 500 }).filter((a) => a !== 0),
  feedKind: fc.constantFrom('resistor' as const, 'vsource' as const),
  into: fc.nat(),
});

function floatingCluster({
  size,
  seed,
  amps,
  feedKind,
  into,
}: {
  size: number;
  seed: number;
  amps: number;
  feedKind: 'resistor' | 'vsource';
  into: number;
}): Circuit & { feed: number; members: number[] } {
  let state = seed | 0 || 1;
  const next = (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
  const target = 1 + (into % size);
  const edges: SyntheticBranch[] = [{ a: 0, b: target, kind: feedKind }];
  const ohms: number[] = [0];
  for (let node = 2; node <= size; node++) {
    edges.push({ a: 1 + next(node - 1), b: node, kind: 'resistor' });
    ohms.push((1 + next(9000) / 1000) * [1e-4, 1e-2, 1, 100][next(4)]);
  }
  for (let e = 0; e < size / 10; e++) {
    edges.push({ a: 1 + next(size), b: 1 + next(size), kind: 'resistor' });
    ohms.push((1 + next(9000) / 1000) * [1e-4, 1, 1e3][next(3)]);
  }
  const netlist = syntheticNetlist(size + 1, edges);
  const values = new DcBranchValues(edges.length);
  const feed = amps / 1000;
  values.isource(0, feed);
  for (let b = 1; b < edges.length; b++) values.resistor(b, ohms[b]);
  return { netlist, values, feed, members: Array.from({ length: size }, (_, i) => i + 1) };
}

/** A battery feeding `lamps` lamps in parallel; lamp 1 through an SPST switch (entity 2). */
function ladder(lamps: number, closed: boolean, setpoint?: number): World {
  const bus = benchBus(TEST_CATALOG);
  run(bus, 'entity.place', { ref: setpoint === undefined ? BATTERY : SUPPLY, positionMm: origin });
  run(bus, 'entity.place', { ref: SPST, positionMm: origin });
  if (setpoint !== undefined) run(bus, 'device.operate', { id: 1, control: 'setpointV', value: setpoint });
  const [neg, pos] = ['neg', 'pos'];
  for (let i = 0; i < lamps; i++) {
    const lamp = 3 + i;
    run(bus, 'entity.place', { ref: LAMP, positionMm: origin });
    if (i === 0) {
      run(bus, 'lead.connect', { ref: LEAD, a: end(1, pos), b: end(2, 'a') });
      run(bus, 'lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(lamp, 'a') });
    } else {
      run(bus, 'lead.connect', { ref: LEAD, a: end(lamp - 1, 'a'), b: end(lamp, 'a') });
    }
    run(bus, 'lead.connect', { ref: LEAD, a: end(lamp, 'b'), b: end(1, neg) });
  }
  if (closed) run(bus, 'device.operate', { id: 2, control: 'closed', value: true });
  return bus.state;
}

function compileLadder(world: World): Circuit {
  const netlist = compileNetlist(world, TEST_CATALOG, { models: TEST_MODELS });
  const values = dcBranchValues(netlist, (branch, v) => {
    if (branch.model === 'lamp.incandescent') {
      v.resistor(branch.index, 28.8);
      return true;
    }
    if (branch.model === 'test.supply') {
      v.vsource(branch.index, branch.values['setpointV'], 0.01);
      return true;
    }
    return false;
  });
  return { netlist, values };
}

describe('DcSolver sparse path', () => {
  it('validates sparseMinUnknowns and defaults it to SPARSE_MIN_UNKNOWNS', () => {
    expect(new DcSolver().sparseMinUnknowns).toBe(SPARSE_MIN_UNKNOWNS.value);
    expect(SPARSE_MIN_UNKNOWNS.kind).toBe('numerical');
    expect(() => new DcSolver({ sparseMinUnknowns: 0 })).toThrow(RangeError);
    expect(() => new DcSolver({ sparseMinUnknowns: 2.5 })).toThrow(RangeError);
  });

  it('passes every DC golden fixture on the sparse path', () => {
    for (const golden of dcGoldens()) {
      const solution = sparse().solve(golden.netlist, golden.values);
      for (const check of golden.checks) {
        const tolerance = check.tolerance ?? golden.tolerance;
        const bound = tolerance * Math.abs(check.expected) + (check.absolute ?? 1e-12);
        expect(Math.abs(check.actual(solution) - check.expected), `${golden.name}: ${check.label}`).toBeLessThanOrEqual(
          bound,
        );
      }
      const singular = new Set(golden.singular ?? []);
      for (const island of golden.netlist.islands) {
        expect(isSingular(solution, island.index), `${golden.name} island ${island.index}`).toBe(
          singular.has(island.index),
        );
      }
      checkPhysics(golden, solution);
    }
  });

  it('agrees with dense LU on large random circuits: residuals on all, values on the well-conditioned', () => {
    fc.assert(
      fc.property(largeArb, (spec) => {
        const circuit = largeCircuit(spec);
        const d = dense().solve(circuit.netlist, circuit.values);
        const s = sparse().solve(circuit.netlist, circuit.values);
        expect(s.islands.map((i) => i.flags)).toStrictEqual(d.islands.map((i) => i.flags));
        expect(s.islands.map((i) => i.unknowns)).toStrictEqual(d.islands.map((i) => i.unknowns));
        checkRows(circuit, d);
        checkRows(circuit, s);
        if (spec.wellConditioned) expect(worstDisagreement(circuit, d, s)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 14 },
    );
  });

  it('agrees with dense LU on small circuits forced sparse (self-loops, tiny islands, ideal sources)', () => {
    fc.assert(
      fc.property(smallArb, (spec) => {
        const circuit = largeCircuit(spec);
        const d = dense().solve(circuit.netlist, circuit.values);
        const s = sparse().solve(circuit.netlist, circuit.values);
        expect(s.islands.map((i) => i.flags)).toStrictEqual(d.islands.map((i) => i.flags));
        checkPhysics(circuit, s);
        if (spec.wellConditioned) expect(worstDisagreement(circuit, d, s)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 150 },
    );
  });

  it('pins a floating cluster structurally on the sparse path: never singular, gmin · ΣV = feed', () => {
    fc.assert(
      fc.property(floatingArb, (draw) => {
        const circuit = floatingCluster(draw);
        const solution = sparse().solve(circuit.netlist, circuit.values);
        expect(solution.islands.every((i) => (i.flags & ISLAND_FLAG_SINGULAR) === 0)).toBe(true);
        expect(solution.islands[0].unknowns).toBeGreaterThanOrEqual(SPARSE_MIN_UNKNOWNS.value);
        checkPhysics(circuit, solution);
        // On a floating cluster the KCL floor is dominated by the common mode, so check the value it
        // sets exactly: gmin · Σ V over the fed component is the feed current.
        let sum = 0;
        for (const n of circuit.members) sum += solution.nodes[2 * n];
        expect(Math.abs(GMIN_S.value * sum - circuit.feed)).toBeLessThanOrEqual(1e-13 * Math.abs(circuit.feed));
        // Internal currents against KCL at each member, measured relative to the cluster (floor
        // policy): the u-block is solved accurately whatever the common mode. Each current carries
        // 16 ε g (|u_a| + |u_b|) of rounding, summed island-wide; |u| = |V − V(rep)| is at most the
        // cluster's voltage spread (plus the ulps of forming it from V).
        let scale = 0;
        let conductance = 0;
        for (let b = 1; b < circuit.netlist.branches.length; b++) {
          scale = Math.max(scale, Math.abs(solution.branches[2 * b]));
          conductance += 1 / circuit.values.ohms[b];
        }
        const volts = circuit.members.map((n) => solution.nodes[2 * n]);
        const top = Math.max(...volts);
        const bottom = Math.min(...volts);
        const spread = top - bottom + 4 * EPS * Math.max(Math.abs(top), Math.abs(bottom));
        const floor = 1e-9 * scale + 2 * 16 * EPS * conductance * 2 * spread + 1e-15;
        const net = new Float64Array(circuit.netlist.nodes.length);
        circuit.netlist.branches.forEach((br, b) => {
          net[br.a] += solution.branches[2 * b];
          net[br.b] -= solution.branches[2 * b];
        });
        for (const n of circuit.members) {
          const leak = GMIN_S.value * solution.nodes[2 * n];
          expect(Math.abs(net[n] + leak), `KCL at member ${n}`).toBeLessThanOrEqual(floor);
        }
      }),
      {
        numRuns: 30,
        // Fresh-seed counterexamples to a bound tighter than the policy's.
        examples: [
          [{ size: 70, seed: -1888842712, amps: -1, feedKind: 'resistor', into: 29 }],
          [{ size: 133, seed: 569216563, amps: -1, feedKind: 'resistor', into: 0 }],
        ],
      },
    );
  });

  it('is bit-identical cold, warm, shared and thrashed (capacity 1), across solver instances', () => {
    fc.assert(
      fc.property(fc.array(largeArb, { minLength: 2, maxLength: 3 }), (specs) => {
        const circuits = specs.map((spec) => largeCircuit(spec));
        const expected = circuits.map((c) => sparse().solve(c.netlist, c.values));
        const shared = new FactorisationCache(1);
        const thrashed = sparse(shared);
        const other = sparse(shared);
        const warm = sparse();
        // Each circuit twice, interleaved, on solvers whose caches hold other topologies or none.
        for (const round of [0, 1]) {
          circuits.forEach((c, i) => {
            expectSameBits(thrashed.solve(c.netlist, c.values), expected[i]);
            expectSameBits(other.solve(c.netlist, c.values), expected[i]);
            expectSameBits(warm.solve(c.netlist, c.values), expected[i]);
            // Only a non-singular island reaches a symbolic factorisation (a singular one is decided
            // structurally first), so only then is the topology cached.
            const factored = expected[i].islands.some(
              (island) => island.solved && (island.flags & ISLAND_FLAG_SINGULAR) === 0,
            );
            if (round === 1) expect(warm.cache.has(c.netlist.topologyHash)).toBe(factored);
          });
        }
        const cached = new Set(
          circuits
            .filter((_, i) =>
              expected[i].islands.some((island) => island.solved && (island.flags & ISLAND_FLAG_SINGULAR) === 0),
            )
            .map((c) => c.netlist.topologyHash),
        );
        expect(shared.stats.topologies).toBe(Math.min(1, cached.size));
        if (cached.size > 1) expect(shared.stats.evictions).toBeGreaterThan(0);
      }),
      {
        numRuns: 5,
        // A singular island beside a factored one: nothing of the first is cached (CI-style fresh seed).
        examples: [
          [
            [
              { nodes: 40, islands: 1, seed: 0, meshPercent: 0, wellConditioned: false },
              { nodes: 174, islands: 1, seed: -1691023813, meshPercent: 14, wellConditioned: false },
            ],
          ],
        ],
      },
    );
  });

  it('hits the cache on returning to an earlier switch state, at the default threshold', () => {
    const closed = compileLadder(ladder(40, true));
    const open = compileLadder(ladder(40, false));
    expect(closed.netlist.topologyHash).not.toBe(open.netlist.topologyHash);
    expect(Math.max(...islandUnknowns(closed.netlist))).toBeGreaterThanOrEqual(SPARSE_MIN_UNKNOWNS.value);
    const solver = new DcSolver();
    const first = solver.solve(closed.netlist, closed.values);
    const sparseIslands = closed.netlist.islands.filter(
      (_, i) => islandUnknowns(closed.netlist)[i] >= SPARSE_MIN_UNKNOWNS.value,
    ).length;
    expect(solver.cache.stats).toMatchObject({ hits: 0, misses: sparseIslands, topologies: 1 });
    solver.solve(open.netlist, open.values);
    const afterOpen = solver.cache.stats;
    expect(afterOpen.hits).toBe(0);
    expect(afterOpen.topologies).toBe(2);
    // Back to closed: every sparse island is a hit, and the result is the cold result bit for bit.
    const again = solver.solve(closed.netlist, closed.values, undefined);
    expect(solver.cache.stats.hits).toBe(sparseIslands);
    expect(solver.cache.stats.misses).toBe(afterOpen.misses);
    expectSameBits(again, first);
    expectSameBits(again, new DcSolver().solve(closed.netlist, closed.values));
    checkPhysics(closed, again);
  });

  it('factors in AMD order: the cached order is AMD of the cached pattern, and fill stays small', () => {
    const { netlist, values } = compileLadder(ladder(60, true));
    const solver = new DcSolver();
    solver.solve(netlist, values);
    const island = netlist.islands.findIndex((_, i) => islandUnknowns(netlist)[i] >= SPARSE_MIN_UNKNOWNS.value);
    const signature = Uint8Array.from(netlist.islands[island].branches, (b) => values.stamps[b]);
    const symbolic = solver.cache.find(netlist.topologyHash, island, signature, signature.length);
    if (symbolic === undefined) throw new Error('no cached symbolic factorisation');
    const { n, colPtr, rowIdx } = symbolic.pattern;
    expect(Array.from(symbolic.order)).toStrictEqual(Array.from(amdOrder(n, colPtr, rowIdx)));
    // A ladder of parallel lamps is a tree of conductances closed through one source: in AMD order
    // the factors add at most a few entries per column over A's own off-diagonal pattern.
    const offDiagonal = colPtr[n] - n;
    const fill = symbolic.factors.lowerNonzeros + symbolic.factors.upperNonzeros;
    expect(fill).toBeLessThanOrEqual(offDiagonal + 2 * n);
    // The natural order of the same matrix fills far more: the ordering is doing work.
    const natural = new SparseFactors();
    const lu = new SparseLu();
    const assembled = new Float64Array(colPtr[n]);
    for (let c = 0; c < symbolic.slots.length; c++) assembled[symbolic.slots[c]] += 1 + (c % 7);
    lu.factor(
      symbolic.pattern,
      assembled,
      Int32Array.from({ length: n }, (_, i) => i),
      1,
      natural,
    );
    expect(natural.lowerNonzeros + natural.upperNonzeros).toBeGreaterThan(2 * fill);
  });

  it('reuses the symbolic factorisation on a value-only change, and replays the numeric one', () => {
    const before = compileLadder(ladder(40, true, 12));
    const after = compileLadder(ladder(40, true, 13.5));
    expect(after.netlist.topologyHash).toBe(before.netlist.topologyHash);
    const solver = new DcSolver();
    solver.solve(before.netlist, before.values);
    const { misses } = solver.cache.stats;
    const replays = solver.sparse.replays;
    const solution = solver.solve(after.netlist, after.values);
    expect(solver.cache.stats.misses).toBe(misses);
    expect(solver.cache.stats.hits).toBeGreaterThan(0);
    expect(solver.sparse.replays).toBeGreaterThan(replays);
    expectSameBits(solution, new DcSolver().solve(after.netlist, after.values));
    checkPhysics(after, solution);
  });

  it('keeps a variant per stamp mode: a source switching to current limit and back hits each', () => {
    const circuit = largeCircuit({ nodes: 120, islands: 1, seed: 99, meshPercent: 10, wellConditioned: true });
    const source = circuit.netlist.branches.findIndex((b) => b.kind === 'vsource');
    const solver = sparse();
    const cv = solver.solve(circuit.netlist, circuit.values);
    const voltageMode = { emf: circuit.values.emfV[source], ohms: circuit.values.ohms[source] };
    circuit.values.isource(source, 0.25);
    const cc = solver.solve(circuit.netlist, circuit.values);
    expect(solver.cache.stats).toMatchObject({ hits: 0, misses: 2, topologies: 1 });
    checkPhysics(circuit, cc);
    expect(cc.branches[2 * source]).toBe(0.25);
    circuit.values.vsource(source, voltageMode.emf, voltageMode.ohms);
    expectSameBits(solver.solve(circuit.netlist, circuit.values), cv);
    circuit.values.isource(source, 0.25);
    expectSameBits(solver.solve(circuit.netlist, circuit.values), cc);
    expect(solver.cache.stats).toMatchObject({ hits: 2, misses: 2 });
    expect(circuit.values.stamps[source]).not.toBe(DC_STAMP_VSOURCE);
  });

  it('refuses a symbolic factorisation from another netlist under the same topologyHash', () => {
    // Same hash and stamp modes, different structure: a caller bug (hand-made netlists), caught rather
    // than misused. A chain (3 unknowns) against a source and resistor in parallel (2 unknowns).
    const chain = syntheticNetlist(3, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 2, kind: 'resistor' },
    ]);
    const parallel = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 0, b: 1, kind: 'resistor' },
    ]);
    const two = new DcBranchValues(2);
    two.vsource(0, 12, 0.1);
    two.resistor(1, 10);
    const small = sparse();
    small.solve(chain, two);
    expect(() => small.solve({ ...parallel, topologyHash: chain.topologyHash }, two)).toThrow(/share topologyHash/);
    // A different signature under the same hash is only a miss: a new variant, solved correctly.
    const a = largeCircuit({ nodes: 80, islands: 1, seed: 1, meshPercent: 10, wellConditioned: true });
    const b = largeCircuit({ nodes: 90, islands: 1, seed: 2, meshPercent: 10, wellConditioned: true });
    const solver = sparse();
    solver.solve(a.netlist, a.values);
    const relabelled = { ...b.netlist, topologyHash: a.netlist.topologyHash };
    checkRows({ netlist: relabelled, values: b.values }, solver.solve(relabelled, b.values));
    // Same unknowns and stamp modes, but one resistor rewired to the reference node: fewer stamp
    // calls than the cached slot map, caught too.
    const reference = a.netlist.branches.find((br) => br.kind === 'vsource')?.a ?? 0;
    const moved = a.netlist.branches.findIndex(
      (br) => br.kind === 'resistor' && br.a !== br.b && br.a !== reference && br.b !== reference,
    );
    const rewired = syntheticNetlist(
      80,
      a.netlist.branches.map((br, i) => ({ a: br.a, b: i === moved ? reference : br.b, kind: br.kind })),
    );
    expect(rewired.islands).toHaveLength(1);
    expect(() => solver.solve({ ...rewired, topologyHash: a.netlist.topologyHash }, a.values)).toThrow(
      /stale or mismatched/,
    );
  });

  it('flags ideal-source loops on the sparse path as singular, all +0', () => {
    const circuit = largeCircuit({ nodes: 100, islands: 1, seed: 5, meshPercent: 10, wellConditioned: true });
    const sources = circuit.netlist.branches.filter((b) => b.kind === 'vsource').map((b) => b.index);
    // Two ideal sources across the same pair of nodes.
    const n = circuit.netlist.nodes.length;
    const edges = circuit.netlist.branches.map((b) => ({ a: b.a, b: b.b, kind: b.kind }));
    edges.push({ a: 3, b: n - 1, kind: 'vsource' }, { a: 3, b: n - 1, kind: 'vsource' });
    const netlist = syntheticNetlist(n, edges);
    const values = new DcBranchValues(edges.length);
    values.stamps.set(circuit.values.stamps);
    values.ohms.set(circuit.values.ohms);
    values.emfV.set(circuit.values.emfV);
    values.amps.set(circuit.values.amps);
    values.vsource(edges.length - 2, 5, 0);
    values.vsource(edges.length - 1, 6, 0);
    const solution = sparse().solve(netlist, values);
    expect(solution.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect([...solution.nodes, ...solution.branches].every((v) => Object.is(v, 0))).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
  });
});

describe('generator health (sparse specs are not vacuous)', () => {
  it('large circuits are big, loopy, multi-island and hold every stamp', () => {
    const specs = fc.sample(largeArb, { seed: 20261030, numRuns: 60 });
    let islands = 0;
    let sparseIslands = 0;
    let unknowns = 0;
    let withLoop = 0;
    let multi = 0;
    let withIsource = 0;
    let withCurrentLimit = 0;
    let withIdeal = 0;
    let withSingular = 0;
    let wellConditioned = 0;
    let differentBits = 0;
    for (const spec of specs) {
      const { netlist, values } = largeCircuit(spec);
      const counts = islandUnknowns(netlist);
      islands += counts.length;
      sparseIslands += counts.filter((u) => u >= SPARSE_MIN_UNKNOWNS.value).length;
      unknowns += counts.reduce((s, u) => s + u, 0);
      if (netlist.branches.length > netlist.nodes.length - netlist.islands.length) withLoop++;
      if (netlist.islands.length > 1) multi++;
      if (netlist.branches.some((b) => b.kind === 'resistor' && values.stamp(b.index) === 'isource')) withIsource++;
      if (netlist.branches.some((b) => b.kind === 'vsource' && values.stamp(b.index) === 'isource')) withCurrentLimit++;
      if (netlist.branches.some((b) => values.stamp(b.index) === 'vsource' && values.ohms[b.index] === 0)) withIdeal++;
      const d = dense().solve(netlist, values);
      const s = sparse().solve(netlist, values);
      if (d.islands.some((i) => (i.flags & ISLAND_FLAG_SINGULAR) !== 0)) withSingular++;
      if (spec.wellConditioned) wellConditioned++;
      // The two LUs pivot differently: their bits should differ somewhere, or the comparison is idle.
      if (d.nodes.some((v, i) => !Object.is(v, s.nodes[i]))) differentBits++;
    }
    const share = (x: number) => x / specs.length;
    expect(unknowns / islands).toBeGreaterThanOrEqual(60);
    expect(sparseIslands / islands).toBeGreaterThanOrEqual(0.5);
    expect(share(withLoop)).toBeGreaterThanOrEqual(0.8);
    expect(share(multi)).toBeGreaterThanOrEqual(0.4);
    expect(share(withIsource)).toBeGreaterThanOrEqual(0.5);
    expect(share(withCurrentLimit)).toBeGreaterThanOrEqual(0.5);
    expect(share(withIdeal)).toBeGreaterThanOrEqual(0.3);
    expect(share(withSingular)).toBeLessThanOrEqual(0.25);
    expect(share(wellConditioned)).toBeGreaterThanOrEqual(0.3);
    expect(share(differentBits)).toBeGreaterThanOrEqual(0.5);
  });
});
