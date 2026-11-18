import fc from 'fast-check';
import { type AcCircuit, checkAcRows } from '../../testing/ac';
import { type AcCircuitDraw, type AcElementDraw, buildAcCircuit } from '../../testing/ac-circuits';
import { syntheticNetlist } from '../../testing/mna';
import { AcSolver, solveAc } from './ac';
import { AC_STAMP_VSOURCE, AcBranchValues } from './ac-values';
import { FactorisationCache } from './factorisation-cache';
import type { ComplexSparseFactors } from '../lu/complex-sparse-lu';

/*
 * Engine 8 (D4, ADR 0021): coupled source pairs, the split-phase T-equivalent's neutral arm eliminated
 * into a 2 × 2 source-impedance block. Properties over random phasor circuits whose sources are paired
 * and coupled with a mutual impedance of either sign (|R_m| below both selves, so the real block is
 * positive definite):
 *
 * - every equation holds on the dense path and, forced sparse, on the sparse path (complex KCL, the
 *   coupled source rows Vb − Va + Z I + Z_m I_p = E, the element laws, real and reactive power with
 *   the block's share);
 * - dense and sparse agree on which islands are singular, and a cached factorisation is never reused
 *   across a coupling change (the coupled class is in the cache key);
 * - a pairing that isn't symmetric, or whose real block isn't positive definite, is refused (a model
 *   error), never solved.
 */

const MAX_NODES = 12;

const elementArb: fc.Arbitrary<AcElementDraw> = fc.record({
  kind: fc.nat({ max: 10 }),
  mantissa: fc.nat({ max: 8999 }),
  decade: fc.nat({ max: 8 }),
  sourceRe: fc.integer({ min: -4800, max: 4800 }),
  sourceIm: fc.integer({ min: -4800, max: 4800 }),
  angle: fc.nat({ max: 4 }),
  ideal: fc.nat({ max: 5 }),
});
const circuitArb: fc.Arbitrary<AcCircuitDraw> = fc.record({
  nodes: fc.integer({ min: 2, max: MAX_NODES }),
  islands: fc.integer({ min: 1, max: 2 }),
  tree: fc.array(fc.tuple(fc.nat({ max: 1000 }), elementArb), { minLength: MAX_NODES, maxLength: MAX_NODES }),
  extra: fc.array(fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), elementArb), { minLength: 2, maxLength: 12 }),
});
/** The mutual R as a signed fraction of the smaller self R (|f| < 1), and the mutual L likewise. */
const couplingArb = fc.array(fc.tuple(fc.integer({ min: -95, max: 95 }), fc.integer({ min: -150, max: 150 })), {
  minLength: 8,
  maxLength: 8,
});

/**
 * Couples consecutive non-ideal sources of each island in pairs (as a split-phase source's two
 * windings are), with R_m = f · min(R_a, R_b) and L_m = g · max(L_a, L_b, 1 µH). Returns how many pairs.
 */
function couple(circuit: AcCircuit, draws: readonly (readonly [number, number])[]): number {
  const { netlist, values } = circuit;
  let pairs = 0;
  for (const island of netlist.islands) {
    const sources = island.branches.filter((b) => values.stamps[b] === AC_STAMP_VSOURCE && values.ohms[b] > 0);
    for (let k = 0; k + 1 < sources.length; k += 2) {
      const [a, b] = [sources[k], sources[k + 1]];
      const [f, g] = draws[pairs % draws.length];
      const rm = (f / 100) * Math.min(values.ohms[a], values.ohms[b]);
      const lm = (g / 100) * Math.max(values.seriesHenries[a], values.seriesHenries[b], 1e-6);
      values.couple(a, b, rm, lm);
      values.couple(b, a, rm, lm);
      pairs++;
    }
  }
  return pairs;
}

