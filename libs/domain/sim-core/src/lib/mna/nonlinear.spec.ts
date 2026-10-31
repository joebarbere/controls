import fc from 'fast-check';
import {
  AC_SOURCE,
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
import { largeCircuit, type LargeCircuitSpec } from '../../testing/large-circuits';
import { syntheticNetlist } from '../../testing/mna';
import { checkRows, type Circuit, expectSameBits } from '../../testing/solver-checks';
import { OUTER_LOOP_MAX_ITERATIONS, OUTER_LOOP_MIN_DAMPING, OUTER_LOOP_RELTOL } from '../constants';
import { compileNetlist } from '../netlist/compile';
import type { Netlist } from '../netlist/types';
import { DcSolver, type DcIterationHook, type DcSolution, ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR } from './dc';
import { DC_STAMP_ISOURCE, DC_STAMP_VSOURCE, dcBranchValues, DcBranchValues } from './values';

/*
 * F2.2 part 3: the nonlinear outer loop (`DcSolver.solveNonlinear`). The device models it serves
 * (F2.4's CV/CC supply, F2.5's lamp R(T)) don't exist yet, so these use synthetic nonlinear elements
 * with known fixed points:
 *
 * - a resistance that rises with its own current, R(I) = R0 + k·|I| (a crude self-heating
 *   resistor). In one loop with an EMF E behind Rs: E = I (Rs + R0 + k I), so
 *   I* = (−(Rs + R0) + √((Rs + R0)² + 4 k E)) / (2 k) for E > 0. The undamped iteration's slope at
 *   the fixed point is −k I* / (Rs + R0 + k I*), which tends to −1 as k I* dominates: undamped, it
 *   oscillates and converges ever more slowly; the loop's damping must take over;
 * - a CV/CC supply: a `vsource` element at Vset behind Rint until its current reaches Ilim, then a
 *   current source of Ilim. Its fixed point is CV at I = Vset / (Rint + R) when that is below Ilim,
 *   else CC at Ilim (V = Ilim · R).
 */

const selfHeating =
  (branches: ReadonlySet<number>, r0: (b: number) => number, k: (b: number) => number): DcIterationHook =>
  (island, iterate, values) => {
    for (const b of island.branches) {
      if (!branches.has(b)) continue;
      const i = iterate === null ? 0 : Math.abs(iterate.branches[2 * b]);
      values.resistor(b, r0(b) + k(b) * i);
    }
  };

/** One loop: an EMF E behind Rs (branch 0) and the self-heating resistor (branch 1). */
function loop(e: number, rs: number): Circuit {
  const netlist = syntheticNetlist(2, [
    { a: 0, b: 1, kind: 'vsource' },
    { a: 1, b: 0, kind: 'resistor' },
  ]);
  const values = new DcBranchValues(2);
  values.vsource(0, e, rs);
  values.resistor(1, 1);
  return { netlist, values };
}

const fixedPoint = (e: number, rs: number, r0: number, k: number) => {
  const s = rs + r0;
  return (-s + Math.sqrt(s * s + 4 * k * e)) / (2 * k);
};

/** A CV/CC supply on `supply` (in `loop`): the mode follows the iterate (no hysteresis: F2.4 adds it). */
const cvcc =
  (supply: number, vset: number, rint: number, ilim: number): DcIterationHook =>
  (island, iterate, values) => {
    if (!island.branches.includes(supply)) return;
    if (iterate === null) {
      values.vsource(supply, vset, rint);
      return;
    }
    const current = iterate.branches[2 * supply];
    // The supply runs from node 0 (−) to node 1 (+) in `loop`.
    const volts = iterate.nodes[2] - iterate.nodes[0];
    if (current >= ilim && volts <= vset) values.isource(supply, ilim);
    else values.vsource(supply, vset, rint);
  };

describe('DcSolver.solveNonlinear', () => {
  it('reaches the closed-form fixed point of a self-heating resistor, dense and sparse', () => {
    for (const sparseMinUnknowns of [Number.MAX_SAFE_INTEGER, 1]) {
      for (const [e, rs, r0, k] of [
        [12, 0.05, 2.9, 60],
        [120, 1, 10, 5],
        [5, 0.5, 100, 1],
        [24, 0.01, 1, 400], // k I* ≫ Rs + R0: slope ≈ −0.99, damping needed
      ]) {
        const circuit = loop(e, rs);
        const solver = new DcSolver({ sparseMinUnknowns });
        const solution = solver.solveNonlinear(circuit.netlist, circuit.values, {
          hook: selfHeating(
            new Set([1]),
            () => r0,
            () => k,
          ),
        });
        const island = solution.islands[0];
        expect(island.flags).toBe(0);
        expect(island.iterations).toBeLessThanOrEqual(30);
        const expected = fixedPoint(e, rs, r0, k);
        // The source drives I from a to b inside the source, so the load carries it from node 1 to 0.
        expect(Math.abs(solution.branches[2] - expected)).toBeLessThanOrEqual(10 * OUTER_LOOP_RELTOL.value * expected);
        // The solution is a linear solve for the values the hook set last.
        checkRows(circuit, solution);
      }
    }
  });

  it('gives a linear island one solve, bit-identical to `solve`', () => {
    const circuit = largeCircuit({ nodes: 150, islands: 2, seed: 4, meshPercent: 15, wellConditioned: false });
    const plain = new DcSolver().solve(circuit.netlist, circuit.values);
    let calls = 0;
    const solution = new DcSolver().solveNonlinear(circuit.netlist, circuit.values, {
      hook: () => {
        calls++;
      },
    });
    expect(solution.islands.map((i) => i.iterations)).toStrictEqual(plain.islands.map((i) => i.iterations));
    expect(solution.islands.every((i) => i.iterations === 1 || !i.solved)).toBe(true);
    expectSameBits(solution, plain);
    // Two hook calls per island: the initial guess, then the check that nothing changed.
    expect(calls).toBe(2 * circuit.netlist.islands.length);
  });

  it('warm-starts from a previous solution: fewer iterations, the same fixed point', () => {
    const circuit = loop(12, 0.05);
    const hook = selfHeating(
      new Set([1]),
      () => 2.9,
      () => 60,
    );
    const solver = new DcSolver();
    const cold = solver.solveNonlinear(circuit.netlist, circuit.values, { hook });
    const seen: (DcSolution | null)[] = [];
    const warm = solver.solveNonlinear(circuit.netlist, circuit.values, {
      hook: (island, iterate, values) => {
        seen.push(iterate);
        hook(island, iterate, values);
      },
      warmStart: cold,
    });
    expect(seen.every((x) => x !== null)).toBe(true); // never a cold guess
    expect(warm.islands[0].iterations).toBeLessThan(cold.islands[0].iterations);
    expect(warm.islands[0].iterations).toBeLessThanOrEqual(2);
    expect(Math.abs(warm.branches[2] - cold.branches[2])).toBeLessThanOrEqual(
      10 * OUTER_LOOP_RELTOL.value * cold.branches[2],
    );
    // Warm start from itself as `out` too (the engine passes last tick's record).
    const again = solver.solveNonlinear(circuit.netlist, circuit.values, { hook, warmStart: warm }, warm);
    expect(again).toBe(warm);
    expect(again.islands[0].flags).toBe(0);
  });

  it('ignores a warm start of another topology, or an island it flagged singular', () => {
    const circuit = loop(12, 0.05);
    const hook = selfHeating(
      new Set([1]),
      () => 2.9,
      () => 60,
    );
    const solver = new DcSolver();
    const cold = solver.solveNonlinear(circuit.netlist, circuit.values, { hook });
    const stale = { ...cold, topologyHash: 'another' };
    const firstIterates: (DcSolution | null)[] = [];
    const recordFirst: DcIterationHook = (island, iterate, values) => {
      if (firstIterates.length === 0) firstIterates.push(iterate);
      hook(island, iterate, values);
    };
    const fromStale = solver.solveNonlinear(circuit.netlist, circuit.values, { hook: recordFirst, warmStart: stale });
    expect(firstIterates).toStrictEqual([null]);
    expect(fromStale.islands[0].iterations).toBe(cold.islands[0].iterations);
    const singular = { ...cold, islands: [{ ...cold.islands[0], flags: ISLAND_FLAG_SINGULAR }] };
    firstIterates.length = 0;
    solver.solveNonlinear(circuit.netlist, circuit.values, { hook: recordFirst, warmStart: singular });
    expect(firstIterates).toStrictEqual([null]);
    firstIterates.length = 0;
    solver.solveNonlinear(circuit.netlist, circuit.values, { hook: recordFirst, warmStart: null });
    expect(firstIterates).toStrictEqual([null]);
  });

  it('damps an oscillating iteration: undamped it would need hundreds of iterations', () => {
    // Slope −k I* / (Rs + R0 + k I*) ≈ −0.995: the undamped error shrinks by 0.5 % per iteration.
    const circuit = loop(48, 0.01);
    const solution = new DcSolver().solveNonlinear(circuit.netlist, circuit.values, {
      hook: selfHeating(
        new Set([1]),
        () => 0.5,
        () => 2000,
      ),
    });
    expect(solution.islands[0].flags).toBe(0);
    expect(solution.islands[0].iterations).toBeLessThanOrEqual(25);
    const expected = fixedPoint(48, 0.01, 0.5, 2000);
    expect(Math.abs(solution.branches[2] - expected)).toBeLessThanOrEqual(10 * OUTER_LOOP_RELTOL.value * expected);
    expect(OUTER_LOOP_MIN_DAMPING.value).toBe(1 / 16);
  });

  it('flags nonConverged at the iteration cap, with the rows of its last solve intact', () => {
    // A resistance that jumps across 1 A: 1 Ω below, 100 Ω above. From E = 10 V the iterate bounces
    // between 10 A and 0.1 A; damped, it hovers about 1 A, where no fixed point exists.
    const circuit = loop(10, 0);
    const hook: DcIterationHook = (island, iterate, values) => {
      const i = iterate === null ? 0 : Math.abs(iterate.branches[2]);
      values.resistor(1, i < 1 ? 1 : 100);
    };
    const solution = new DcSolver().solveNonlinear(circuit.netlist, circuit.values, { hook });
    expect(solution.islands[0].flags).toBe(ISLAND_FLAG_NON_CONVERGED);
    expect(solution.islands[0].iterations).toBe(OUTER_LOOP_MAX_ITERATIONS.value);
    checkRows(circuit, solution);
    const capped = new DcSolver().solveNonlinear(circuit.netlist, circuit.values, { hook, maxIterations: 3 });
    expect(capped.islands[0]).toMatchObject({ flags: ISLAND_FLAG_NON_CONVERGED, iterations: 3 });
    checkRows(circuit, capped);
    expect(() => new DcSolver().solveNonlinear(circuit.netlist, circuit.values, { hook, maxIterations: 0 })).toThrow(
      RangeError,
    );
    // A cap of 1 still lets a linear island converge (its one solve is a fixed point).
    const linear = new DcSolver().solveNonlinear(circuit.netlist, circuit.values, {
      hook: () => undefined,
      maxIterations: 1,
    });
    expect(linear.islands[0]).toMatchObject({ flags: 0, iterations: 1 });
  });

  it('settles a CV/CC supply in either mode, switching its stamp (and its sparse variant)', () => {
    const vset = 12;
    const rint = 0.01;
    const ilim = 1;
    for (const sparseMinUnknowns of [Number.MAX_SAFE_INTEGER, 1]) {
      const solver = new DcSolver({ sparseMinUnknowns });
      for (const load of [100, 20, 12.5, 11.9, 6, 0.5]) {
        const circuit = loop(vset, rint);
        circuit.values.resistor(1, load);
        const solution = solver.solveNonlinear(circuit.netlist, circuit.values, { hook: cvcc(0, vset, rint, ilim) });
        expect(solution.islands[0].flags, `load ${load}`).toBe(0);
        expect(solution.islands[0].iterations).toBeLessThanOrEqual(6);
        const cv = vset / (rint + load);
        if (cv < ilim) {
          expect(circuit.values.stamps[0]).toBe(DC_STAMP_VSOURCE);
          // gmin shifts the hand calculation by about gmin × R (1e-10 at 100 Ω, caveats).
          expect(Math.abs(solution.branches[0] - cv)).toBeLessThanOrEqual(1e-9 * cv);
        } else {
          expect(circuit.values.stamps[0]).toBe(DC_STAMP_ISOURCE);
          expect(solution.branches[0]).toBe(ilim);
          expect(solution.nodes[2]).toBeLessThanOrEqual(vset);
        }
        checkRows(circuit, solution);
      }
      if (sparseMinUnknowns === 1) {
        // Both modes' symbolic factorisations are cached for the one topology.
        expect(solver.cache.stats.misses).toBe(2);
        expect(solver.cache.stats.hits).toBeGreaterThan(4);
      }
    }
  });

  it('stops at a singular solve without flagging nonConverged, and leaves AC islands unsolved', () => {
    const shorted = syntheticNetlist(2, [
      { a: 0, b: 1, kind: 'vsource' },
      { a: 0, b: 1, kind: 'vsource' },
      { a: 1, b: 0, kind: 'resistor' },
    ]);
    const values = new DcBranchValues(3);
    values.vsource(0, 12, 0);
    values.vsource(1, 6, 0);
    values.resistor(2, 10);
    const solution = new DcSolver().solveNonlinear(shorted, values, {
      hook: selfHeating(
        new Set([2]),
        () => 10,
        () => 1,
      ),
    });
    expect(solution.islands[0]).toMatchObject({ flags: ISLAND_FLAG_SINGULAR, iterations: 1 });

    const bus = benchBus(TEST_CATALOG);
    for (const ref of [AC_SOURCE, LAMP, BATTERY, LAMP]) bus.exec('entity.place', { ref, positionMm: origin });
    for (const [a, b] of [
      [end(1, 'l'), end(2, 'a')],
      [end(2, 'b'), end(1, 'n')],
      [end(3, 'pos'), end(4, 'a')],
      [end(4, 'b'), end(3, 'neg')],
    ]) {
      bus.exec('lead.connect', { ref: LEAD, a, b });
    }
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    const lamps = dcBranchValues(netlist, (branch, v) => {
      if (branch.model !== 'lamp.incandescent') return false;
      v.resistor(branch.index, 28.8);
      return true;
    });
    const mixed = new DcSolver().solveNonlinear(netlist, lamps, { hook: () => undefined });
    expect(mixed.islands.map((i) => [i.solved, i.iterations])).toStrictEqual([
      [false, 0],
      [true, 1],
    ]);
  });
});

// Random bench worlds whose lamps self-heat: R(I) = R_cold · (1 + β |I| / 0.42 A), a synthetic
// stand-in for F2.5's R(T) (0.42 A is a 12 V 5 W lamp's rated current).
const BENCH_DEVICES = [BATTERY, LAMP, LAMP, SPST, SUPPLY];
const benchArb = fc.record({
  devices: fc.array(fc.nat({ max: BENCH_DEVICES.length - 1 }), { minLength: 2, maxLength: 8 }),
  leads: fc.array(fc.tuple(fc.nat({ max: 63 }), fc.nat({ max: 63 })), { minLength: 1, maxLength: 12 }),
  closed: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
  coldOhms: fc.array(fc.integer({ min: 5, max: 100 }), { minLength: 8, maxLength: 8 }),
  beta: fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 8, maxLength: 8 }),
});

