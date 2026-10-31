import fc from 'fast-check';
import { sha256 } from '@controls/world-model';
import { AC_SOURCE, BATTERY, benchBus, end, LAMP, LEAD, origin, TEST_CATALOG, TEST_MODELS } from '../../testing/bench';
import {
  acFloorShares,
  acLinearResidual,
  type AcCircuit,
  type AcCombined,
  checkAcRows,
  isAcSingular,
  type Phasor,
} from '../../testing/ac';
import { type AcCircuitDraw, type AcElementDraw, buildAcCircuit } from '../../testing/ac-circuits';
import { quantile } from '../../testing/mna';
import { expectSameBits } from '../../testing/solver-checks';
import { compileNetlist } from '../netlist/compile';
import type { Netlist } from '../netlist/types';
import { AcSolver, solveAc } from './ac';
import { AC_STAMP_CAPACITOR, AC_STAMP_INDUCTOR, AC_STAMP_VSOURCE, acBranchValues, AcBranchValues } from './ac-values';
import { createDcSolution, DcSolver, type DcSolution, ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR } from './dc';
import { SIN_120 } from './phasor';
import { dcBranchValues } from './values';

/*
 * Plan F2.2 part 2 properties of the phasor solver over random linear AC circuits, under the plan's
 * F2.2 floor policy with complex magnitudes (`src/testing/ac.ts`):
 *
 * - complex KCL at every node, every source row and every element's law hold;
 * - real power balances (the sources deliver what the resistances and gmin dissipate), and so does
 *   reactive power (what the sources deliver is Σ ωL |I|² − Σ |I|² / (ωC)), each within 1e-9 of its
 *   terms plus the Tellegen floor;
 * - linearity, bit for bit, for k = 0, ± a power of two, and ± j times one (a quarter turn swaps and
 *   negates parts, exactly); for other k (a rounding factor, the exact 120° rotation) and for
 *   superposition, in residual space;
 * - singular exactly for a loop of ideal sources; finite, never −0; bit-identical across solvers, a
 *   dirty `out` and other frequencies solved in between; and the bits of 300 seeded solves pinned.
 *
 * Arbitraries are built once at module level, never inside `.chain`; the generator-health test pins
 * floors on what the circuits contain.
 */

const MAX_NODES = 14;
const MAX_EXTRA = 14;

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
  islands: fc.integer({ min: 1, max: 3 }),
  tree: fc.array(fc.tuple(fc.nat({ max: 1000 }), elementArb), { minLength: MAX_NODES, maxLength: MAX_NODES }),
  // At least two extras: AC has no current source to drive a loop-free tree, so loops come from these.
  extra: fc.array(fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), elementArb), {
    minLength: 2,
    maxLength: MAX_EXTRA,
  }),
});
const maskArb = fc.array(fc.boolean(), { minLength: 32, maxLength: 32 });

/** Complex factors whose product is exact: 0, ± powers of two, and ± j times them. */
const EXACT_FACTORS: readonly Phasor[] = [
  [0, 0],
  [-4, 0],
  [0.5, 0],
  [2, 0],
  [1024, 0],
  [0, 1],
  [0, -2],
  [0, 0.25],
];
/** Factors that round: residual space. The exact 120° rotation is irrational in binary. */
const ROUNDING_FACTORS: readonly Phasor[] = [
  [-3, 0],
  [2.5, 0],
  [1e3, 0],
  [-0.5, SIN_120],
  [1, 1],
];
const factorArb = fc.constantFrom(...EXACT_FACTORS, ...ROUNDING_FACTORS);

const build = (draw: AcCircuitDraw, frequencyHz = 60) => buildAcCircuit(draw, frequencyHz);
const solve = (circuit: AcCircuit) => solveAc(circuit.netlist, circuit.values, circuit.frequencyHz);