describe('coupled source pairs (engine 8, the split-phase T-equivalent)', () => {
  it('every equation holds with the mutual impedance, dense and forced sparse; both agree on singular islands', () => {
    let coupled = 0;
    fc.assert(
      fc.property(circuitArb, couplingArb, (draw, draws) => {
        const circuit = buildAcCircuit({ ...draw, sourceInductance: true });
        coupled += couple(circuit, draws);
        const dense = solveAc(circuit.netlist, circuit.values, circuit.frequencyHz);
        checkAcRows(circuit, dense, true);
        const sparse = new AcSolver({ sparseMinUnknowns: 1 }).solve(circuit.netlist, circuit.values, 60);
        expect(sparse.islands.map((i) => i.flags)).toStrictEqual(dense.islands.map((i) => i.flags));
        checkAcRows(circuit, sparse, true);
      }),
      { numRuns: 120 },
    );
    // Generator health: the property isn't vacuous.
    expect(coupled).toBeGreaterThan(60);
  });

  it('a coupled pair of one winding each is the T: Z_LN on a lone fault, Z_full on a line-to-line one', () => {
    // Two sources from node 0 (x0) to nodes 1 (L1) and 2 (L2), 120 V at 0° and 180°, each with
    // Z_self = R_s + jX_s and the mutual Z_m (the eliminated neutral arm): a resistor of 1 µΩ from L1
    // to x0 draws 120 / |Z_self + 1 µΩ|; one from L1 to L2 draws 240 / |2 (Z_self − Z_m) + 1 µΩ|.
    const omega = 2 * Math.PI * 60;
    const [rs, xs, rm, xm] = [0.0077278509, 0.0123645615, -0.0025759503, -0.008243041];
    const fault = (b: number) => {
      const netlist = syntheticNetlist(
        3,
        [
          { a: 0, b: 1, kind: 'vsource' },
          { a: 0, b: 2, kind: 'vsource' },
          { a: 1, b, kind: 'resistor' },
        ],
        'ac',
      );
      const values = new AcBranchValues(3);
      values.vsourcePolar(0, 120, 0, rs, xs / omega);
      values.vsourcePolar(1, 120, 180, rs, xs / omega);
      values.couple(0, 1, rm, xm / omega);
      values.couple(1, 0, rm, xm / omega);
      values.resistor(2, 1e-6);
      const s = solveAc(netlist, values, 60);
      checkAcRows({ netlist, values, frequencyHz: 60 }, s, true);
      return Math.hypot(s.branches[4], s.branches[5]);
    };
    expect(Math.abs(fault(0) / (120 / Math.hypot(rs + 1e-6, xs)) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(fault(0) / 8229.96 - 1)).toBeLessThan(1e-4);
    expect(Math.abs(fault(2) / (240 / Math.hypot(2 * (rs - rm) + 1e-6, 2 * (xs - xm))) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(fault(2) / 5208.33 - 1)).toBeLessThan(1e-4);
  });

  it('keeps coupled and uncoupled variants of one topology apart in the factorisation cache', () => {
    const cache = new FactorisationCache<ComplexSparseFactors>();
    const solver = new AcSolver({ sparseMinUnknowns: 1, cache });
    const netlist = syntheticNetlist(
      3,
      [
        { a: 0, b: 1, kind: 'vsource' },
        { a: 0, b: 2, kind: 'vsource' },
        { a: 1, b: 2, kind: 'resistor' },
      ],
      'ac',
    );
    const values = (coupled: boolean) => {
      const v = new AcBranchValues(3);
      v.vsource(0, 120, 0, 0.01, 1e-5);
      v.vsource(1, -120, 0, 0.01, 1e-5);
      if (coupled) {
        v.couple(0, 1, -0.003, -2e-5);
        v.couple(1, 0, -0.003, -2e-5);
      }
      v.resistor(2, 10);
      return v;
    };
    const plain = solver.solve(netlist, values(false), 60).branches.slice();
    const coupled = solver.solve(netlist, values(true), 60).branches.slice();
    expect(cache.stats.misses).toBe(2);
    expect(coupled).not.toStrictEqual(plain);
    // Each again from the cache, bit for bit as the fresh dense solve.
    expect(solver.solve(netlist, values(true), 60).branches).toStrictEqual(Float64Array.from(coupled));
    expect(cache.stats.hits).toBe(1);
    const dense = solveAc(netlist, values(true), 60);
    for (let i = 0; i < coupled.length; i++) expect(Math.abs(coupled[i] - dense.branches[i])).toBeLessThan(1e-9);
  });

  it("never reuses a cached factorisation for another pairing of one topology's sources", () => {
    // Four sources paired (0, 1) and (2, 3), then (0, 2) and (1, 3), under one topologyHash: the same
    // class signature (all coupled), so the partners are folded into the cached checksum and the second
    // pairing is refused, never solved on the first's pattern (a pairing is a function of the topology
    // for every real device model, so a mismatch is a stale or reused hash).
    const solver = new AcSolver({ sparseMinUnknowns: 1 });
    const netlist = syntheticNetlist(
      3,
      [
        { a: 0, b: 1, kind: 'vsource' },
        { a: 0, b: 2, kind: 'vsource' },
        { a: 0, b: 1, kind: 'vsource' },
        { a: 0, b: 2, kind: 'vsource' },
        { a: 1, b: 2, kind: 'resistor' },
      ],
      'ac',
    );
    const values = (pairs: readonly (readonly [number, number])[]) => {
      const v = new AcBranchValues(5);
      for (let k = 0; k < 4; k++) v.vsource(k, k % 2 === 0 ? 120 : -120, 0, 0.01, 1e-5);
      for (const [x, y] of pairs) {
        v.couple(x, y, -0.003, 0);
        v.couple(y, x, -0.003, 0);
      }
      v.resistor(4, 10);
      return v;
    };
    solver.solve(
      netlist,
      values([
        [0, 1],
        [2, 3],
      ]),
      60,
    );
    expect(() =>
      solver.solve(
        netlist,
        values([
          [0, 2],
          [1, 3],
        ]),
        60,
      ),
    ).toThrow(/source couplings differ/);
    expect(() =>
      solver.solve(
        netlist,
        values([
          [0, 1],
          [2, 3],
        ]),
        60,
      ),
    ).not.toThrow();
  });

  it('refuses a one-sided or asymmetric pairing and a real block that is not positive definite', () => {
    const netlist = syntheticNetlist(
      3,
      [
        { a: 0, b: 1, kind: 'vsource' },
        { a: 0, b: 2, kind: 'vsource' },
        { a: 1, b: 2, kind: 'resistor' },
      ],
      'ac',
    );
    const make = (m0: number, m1: number | null) => {
      const v = new AcBranchValues(3);
      v.vsource(0, 120, 0, 0.01);
      v.vsource(1, -120, 0, 0.01);
      v.couple(0, 1, m0, 0);
      if (m1 !== null) v.couple(1, 0, m1, 0);
      v.resistor(2, 10);
      return v;
    };
    expect(() => solveAc(netlist, make(-0.005, null), 60)).toThrow(/isn't a symmetric pair/);
    expect(() => solveAc(netlist, make(-0.005, -0.004), 60)).toThrow(/isn't a symmetric pair/);
    expect(() => solveAc(netlist, make(-0.01, -0.01), 60)).toThrow(/positive definite/);
    expect(() => solveAc(netlist, make(-0.005, -0.005), 60)).not.toThrow();
    const v = new AcBranchValues(3);
    expect(() => v.couple(0, 0, 0, 0)).toThrow(RangeError);
    expect(() => v.couple(0, 3, 0, 0)).toThrow(RangeError);
    expect(() => v.couple(0, 1, Number.NaN, 0)).toThrow(RangeError);
    v.couple(0, 1, 1, 1);
    v.clear();
    expect(v.partner[0]).toBe(-1);
  });
});