type BenchDraw = typeof benchArb extends fc.Arbitrary<infer T> ? T : never;

function buildBench(draw: BenchDraw) {
  const bus = benchBus(TEST_CATALOG);
  const terminals: { entity: number; terminal: string }[] = [];
  draw.devices.forEach((d, i) => {
    const ref = BENCH_DEVICES[d];
    bus.exec('entity.place', { ref, positionMm: origin });
    for (const t of TEST_CATALOG.device(ref)?.terminals ?? []) terminals.push({ entity: i + 1, terminal: t.id });
    if (ref === SPST) bus.exec('device.operate', { id: i + 1, control: 'closed', value: draw.closed[i] });
  });
  const count = draw.devices.length;
  for (let i = 0; i < count; i++) {
    const from = TEST_CATALOG.device(BENCH_DEVICES[draw.devices[i]])?.terminals ?? [];
    const to = TEST_CATALOG.device(BENCH_DEVICES[draw.devices[(i + 1) % count]])?.terminals ?? [];
    bus.exec('lead.connect', {
      ref: LEAD,
      a: end(i + 1, from[from.length - 1].id),
      b: end(((i + 1) % count) + 1, to[0].id),
    });
  }
  for (const [x, y] of draw.leads) {
    const a = terminals[x % terminals.length];
    const b = terminals[(x + 1 + (y % (terminals.length - 1))) % terminals.length];
    bus.exec('lead.connect', { ref: LEAD, a: end(a.entity, a.terminal), b: end(b.entity, b.terminal) });
  }
  const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
  const lamps = new Set(netlist.branches.filter((b) => b.model === 'lamp.incandescent').map((b) => b.index));
  const entityOf = (b: number) => {
    const element = netlist.branches[b].element;
    return element.kind === 'entity' ? element.entity - 1 : 0;
  };
  const cold = (b: number) => draw.coldOhms[entityOf(b)] / 10;
  const hook = selfHeating(lamps, cold, (b) => (cold(b) * draw.beta[entityOf(b)]) / 0.42);
  const values = dcBranchValues(netlist, (branch, v) => {
    if (branch.model === 'lamp.incandescent') {
      v.resistor(branch.index, cold(branch.index));
      return true;
    }
    if (branch.model === 'test.supply') {
      v.vsource(branch.index, branch.values['setpointV'], 0.01);
      return true;
    }
    return false;
  });
  return { netlist, values, hook, lamps, cold, beta: (b: number) => draw.beta[entityOf(b)] };
}

