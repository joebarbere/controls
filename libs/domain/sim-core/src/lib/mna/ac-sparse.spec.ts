import fc from 'fast-check';
import { sha256 } from '@controls/world-model';
import { type AcCircuit, cabs, checkAcRows, isAcSingular, phasorI, phasorV } from '../../testing/ac';
import { acGoldens } from '../../testing/ac-goldens';
import { largeAcCircuit, type LargeAcCircuitSpec } from '../../testing/ac-circuits';
import { islandUnknowns } from '../../testing/large-circuits';
import { expectSameBits } from '../../testing/solver-checks';
import { GMIN_S, SPARSE_MIN_UNKNOWNS } from '../constants';
import type { ComplexSparseFactors } from '../lu/complex-sparse-lu';
import type { Netlist } from '../netlist/types';
import { AcSolver } from './ac';
import { AcBranchValues } from './ac-values';
import type { DcSolution } from './dc';
import { FactorisationCache } from './factorisation-cache';

/*
 * F2.2 part 2: the phasor solver's sparse path (complex Gilbert–Peierls LU in AMD order), its
 * factorisation cache and dense/sparse agreement, under the plan's floor policy with complex
 * magnitudes:
 *
 * - residuals on every circuit: each path's solution passes KCL, the source rows and every element law;
 * - values on the well-conditioned subset only (a resistive 1 Ω–10 kΩ spanning tree, impedances of
 *   1 Ω–10 kΩ, sources behind ≥ 0.1 Ω), where the forward error is small;
 * - a cached factorisation is never reused across a frequency or a value change: warm equals cold,
 *   bit for bit.
 */

const dense = () => new AcSolver({ sparseMinUnknowns: Number.MAX_SAFE_INTEGER });
const sparse = (cache?: FactorisationCache<ComplexSparseFactors>) => new AcSolver({ sparseMinUnknowns: 1, cache });
const solveWith = (solver: AcSolver, c: AcCircuit, frequencyHz = c.frequencyHz) =>
  solver.solve(c.netlist, c.values, frequencyHz);

const AGREEMENT = 1e-9;
const EPS = Number.EPSILON;

/**
 * The worst ratio of a dense/sparse difference to its bound (≤ 1 agrees), with complex magnitudes:
 * voltages within 1e-9 of the island's largest |V|; currents within 1e-9 of its largest |I| plus the
 * ε · |y|max · |V|max current floor.
 */
function worstDisagreement(circuit: AcCircuit, a: DcSolution, b: DcSolution): number {
  let worst = 0;
  const omega = 2 * Math.PI * circuit.frequencyHz;
  for (const island of circuit.netlist.islands) {
    if (island.kind !== 'ac' || isAcSingular(a, island.index)) continue;
    let vScale = 0;
    let iScale = 0;
    let yMax = GMIN_S.value;
    for (const node of island.nodes) vScale = Math.max(vScale, cabs(phasorV(a, node)));
    for (const br of island.branches) {
      iScale = Math.max(iScale, cabs(phasorI(a, br)));
      const v = circuit.values;
      const y = [
        0,
        1 / v.ohms[br],
        1 / (omega * v.henries[br]),
        omega * v.farads[br],
        v.ohms[br] > 0 ? 1 / v.ohms[br] : 0,
      ][v.stamps[br]];
      yMax = Math.max(yMax, y);
    }
    for (const node of island.nodes) {
      const d = cabs([a.nodes[2 * node] - b.nodes[2 * node], a.nodes[2 * node + 1] - b.nodes[2 * node + 1]]);
      worst = Math.max(worst, d / (AGREEMENT * vScale + 1e-15));
    }
    const currentFloor = 2 * 16 * EPS * yMax * vScale + 1e-15;
    for (const br of island.branches) {
      const d = cabs([a.branches[2 * br] - b.branches[2 * br], a.branches[2 * br + 1] - b.branches[2 * br + 1]]);
      worst = Math.max(worst, d / (AGREEMENT * iScale + currentFloor));
    }
  }
  return worst;
}

const largeArb: fc.Arbitrary<LargeAcCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 40, max: 260 }),
  islands: fc.integer({ min: 1, max: 3 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.boolean(),
});
const wellConditionedArb: fc.Arbitrary<LargeAcCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 40, max: 260 }),
  islands: fc.integer({ min: 1, max: 3 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.constant(true),
});
const smallArb: fc.Arbitrary<LargeAcCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 2, max: 24 }),
  islands: fc.integer({ min: 1, max: 4 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.boolean(),
});
/** Mid-sized circuits for the specs that solve several of them many times. */
const midArb: fc.Arbitrary<LargeAcCircuitSpec> = fc.record({
  nodes: fc.integer({ min: 40, max: 160 }),
  islands: fc.integer({ min: 1, max: 3 }),
  seed: fc.integer(),
  meshPercent: fc.integer({ min: 0, max: 30 }),
  wellConditioned: fc.boolean(),
});
const frequencyArb = fc.constantFrom(50, 400);
/** A value change: every impedance and EMF scaled by a factor near 1 (not a power of two). */
const nudgeArb = fc.integer({ min: 1, max: 999 });