/** A copy of `values` with each source's EMF multiplied by `k` where `keep(branch)`, and zeroed elsewhere. */
function scaledSources(values: AcBranchValues, k: Phasor, keep: (branch: number) => boolean): AcBranchValues {
  const out = new AcBranchValues(values.count);
  out.stamps.set(values.stamps);
  out.ohms.set(values.ohms);
  out.henries.set(values.henries);
  out.farads.set(values.farads);
  out.seriesHenries.set(values.seriesHenries);
  for (let b = 0; b < values.count; b++) {
    if (!keep(b)) continue;
    const [er, ei] = [values.emfRe[b], values.emfIm[b]];
    out.emfRe[b] = k[0] * er - k[1] * ei;
    out.emfIm[b] = k[0] * ei + k[1] * er;
  }
  return out;
}

/** k · z exactly as the scaled sources compute it, for the bit-exact factors. */
const times = (k: Phasor, re: number, im: number): Phasor => [k[0] * re - k[1] * im, k[0] * im + k[1] * re];

/** A solution full of sentinels, as a reused `out` might be: every AC field must be overwritten. */
function dirtySolution(netlist: Netlist): DcSolution {
  const out = createDcSolution(netlist);
  const sentinels = [NaN, -0, 7];
  out.nodes.forEach((_, i) => (out.nodes[i] = sentinels[i % 3]));
  out.branches.forEach((_, i) => (out.branches[i] = sentinels[(i + 1) % 3]));
  out.topologyHash = 'stale';
  for (const record of out.islands) {
    Object.assign(record, { solved: false, referenceNode: 99, unknowns: 99, flags: 255, iterations: 99 });
  }
  return out;
}

/** Only the `ac` islands' entries and records of a solution (others are left as they were). */
function acPart(netlist: Netlist, s: DcSolution): unknown {
  return netlist.islands
    .filter((island) => island.kind === 'ac')
    .map((island) => ({
      record: s.islands[island.index],
      nodes: island.nodes.flatMap((n) => [s.nodes[2 * n], s.nodes[2 * n + 1]]),
      branches: island.branches.flatMap((b) => [s.branches[2 * b], s.branches[2 * b + 1]]),
    }));
}

/** A zero element: the examples' filler. */
const Z: AcElementDraw = { kind: 0, mantissa: 0, decade: 0, sourceRe: 0, sourceIm: 0, angle: 0, ideal: 1 };
const tree = (entries: Readonly<Record<number, readonly [number, AcElementDraw]>>) =>
  Array.from({ length: MAX_NODES }, (_, i) => entries[i] ?? ([0, Z] as const));
/**
 * An ideal 120 V source (node 0 → 1), 1 Ω (1 → 2), and L = 0.1 H in parallel with C = 70.36 µF from
 * node 2 to 0: B_L = 1 / (ωL) = 0.0265258 S against B_C = ωC = 0.0265251 S, a tank 7e-7 S from
 * resonance. The tank's circulating current (about 3 A) dwarfs the 2 µA through the resistor.
 */
const NEAR_RESONANCE: AcCircuitDraw = {
  nodes: 3,
  islands: 1,
  tree: tree({ 1: [0, { ...Z, kind: 8, sourceRe: 1200, ideal: 0 }], 2: [1, { ...Z, decade: 4 }] }),
  extra: [
    [2, 0, { ...Z, kind: 4, decade: 5 }],
    [2, 0, { ...Z, kind: 6, mantissa: 6036, decade: 4 }],
  ],
};