/** The lamps' resistances agree with their currents: R_used ≈ R(I_final), at the loop's tolerance. */
function selfConsistent(
  netlist: Netlist,
  values: DcBranchValues,
  solution: DcSolution,
  lamps: ReadonlySet<number>,
  r: (b: number, i: number) => number,
): number {
  let worst = 0;
  for (const b of lamps) {
    if (!solution.islands[netlist.branches[b].island].solved) continue;
    const used = values.ohms[b];
    const want = r(b, Math.abs(solution.branches[2 * b]));
    worst = Math.max(worst, Math.abs(used - want) / want);
  }
  return worst;
}

/**
 * The properties' iteration bound, set from a measurement: over 1,500 fresh large circuits (about
 * 2,200 islands) no island failed to converge, the median took 16 iterations, the 99th percentile
 * about 21 and the most 26; a fresh seed in the flake runs took 32 (kept as an example). 40 leaves
 * room under the cap of 50 (`OUTER_LOOP_MAX_ITERATIONS`).
 */
const ITERATION_BOUND = 40;

const largeArb: fc.Arbitrary<LargeCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 60, max: 220 }),
  islands: fc.integer({ min: 1, max: 2 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 25 }),
  wellConditioned: fc.constant(true),
});
const nonlinearShare = fc.integer({ min: 2, max: 6 });
/** How much hotter than cold a heated element runs at its cold-solve current, as a lamp's 5–16×. */
const hotRatio = fc.integer({ min: 4, max: 15 });