/** A copy of `values` with every R, L, C and EMF scaled by (1 + nudge / 1000). */
function nudged(values: AcBranchValues, nudge: number): AcBranchValues {
  const f = 1 + nudge / 1000;
  const out = new AcBranchValues(values.count);
  out.stamps.set(values.stamps);
  for (let b = 0; b < values.count; b++) {
    out.ohms[b] = values.ohms[b] * f;
    out.henries[b] = values.henries[b] * f;
    out.farads[b] = values.farads[b] * f;
    out.emfRe[b] = values.emfRe[b] * f;
    out.emfIm[b] = values.emfIm[b] / f;
  }
  return out;
}

/** Whether any island reached a numeric factorisation (a singular one is decided structurally first). */
const factored = (s: DcSolution) => s.islands.some((island, i) => island.solved && !isAcSingular(s, i));

describe('AcSolver sparse path', () => {
  it('validates sparseMinUnknowns and defaults it to SPARSE_MIN_UNKNOWNS', () => {
    expect(new AcSolver().sparseMinUnknowns).toBe(SPARSE_MIN_UNKNOWNS.value);
    expect(() => new AcSolver({ sparseMinUnknowns: 0 })).toThrow(RangeError);
    expect(() => new AcSolver({ sparseMinUnknowns: 1.5 })).toThrow(RangeError);
  });

  it('agrees with dense LU on large random circuits in residual space: both pass every row', () => {
    fc.assert(
      fc.property(largeArb, (spec) => {
        const circuit = largeAcCircuit(spec);
        const d = solveWith(dense(), circuit);
        const s = solveWith(sparse(), circuit);
        expect(s.islands.map((i) => i.flags)).toStrictEqual(d.islands.map((i) => i.flags));
        expect(s.islands.map((i) => i.unknowns)).toStrictEqual(d.islands.map((i) => i.unknowns));
        checkAcRows(circuit, d);
        checkAcRows(circuit, s, true);
      }),
      { numRuns: 3 },
    );
  });

  it('agrees with dense LU on values, on large well-conditioned circuits', () => {
    fc.assert(
      fc.property(wellConditionedArb, (spec) => {
        const circuit = largeAcCircuit(spec);
        const d = solveWith(dense(), circuit);
        const s = solveWith(sparse(), circuit);
        expect(s.islands.map((i) => i.flags)).toStrictEqual(d.islands.map((i) => i.flags));
        expect(worstDisagreement(circuit, d, s)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 8 },
    );
  });

  it('agrees with dense LU on small circuits forced sparse (self-loops, tiny islands, ideal sources)', () => {
    fc.assert(
      fc.property(smallArb, (spec) => {
        const circuit = largeAcCircuit(spec);
        const d = solveWith(dense(), circuit);
        const s = solveWith(sparse(), circuit);
        expect(s.islands.map((i) => i.flags)).toStrictEqual(d.islands.map((i) => i.flags));
        checkAcRows(circuit, s, true);
        if (spec.wellConditioned) expect(worstDisagreement(circuit, d, s)).toBeLessThanOrEqual(1);
      }),
      {
        numRuns: 150,
        // Fresh seed: a gmin-only tree island behind a 4 mΩ source, 1.07× a floor without the source's own term.
        examples: [[{ nodes: 18, islands: 3, seed: 581405472, meshPercent: 0, wellConditioned: false }]],
      },
    );
  });

  it('passes every AC golden on a sparse solver whose cache already holds them', () => {
    const solver = sparse();
    for (const round of [0, 1]) {
      for (const golden of acGoldens()) {
        const solution = solveWith(solver, golden);
        expectSameBits(solution, solveWith(sparse(), golden));
        checkAcRows(golden, solution, true);
      }
      if (round === 1) expect(solver.cache.stats.hits).toBeGreaterThanOrEqual(acGoldens().length);
    }
  });

  it('is bit-identical cold, warm, shared and thrashed (capacity 1), across solver instances', () => {
    fc.assert(
      fc.property(fc.array(midArb, { minLength: 2, maxLength: 3 }), (specs) => {
        const circuits = specs.map((spec) => largeAcCircuit(spec));
        const expected = circuits.map((c) => solveWith(sparse(), c));
        const shared = new FactorisationCache<ComplexSparseFactors>(1);
        const thrashed = sparse(shared);
        const other = sparse(shared);
        const warm = sparse();
        for (const round of [0, 1]) {
          circuits.forEach((c, i) => {
            expectSameBits(solveWith(thrashed, c), expected[i]);
            expectSameBits(solveWith(other, c), expected[i]);
            expectSameBits(solveWith(warm, c), expected[i]);
            if (round === 1) expect(warm.cache.has(c.netlist.topologyHash)).toBe(factored(expected[i]));
          });
        }
      }),
      { numRuns: 3 },
    );
  });

  it('never reuses a cached factorisation across a frequency or a value change: warm equals cold', () => {
    fc.assert(
      fc.property(largeArb, frequencyArb, nudgeArb, (spec, hz, nudge) => {
        const circuit = largeAcCircuit(spec);
        const changed = { ...circuit, values: nudged(circuit.values, nudge) };
        const warm = sparse();
        solveWith(warm, circuit);
        // Same topology, another frequency: every reactive admittance moves.
        expectSameBits(solveWith(warm, circuit, hz), solveWith(sparse(), circuit, hz));
        // Same topology and frequency, other values.
        expectSameBits(solveWith(warm, changed), solveWith(sparse(), changed));
        // And back.
        expectSameBits(solveWith(warm, circuit), solveWith(sparse(), circuit));
        if (factored(solveWith(sparse(), circuit))) {
          expect(warm.cache.stats.hits).toBeGreaterThan(0);
          expect(warm.sparse.replays + warm.sparse.fallbacks).toBeGreaterThan(0);
        }
      }),
      { numRuns: 6 },
    );
  });

  it('refuses a cached factorisation whose topologyHash another netlist reuses (the tripwire)', () => {
    const circuit = largeAcCircuit({ nodes: 80, islands: 1, seed: 7, meshPercent: 20, wellConditioned: true });
    const solver = sparse();
    solveWith(solver, circuit);
    // The same hash on a netlist with one branch's ends moved: refused, not misapplied.
    const moved = circuit.netlist.branches.findIndex((b) => b.kind === 'resistor' && b.a !== b.b);
    const branches = circuit.netlist.branches.map((b, i) => (i === moved ? { ...b, a: b.b, b: b.a === 0 ? 1 : 0 } : b));
    const forged: Netlist = { ...circuit.netlist, branches };
    expect(() => solver.solve(forged, circuit.values, 60)).toThrow(/branch ends differ/);
    // The same hash with one more node in the island: its unknown count differs from the cached one.
    const extra = circuit.netlist.nodes.length;
    const grown: Netlist = {
      ...circuit.netlist,
      nodes: [...circuit.netlist.nodes, { index: extra, island: 0, members: [{ entity: extra + 1, terminal: 't' }] }],
      islands: circuit.netlist.islands.map((island) =>
        island.index === 0 ? { ...island, nodes: [...island.nodes, extra] } : island,
      ),
    };
    expect(() => solver.solve(grown, circuit.values, 60)).toThrow(/unknowns but its cached/);
  });

  it('hits the cache on returning to a topology, at the default threshold', () => {
    const big = largeAcCircuit({ nodes: 200, islands: 2, seed: 11, meshPercent: 15, wellConditioned: false });
    const other = largeAcCircuit({ nodes: 180, islands: 1, seed: 12, meshPercent: 10, wellConditioned: false });
    const sparseIslands = islandUnknowns(big.netlist).filter((u) => u >= SPARSE_MIN_UNKNOWNS.value).length;
    expect(sparseIslands).toBeGreaterThan(0);
    const solver = new AcSolver();
    const first = solveWith(solver, big);
    const missesAfterFirst = solver.cache.stats.misses;
    solveWith(solver, other);
    const again = solveWith(solver, big);
    expect(solver.cache.stats.hits).toBeGreaterThanOrEqual(sparseIslands);
    expect(solver.cache.stats.misses).toBeGreaterThanOrEqual(missesAfterFirst);
    expectSameBits(again, first);
    checkAcRows(big, again, true);
  });

  it('pins the bits of seeded large sparse solves (a numeric change re-pins this and bumps SIM_ENGINE_VERSION)', () => {
    const solver = new AcSolver();
    const chunks: Uint8Array[] = [];
    let sparseSolved = 0;
    for (const spec of fc.sample(largeArb, { seed: 20261031, numRuns: 40 })) {
      const circuit = largeAcCircuit(spec);
      const s = solveWith(solver, circuit);
      sparseSolved += islandUnknowns(circuit.netlist).filter((u) => u >= SPARSE_MIN_UNKNOWNS.value).length;
      const islands = s.islands.flatMap((i) => [i.solved ? 1 : 0, i.referenceNode, i.unknowns, i.flags, i.iterations]);
      chunks.push(new Uint8Array(Float64Array.from([...s.nodes, ...s.branches, ...islands]).buffer));
    }
    expect(sparseSolved).toBeGreaterThanOrEqual(40);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const hex = Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
    // Re-pinned in #51 when the generator's non-ideal sources were clamped to ≥ 1e-4 Ω: the circuits
    // changed, not the solver (no solver source changed), so SIM_ENGINE_VERSION stays 1. Was 21f6f74e….
    expect(hex).toBe('5d5a025759ade42c87062141ca0c27eee2dc87412a7dffceff99705086cefe06');
  });
});