describe('AC MNA properties (synthetic circuits)', () => {
  it('complex KCL, source rows and element laws hold; real and reactive power balance', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const circuit = build(draw);
        checkAcRows(circuit, solve(circuit), true);
      }),
      { numRuns: 90, examples: [[NEAR_RESONANCE]] },
    );
  });

  it('the same holds with series inductance behind the sources (F2.4: utility and generator reactance)', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const circuit = build({ ...draw, sourceInductance: true });
        const dense = solve(circuit);
        checkAcRows(circuit, dense, true);
        // The sparse path replays the new complex Z code (`VALUE_Z`): its solution passes every row too.
        const sparse = new AcSolver({ sparseMinUnknowns: 1 }).solve(
          circuit.netlist,
          circuit.values,
          circuit.frequencyHz,
        );
        expect(sparse.islands.map((i) => i.flags)).toStrictEqual(dense.islands.map((i) => i.flags));
        checkAcRows(circuit, sparse, true);
      }),
      { numRuns: 50 },
    );
  });

  it('sources with series inductance are drawn often enough (generator health, fixed seed)', () => {
    let sources = 0;
    let inductive = 0;
    for (const draw of fc.sample(circuitArb, { seed: 20261031, numRuns: 60 })) {
      const { values } = build({ ...draw, sourceInductance: true });
      for (let b = 0; b < values.count; b++) {
        if (values.stamps[b] !== AC_STAMP_VSOURCE) continue;
        sources++;
        if (values.seriesHenries[b] > 0) inductive++;
      }
    }
    expect(sources).toBeGreaterThan(100);
    expect(inductive / sources).toBeGreaterThan(0.6);
  });

  it('is linear: scaling every source by a complex k scales the solution by k', () => {
    fc.assert(
      fc.property(circuitArb, factorArb, (draw, k) => {
        const circuit = build(draw);
        const base = solve(circuit);
        const scaledValues = scaledSources(circuit.values, k, () => true);
        const scaled = solveAc(circuit.netlist, scaledValues, circuit.frequencyHz);
        if (EXACT_FACTORS.includes(k)) {
          // A power of two, or a quarter turn (which swaps and negates parts), scales every rounding
          // exactly: the solve is k · x̂ bit for bit (±0 aside: the solver writes +0).
          for (let i = 0; i < base.nodes.length; i += 2) {
            const [er, ei] = times(k, base.nodes[i], base.nodes[i + 1]);
            expect(scaled.nodes[i] === er && scaled.nodes[i + 1] === ei, `node value ${i / 2}`).toBe(true);
          }
          for (let i = 0; i < base.branches.length; i += 2) {
            const [er, ei] = times(k, base.branches[i], base.branches[i + 1]);
            expect(scaled.branches[i] === er && scaled.branches[i + 1] === ei, `branch value ${i / 2}`).toBe(true);
          }
        } else {
          checkAcRows(circuit, base);
          checkAcRows({ ...circuit, values: scaledValues }, scaled);
          const parts: AcCombined[] = [
            { values: scaledValues, solution: scaled, coefficient: [1, 0] },
            { values: circuit.values, solution: base, coefficient: [-k[0], -k[1]] },
          ];
          expect(acLinearResidual(circuit.netlist, circuit.frequencyHz, parts)).toBeLessThanOrEqual(1);
        }
        expect(scaled.islands.map((i) => i.flags)).toStrictEqual(base.islands.map((i) => i.flags));
        for (const v of [...scaled.nodes, ...scaled.branches]) expect(Object.is(v, -0)).toBe(false);
      }),
      { numRuns: 80 },
    );
  });

  it('obeys superposition: the response to two sets of sources is the sum of each alone', () => {
    fc.assert(
      fc.property(circuitArb, maskArb, (draw, mask) => {
        const circuit = build(draw);
        const keep = (b: number) => mask[b % mask.length];
        const all = solve(circuit);
        const firstValues = scaledSources(circuit.values, [1, 0], keep);
        const secondValues = scaledSources(circuit.values, [1, 0], (b) => !keep(b));
        const first = solveAc(circuit.netlist, firstValues, circuit.frequencyHz);
        const second = solveAc(circuit.netlist, secondValues, circuit.frequencyHz);
        checkAcRows(circuit, all);
        checkAcRows({ ...circuit, values: firstValues }, first);
        checkAcRows({ ...circuit, values: secondValues }, second);
        const parts: AcCombined[] = [
          { values: circuit.values, solution: all, coefficient: [1, 0] },
          { values: firstValues, solution: first, coefficient: [-1, 0] },
          { values: secondValues, solution: second, coefficient: [-1, 0] },
        ];
        expect(acLinearResidual(circuit.netlist, circuit.frequencyHz, parts)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 90 },
    );
  });

  it('flags exactly the islands whose ideal sources close a loop, and never produces NaN', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const { netlist, values } = build(draw);
        const solution = solveAc(netlist, values, 60);
        for (const island of netlist.islands) {
          if (island.kind !== 'ac') continue;
          const parent = new Map<number, number>(island.nodes.map((n) => [n, n]));
          const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x) as number));
          let loop = false;
          for (const b of island.branches) {
            if (values.stamps[b] !== AC_STAMP_VSOURCE || values.ohms[b] !== 0) continue;
            const ra = find(netlist.branches[b].a);
            const rb = find(netlist.branches[b].b);
            if (ra === rb) loop = true;
            else parent.set(ra, rb);
          }
          expect(isAcSingular(solution, island.index)).toBe(loop);
        }
        for (const v of [...solution.nodes, ...solution.branches]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is bit-identical across solver instances, after other circuits and frequencies, into a dirty `out`', () => {
    const shared = new AcSolver();
    fc.assert(
      fc.property(circuitArb, circuitArb, fc.constantFrom(50, 400), (draw, other, otherHz) => {
        const circuit = build(draw);
        const fresh = solve(circuit);
        // Another circuit, and this one at another frequency, in between: nothing carries over.
        const otherCircuit = build(other);
        shared.solve(otherCircuit.netlist, otherCircuit.values, 60);
        // The other frequency is solved warm and compared too: a stale ω on the dense path fails here.
        expectSameBits(
          shared.solve(circuit.netlist, circuit.values, otherHz),
          new AcSolver().solve(circuit.netlist, circuit.values, otherHz),
        );
        expectSameBits(shared.solve(circuit.netlist, circuit.values, 60), fresh);
        // Into an `out` full of sentinels: every AC entry and record is rewritten, the rest left alone.
        const out = dirtySolution(circuit.netlist);
        const sentinel = dirtySolution(circuit.netlist);
        expect(shared.solve(circuit.netlist, circuit.values, 60, out)).toBe(out);
        expect(acPart(circuit.netlist, out)).toStrictEqual(acPart(circuit.netlist, fresh));
        expect(out.topologyHash).toBe(circuit.netlist.topologyHash);
        // Every non-AC island is exactly the sentinel: its whole record, and re and im of every node
        // and branch (PR #51 review: only re and referenceNode were checked).
        for (const island of circuit.netlist.islands) {
          if (island.kind === 'ac') continue;
          expect(out.islands[island.index]).toStrictEqual(sentinel.islands[island.index]);
          for (const n of island.nodes) {
            for (const k of [2 * n, 2 * n + 1])
              expect(Object.is(out.nodes[k], sentinel.nodes[k]), `node ${k}`).toBe(true);
          }
          for (const b of island.branches) {
            for (const k of [2 * b, 2 * b + 1]) {
              expect(Object.is(out.branches[k], sentinel.branches[k]), `branch ${k}`).toBe(true);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a frequency change changes every reactive admittance: the solve differs unless no L or C carries current', () => {
    fc.assert(
      fc.property(circuitArb, (draw) => {
        const at60 = build(draw, 60);
        const at50 = build(draw, 50);
        const a = solve(at60);
        const b = solve(at50);
        // Exactly as a fresh solve of the same values at 50 Hz: the frequency is an input, not state.
        expectSameBits(new AcSolver().solve(at50.netlist, at50.values, 50), b);
        const reactive = at60.netlist.islands.some(
          (island) =>
            island.kind === 'ac' &&
            !isAcSingular(a, island.index) &&
            island.branches.some((br) => {
              const s = at60.values.stamps[br];
              const i = Math.hypot(a.branches[2 * br], a.branches[2 * br + 1]);
              return (s === AC_STAMP_INDUCTOR || s === AC_STAMP_CAPACITOR) && i > 1e-6;
            }),
        );
        if (reactive) expect(Array.from(a.branches)).not.toStrictEqual(Array.from(b.branches));
        checkAcRows(at50, b);
      }),
      { numRuns: 100 },
    );
  });

  it('pins the bits of 300 seeded solves (a numeric change re-pins this and bumps SIM_ENGINE_VERSION)', () => {
    // As the DC pin (`properties.spec.ts`): anything that changes a result bit moves this hash. A
    // deliberate change re-pins it with the other numeric goldens and bumps SIM_ENGINE_VERSION (D8).
    // Every circuit here is below SPARSE_MIN_UNKNOWNS, so this pins the complex dense path;
    // `ac-sparse.spec.ts` pins the sparse one.
    const solver = new AcSolver();
    const chunks: Uint8Array[] = [];
    for (const draw of fc.sample(circuitArb, { seed: 20261031, numRuns: 300 })) {
      const { netlist, values } = build(draw);
      const s = solver.solve(netlist, values, 60);
      const islands = s.islands.flatMap((i) => [i.solved ? 1 : 0, i.referenceNode, i.unknowns, i.flags, i.iterations]);
      chunks.push(new Uint8Array(Float64Array.from([...s.nodes, ...s.branches, ...islands]).buffer));
    }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const hex = Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
    // Re-pinned in #51 when the generator's non-ideal sources were clamped to ≥ 1e-4 Ω: the circuits
    // changed, not the solver (no solver source changed): that re-pin alone did not bump SIM_ENGINE_VERSION. Was 5ce7f4ef….
    expect(hex).toBe('68dfa97608a5318af6a36a9f3f98609e3e16a11f0742bd6db0388826f24e084b');
  });
});

describe('AC islands beside DC and mixed ones (compiled bench worlds)', () => {
  /** An AC source and a 144 Ω lamp (island 0), a battery and a lamp (1), an AC source and a battery together (2). */
  function bench() {
    const bus = benchBus(TEST_CATALOG);
    for (const ref of [AC_SOURCE, LAMP, BATTERY, LAMP, AC_SOURCE, BATTERY]) {
      bus.exec('entity.place', { ref, positionMm: origin });
    }
    for (const [a, b] of [
      [end(1, 'l'), end(2, 'a')],
      [end(2, 'b'), end(1, 'n')],
      [end(3, 'pos'), end(4, 'a')],
      [end(4, 'b'), end(3, 'neg')],
      [end(5, 'l'), end(6, 'pos')],
      [end(6, 'neg'), end(5, 'n')],
    ]) {
      bus.exec('lead.connect', { ref: LEAD, a, b });
    }
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    const lamp = (branch: { model: string }) => branch.model === 'lamp.incandescent';
    const dc = dcBranchValues(netlist, (branch, v) => {
      if (!lamp(branch)) return false;
      v.resistor(branch.index, 28.8);
      return true;
    });
    const ac = acBranchValues(netlist, (branch, v) => {
      if (lamp(branch)) v.resistor(branch.index, 144);
      else if (branch.model === 'test.acSource') v.vsourcePolar(branch.index, branch.values['nominalVoltageV'], 0, 0);
      else return false;
      return true;
    });
    return { netlist, dc, ac };
  }

  it('solves the AC island, leaves the DC and mixed ones to (and from) the DC solver, and solves mixed ones not at all', () => {
    const { netlist, dc, ac } = bench();
    expect(netlist.islands.map((i) => i.kind)).toStrictEqual(['ac', 'dc', 'mixed']);
    expect(netlist.diagnostics).toContainEqual({ code: 'mixed-island', island: 2 });
    // The DC island ends `nonConverged`: a filament law that flips between 2 Ω and 200 Ω around 0.6 A
    // has no fixed point. The AC solve must keep that flag and iteration count (F2.3a writes DC, then
    // AC, into one record).
    const out = new DcSolver().solveNonlinear(netlist, dc, {
      hook: (island, iterate, values) => {
        for (const b of island.branches) {
          if (netlist.branches[b].model !== 'lamp.incandescent') continue;
          const amps = iterate === null ? 0 : Math.abs(iterate.branches[2 * b]);
          values.resistor(b, amps < 0.6 ? 2 : 200);
        }
      },
    });
    expect(out.islands[1].flags & ISLAND_FLAG_NON_CONVERGED).toBe(ISLAND_FLAG_NON_CONVERGED);
    expect(out.islands[1].iterations).toBeGreaterThan(1);
    const dcOnly = {
      nodes: Array.from(out.nodes),
      branches: Array.from(out.branches),
      islands: structuredClone(out.islands),
    };
    expect(new AcSolver().solve(netlist, ac, 60, out)).toBe(out);
    expect(out.islands.map((i) => i.solved)).toStrictEqual([true, true, false]);
    // The DC island is exactly the DC solver's, the mixed one exactly zero and unsolved: whole records,
    // and re and im of every node and branch.
    for (const index of [1, 2]) {
      const island = netlist.islands[index];
      for (const n of island.nodes) {
        for (const k of [2 * n, 2 * n + 1]) expect(Object.is(out.nodes[k], dcOnly.nodes[k]), `node ${k}`).toBe(true);
      }
      for (const b of island.branches) {
        for (const k of [2 * b, 2 * b + 1]) {
          expect(Object.is(out.branches[k], dcOnly.branches[k]), `branch ${k}`).toBe(true);
        }
      }
      expect(out.islands[index]).toStrictEqual(dcOnly.islands[index]);
    }
    for (const n of netlist.islands[2].nodes) expect([out.nodes[2 * n], out.nodes[2 * n + 1]]).toStrictEqual([0, 0]);
    // The AC island: 120 V across 144 Ω and two 41 mΩ leads, in phase.
    const lampBranch = netlist.islands[0].branches.find((b) => netlist.branches[b].model === 'lamp.incandescent');
    const i = out.branches[2 * (lampBranch as number)];
    expect(i).toBeGreaterThan(0.83);
    expect(i).toBeLessThan(120 / 144);
    expect(out.branches[2 * (lampBranch as number) + 1]).toBe(0);
    checkAcRows({ netlist, values: ac, frequencyHz: 60 }, out, true);
    expect(out.islands[0].flags & ISLAND_FLAG_SINGULAR).toBe(0);
  });
});

describe('generator health (the AC properties above are not vacuous)', () => {
  it('synthetic AC circuits are sizeable, loopy, multi-island and hold every stamp and angle', () => {
    const draws = fc.sample(circuitArb, { seed: 20261031, numRuns: 300 });
    const counts = {
      nodes: 0,
      loop: 0,
      multiIsland: 0,
      acIsland: 0,
      inductor: 0,
      capacitor: 0,
      both: 0,
      ideal: 0,
      complexEmf: 0,
      selfLoop: 0,
      singular: 0,
      current: 0,
      reactiveCurrent: 0,
    };
    const shares: number[] = [];
    for (const draw of draws) {
      const { netlist, values } = build(draw);
      const solution = solveAc(netlist, values, 60);
      shares.push(...acFloorShares({ netlist, values, frequencyHz: 60 }, solution));
      const stamps = netlist.branches.map((b) => values.stamps[b.index]);
      counts.nodes += netlist.nodes.length;
      if (netlist.branches.length > netlist.nodes.length - netlist.islands.length) counts.loop++;
      if (netlist.islands.length > 1) counts.multiIsland++;
      if (netlist.islands.some((i) => i.kind === 'ac')) counts.acIsland++;
      const l = stamps.includes(AC_STAMP_INDUCTOR);
      const c = stamps.includes(AC_STAMP_CAPACITOR);
      if (l) counts.inductor++;
      if (c) counts.capacitor++;
      if (l && c) counts.both++;
      if (netlist.branches.some((b) => values.stamps[b.index] === AC_STAMP_VSOURCE && values.ohms[b.index] === 0))
        counts.ideal++;
      // A source whose EMF is neither real nor at ±120° (a free complex value).
      if (
        netlist.branches.some(
          (b) =>
            values.stamps[b.index] === AC_STAMP_VSOURCE &&
            values.emfIm[b.index] !== 0 &&
            Math.abs(values.emfIm[b.index]) !== Math.abs(values.emfRe[b.index] * -2 * SIN_120),
        )
      )
        counts.complexEmf++;
      if (netlist.branches.some((b) => b.a === b.b)) counts.selfLoop++;
      if (netlist.islands.some((i) => i.kind === 'ac' && isAcSingular(solution, i.index))) counts.singular++;
      const live = (b: number) => Math.hypot(solution.branches[2 * b], solution.branches[2 * b + 1]) > 1e-6;
      const healthy = netlist.islands.filter((i) => i.kind === 'ac' && !isAcSingular(solution, i.index));
      if (healthy.some((i) => i.branches.some(live))) counts.current++;
      if (
        healthy.some((i) =>
          i.branches.some(
            (b) => (values.stamps[b] === AC_STAMP_INDUCTOR || values.stamps[b] === AC_STAMP_CAPACITOR) && live(b),
          ),
        )
      )
        counts.reactiveCurrent++;
    }
    // Measured on this seed (F2.2 part 2): 7.6 nodes; loops 1.0, multi-island 0.27, an AC island 0.97,
    // L 0.87, C 0.84, both 0.75, an ideal source 0.58, a free complex EMF 0.61, a self-loop 0.75,
    // singular 0.13, real current 0.84, current in an L or C 0.66. The floors leave margin.
    const share = (count: number) => count / draws.length;
    expect(counts.nodes / draws.length).toBeGreaterThanOrEqual(6);
    expect(share(counts.loop)).toBeGreaterThanOrEqual(0.9);
    expect(share(counts.multiIsland)).toBeGreaterThanOrEqual(0.2);
    expect(share(counts.acIsland)).toBeGreaterThanOrEqual(0.9);
    expect(share(counts.inductor)).toBeGreaterThanOrEqual(0.8);
    expect(share(counts.capacitor)).toBeGreaterThanOrEqual(0.75);
    expect(share(counts.both)).toBeGreaterThanOrEqual(0.65);
    expect(share(counts.ideal)).toBeGreaterThanOrEqual(0.45);
    expect(share(counts.complexEmf)).toBeGreaterThanOrEqual(0.5);
    expect(share(counts.selfLoop)).toBeGreaterThanOrEqual(0.5);
    expect(share(counts.singular)).toBeGreaterThanOrEqual(0.05);
    expect(share(counts.singular)).toBeLessThanOrEqual(0.25);
    expect(share(counts.current)).toBeGreaterThanOrEqual(0.75);
    expect(share(counts.reactiveCurrent)).toBeGreaterThanOrEqual(0.55);
    // The floor policy's ceiling (PR #51 review): on islands carrying real current, the KCL floor stays
    // a small share of the largest current, so the floors check something. Measured on this seed:
    // p99 2.1e-5 of max|I| (max 1.3e-3, 296 islands); with source R unclamped (down to 1 µΩ) it was 1.9e-4.
    expect(quantile(shares, 0.99)).toBeLessThanOrEqual(1e-4);
    // And the median (measured about 1e-9): catches a loosened relative term or resistor term, which
    // moves every island, not just the tail.
    expect(quantile(shares, 0.5)).toBeLessThanOrEqual(1e-8);
  });
});