describe('outer-loop properties', () => {
  it('converges within a bounded number of iterations on random bench worlds with self-heating lamps', () => {
    fc.assert(
      fc.property(benchArb, (draw) => {
        const bench = buildBench(draw);
        const solution = new DcSolver().solveNonlinear(bench.netlist, bench.values, { hook: bench.hook });
        for (const island of solution.islands) {
          if (!island.solved) continue;
          expect(island.flags & ISLAND_FLAG_NON_CONVERGED).toBe(0);
          expect(island.iterations).toBeLessThanOrEqual(ITERATION_BOUND);
        }
        checkRows(bench, solution);
        const r = (b: number, i: number) => bench.cold(b) * (1 + (bench.beta(b) * i) / 0.42);
        expect(selfConsistent(bench.netlist, bench.values, solution, bench.lamps, r)).toBeLessThanOrEqual(1e-4);
      }),
      { numRuns: 70 },
    );
  });

  it('converges within a bounded number of iterations on large circuits (sparse path), deterministically', () => {
    fc.assert(
      fc.property(largeArb, nonlinearShare, hotRatio, (spec, every, ratio) => {
        const circuit = largeCircuit(spec);
        // Each heated resistor's k makes it `ratio` × its cold resistance at its cold-solve current.
        const coldSolve = new DcSolver().solve(circuit.netlist, circuit.values);
        const heated = new Set(
          circuit.netlist.branches
            .filter(
              (b) =>
                b.kind === 'resistor' &&
                circuit.values.stamp(b.index) === 'resistor' &&
                b.index % every === 0 &&
                Math.abs(coldSolve.branches[2 * b.index]) > 1e-6,
            )
            .map((b) => b.index),
        );
        const r0 = new Map([...heated].map((b) => [b, circuit.values.ohms[b]]));
        const k = new Map(
          [...heated].map((b) => [b, ((ratio - 1) * circuit.values.ohms[b]) / Math.abs(coldSolve.branches[2 * b])]),
        );
        const hook = selfHeating(
          heated,
          (b) => r0.get(b) ?? 1,
          (b) => k.get(b) ?? 0,
        );
        const values = new DcBranchValues(circuit.values.count);
        const copy = () => {
          values.stamps.set(circuit.values.stamps);
          values.ohms.set(circuit.values.ohms);
          values.emfV.set(circuit.values.emfV);
          values.amps.set(circuit.values.amps);
          return values;
        };
        const solver = new DcSolver();
        const solution = solver.solveNonlinear(circuit.netlist, copy(), { hook });
        for (const island of solution.islands) {
          if (!island.solved || (island.flags & ISLAND_FLAG_SINGULAR) !== 0) continue;
          expect(island.flags & ISLAND_FLAG_NON_CONVERGED).toBe(0);
          expect(island.iterations).toBeLessThanOrEqual(ITERATION_BOUND);
        }
        checkRows({ netlist: circuit.netlist, values }, solution);
        // Bit-identical on another solver (cold cache, fresh LU state).
        const again = new DcSolver().solveNonlinear(circuit.netlist, copy(), { hook });
        expectSameBits(again, solution);
      }),
      {
        numRuns: 15,
        examples: [
          // Ran to nonConverged on rounding noise before the current tolerance took the solve's resolution.
          [{ nodes: 177, islands: 1, seed: 11, meshPercent: 3, wellConditioned: true }, 2, 13],
          // Took 32 iterations: the tail of the distribution (see ITERATION_BOUND).
          [{ nodes: 62, islands: 2, seed: 867437101, meshPercent: 7, wellConditioned: true }, 2, 4],
        ],
      },
    );
  });
});

describe('generator health (outer-loop properties are not vacuous)', () => {
  it('bench worlds have self-heating lamps carrying current, needing several iterations', () => {
    const draws = fc.sample(benchArb, { seed: 20261030, numRuns: 100 });
    let heated = 0;
    let iterating = 0;
    let maxIterations = 0;
    for (const draw of draws) {
      const bench = buildBench(draw);
      const solution = new DcSolver().solveNonlinear(bench.netlist, bench.values, { hook: bench.hook });
      const flowing = [...bench.lamps].some((b) => bench.beta(b) > 0 && Math.abs(solution.branches[2 * b]) > 1e-3);
      if (flowing) heated++;
      const most = Math.max(0, ...solution.islands.map((i: { iterations: number }) => i.iterations));
      if (most >= 4) iterating++;
      maxIterations = Math.max(maxIterations, most);
    }
    expect(heated / draws.length).toBeGreaterThanOrEqual(0.4);
    expect(iterating / draws.length).toBeGreaterThanOrEqual(0.3);
    // Some draws are hard: the damping is exercised, yet stays inside the bound.
    expect(maxIterations).toBeGreaterThanOrEqual(10);
  });
});
