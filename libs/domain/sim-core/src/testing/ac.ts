import { expect } from 'vitest';
import { GMIN_S } from '../lib/constants';
import {
  AC_STAMP_CAPACITOR,
  AC_STAMP_INDUCTOR,
  AC_STAMP_RESISTOR,
  AC_STAMP_VSOURCE,
  type AcBranchValues,
} from '../lib/mna/ac-values';
import { type DcSolution, ISLAND_FLAG_SINGULAR } from '../lib/mna/dc';
import { angularFrequency } from '../lib/mna/phasor';
import type { Netlist, NetlistIsland } from '../lib/netlist/types';
import { Accumulator } from './mna';

/*
 * The phasor solver's physical checks (F2.2 part 2), under the plan's F2.2 floor policy with complex
 * magnitudes (|·| is the modulus): the DC checks of `mna.ts` and `solver-checks.ts`, restated for
 * complex admittances y_b (1 / R, −j / (ωL), jωC) and phasor sources. Specs only; excluded from the
 * lib build, held to D6 like the rest of `src/` (moduli by `Math.sqrt`).
 */

/** Machine epsilon (2⁻⁵²). */
const EPS = Number.EPSILON;

/** A phasor as `[re, im]`. */
export type Phasor = readonly [number, number];

export const re = (z: Phasor): number => z[0];
export const im = (z: Phasor): number => z[1];
export const cabs = (z: Phasor): number => Math.sqrt(z[0] * z[0] + z[1] * z[1]);
export const cadd = (a: Phasor, b: Phasor): Phasor => [a[0] + b[0], a[1] + b[1]];
export const csub = (a: Phasor, b: Phasor): Phasor => [a[0] - b[0], a[1] - b[1]];
export const cmul = (a: Phasor, b: Phasor): Phasor => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
export const cdiv = (a: Phasor, b: Phasor): Phasor => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
export const conj = (z: Phasor): Phasor => [z[0], -z[1]];

/** A node's voltage phasor. */
export const phasorV = (solution: DcSolution, node: number): Phasor => [
  solution.nodes[2 * node],
  solution.nodes[2 * node + 1],
];
/** A branch's current phasor. */
export const phasorI = (solution: DcSolution, branch: number): Phasor => [
  solution.branches[2 * branch],
  solution.branches[2 * branch + 1],
];

/** A complex compensated accumulator. */
class ComplexAccumulator {
  private readonly r = new Accumulator();
  private readonly i = new Accumulator();
  add(z: Phasor): void {
    this.r.add(z[0]);
    this.i.add(z[1]);
  }
  /** Adds c · z, nearly exactly. */
  addProduct(c: Phasor, z: Phasor): void {
    this.r.addProduct(c[0], z[0]);
    this.r.addProduct(-c[1], z[1]);
    this.i.addProduct(c[0], z[1]);
    this.i.addProduct(c[1], z[0]);
  }
  /** Adds c · (x − y), nearly exactly (c complex, x and y phasors). */
  addScaledDifference(c: Phasor, x: Phasor, y: Phasor): void {
    this.r.addScaledDifference(c[0], x[0], y[0]);
    this.r.addScaledDifference(-c[1], x[1], y[1]);
    this.i.addScaledDifference(c[0], x[1], y[1]);
    this.i.addScaledDifference(c[1], x[0], y[0]);
  }
  get value(): Phasor {
    return [this.r.value, this.i.value];
  }
}

export interface AcCircuit {
  readonly netlist: Netlist;
  readonly values: AcBranchValues;
  readonly frequencyHz: number;
}

/** A passive branch's admittance at the circuit's ω, as the solver computes it; null for a source. */
export function admittance({ values, frequencyHz }: AcCircuit, branch: number): Phasor | null {
  const omega = angularFrequency(frequencyHz);
  switch (values.stamps[branch]) {
    case AC_STAMP_RESISTOR:
      return [1 / values.ohms[branch], 0];
    case AC_STAMP_INDUCTOR:
      return [0, -(1 / (omega * values.henries[branch]))];
    case AC_STAMP_CAPACITOR:
      return [0, omega * values.farads[branch]];
    default:
      return null;
  }
}

/** A source's EMF phasor. */
const emf = (values: AcBranchValues, branch: number): Phasor => [values.emfRe[branch], values.emfIm[branch]];

/**
 * A branch's rounding term in the floor policy, with complex magnitudes: 16 ε |y_b| (|V_a| + |V_b|) for
 * a passive branch. A source behind a series R > 0 is a branch of admittance 1 / R too: its current is
 * (E − Vb + Va) / R, so it is resolved only to 16 ε (|V_a| + |V_b| + |E|) / R, like the DC outer loop's
 * `currentResolution` for a voltage-mode source. Without it, a tree island carrying only gmin current
 * (1e-9 A) behind a 4 mΩ, 700 V source left a 1.1e-12 A KCL imbalance on the sparse path, 1.07× a
 * floor that counted the source as stiffness-free (fresh-seed counterexample, kept in `ac-sparse.spec.ts`).
 * An ideal source (R = 0) has an exact unknown current: 0.
 */
export function acBranchRounding(circuit: AcCircuit, solution: DcSolution, branch: number): number {
  const { a, b } = circuit.netlist.branches[branch];
  const volts = cabs(phasorV(solution, a)) + cabs(phasorV(solution, b));
  const y = admittance(circuit, branch);
  if (y !== null) return 16 * EPS * cabs(y) * volts;
  const ohms = circuit.values.ohms[branch];
  return ohms > 0 ? (16 * EPS * (volts + cabs(emf(circuit.values, branch)))) / ohms : 0;
}

/** |Va| + |Vb| + |R I| + |E|: a source row's terms. */
function sourceRowTerm({ netlist, values }: AcCircuit, solution: DcSolution, index: number): number {
  const { a, b } = netlist.branches[index];
  return (
    cabs(phasorV(solution, a)) +
    cabs(phasorV(solution, b)) +
    values.ohms[index] * cabs(phasorI(solution, index)) +
    cabs(emf(values, index))
  );
}

/**
 * The island-wide KCL floor (the floor policy, complex magnitudes): 1e-9 · max|I| + 1e-12 A, plus
 * every branch's rounding term at both ends (gmin's included), plus 2 · 16 ε · the largest source-row
 * term · the stiffest node's Σ|y| (elimination mixes the volt-scaled source rows into the KCL rows).
 */
export function acKclFloor(circuit: AcCircuit, solution: DcSolution, island: NetlistIsland): number {
  const { netlist } = circuit;
  const reference = solution.islands[island.index].referenceNode;
  const gmin = GMIN_S.value;
  let maxI = 0;
  let rounding = 0;
  // Per-node Σ|y|, in a typed array indexed by node: this runs once per solve and part in the
  // residual-space checks, so no Map or spread (PR #51 review: superposition at 761 ms under load).
  const stiffness = new Float64Array(netlist.nodes.length);
  for (const node of island.nodes) stiffness[node] = gmin;
  for (const node of island.nodes) {
    if (node === reference) continue;
    const v = cabs(phasorV(solution, node));
    maxI = Math.max(maxI, gmin * v);
    rounding += 2 * 16 * EPS * gmin * v;
  }
  let sourceScale = 0;
  for (const index of island.branches) {
    maxI = Math.max(maxI, cabs(phasorI(solution, index)));
    rounding += 2 * acBranchRounding(circuit, solution, index);
    const y = admittance(circuit, index);
    const { a, b } = netlist.branches[index];
    if (y !== null) {
      const g = cabs(y);
      stiffness[a] += g;
      stiffness[b] += g;
    } else {
      sourceScale = Math.max(sourceScale, sourceRowTerm(circuit, solution, index));
    }
  }
  let stiffest = 0;
  for (const node of island.nodes) stiffest = Math.max(stiffest, stiffness[node]);
  rounding += 2 * 16 * EPS * sourceScale * stiffest;
  return 1e-9 * maxI + 1e-12 + rounding;
}

/** Each node's complex KCL imbalance (current leaving through each element, plus gmin), compensated. */
function kclSums(netlist: Netlist, solution: DcSolution, island: NetlistIsland): Map<number, Phasor> {
  const reference = solution.islands[island.index].referenceNode;
  const sums = new Map<number, ComplexAccumulator>(island.nodes.map((n) => [n, new ComplexAccumulator()]));
  const gmin: Phasor = [GMIN_S.value, 0];
  for (const node of island.nodes) {
    if (node === reference) continue;
    const v = phasorV(solution, node);
    sums.get(node)?.addProduct(gmin, v);
    sums.get(reference)?.addProduct([-GMIN_S.value, 0], v);
  }
  for (const index of island.branches) {
    const { a, b } = netlist.branches[index];
    const i = phasorI(solution, index);
    sums.get(a)?.add(i);
    sums.get(b)?.add([-i[0], -i[1]]);
  }
  return new Map([...sums].map(([n, acc]) => [n, acc.value]));
}

/** KCL at every node of a solved island: the worst |imbalance| ÷ the island's floor (≤ 1 holds). */
export function acKcl(circuit: AcCircuit, solution: DcSolution, island: NetlistIsland): number {
  const floor = acKclFloor(circuit, solution, island);
  let worst = 0;
  for (const sum of kclSums(circuit.netlist, solution, island).values()) worst = Math.max(worst, cabs(sum) / floor);
  return worst;
}

/** A source row's bound: 1e-9 · the island's largest row term + 1e-12 + 16 ε · its own. */
function sourceRowBound(circuit: AcCircuit, solution: DcSolution, index: number, largest: number): number {
  return 1e-9 * largest + 1e-12 + 16 * EPS * sourceRowTerm(circuit, solution, index);
}

const sources = ({ netlist }: AcCircuit, island: NetlistIsland) =>
  island.branches.filter((index) => netlist.branches[index].kind === 'vsource');

/** The source rows Vb − Va + R I = E: the worst |residual| ÷ its bound (≤ 1 holds). */
export function acSourceRows(circuit: AcCircuit, solution: DcSolution, island: NetlistIsland): number {
  const { netlist, values } = circuit;
  const rows = sources(circuit, island);
  const largest = rows.reduce((m, index) => Math.max(m, sourceRowTerm(circuit, solution, index)), 0);
  let worst = 0;
  for (const index of rows) {
    const { a, b } = netlist.branches[index];
    const acc = new ComplexAccumulator();
    if (a !== b) acc.addScaledDifference([1, 0], phasorV(solution, b), phasorV(solution, a));
    acc.addProduct([values.ohms[index], 0], phasorI(solution, index));
    const e = emf(values, index);
    acc.add([-e[0], -e[1]]);
    worst = Math.max(worst, cabs(acc.value) / sourceRowBound(circuit, solution, index, largest));
  }
  return worst;
}

/**
 * Each passive branch's own law, I = y (Va − Vb), within 1e-12 |I| + 64 ε |y| (|Va| + |Vb|): KCL and
 * the source rows can't see a current that fits its nodes' balance but not its admittance.
 */
export function acElementRows(circuit: AcCircuit, solution: DcSolution, branches: readonly number[]): void {
  for (const index of branches) {
    const y = admittance(circuit, index);
    if (y === null) continue;
    const { a, b } = circuit.netlist.branches[index];
    const va = phasorV(solution, a);
    const vb = phasorV(solution, b);
    const want = cmul(y, csub(va, vb));
    const floor = 1e-12 * cabs(want) + 64 * EPS * cabs(y) * (cabs(va) + cabs(vb)) + 1e-300;
    expect(cabs(csub(phasorI(solution, index), want)), `element law on branch ${index}`).toBeLessThanOrEqual(floor);
  }
}

/**
 * Complex power over a solved island (Tellegen's theorem: Σ V conj(I) over every branch, gmin
 * included, is 0). Real power: what the sources deliver, Σ Re(E conj(I)), against what the resistances
 * (each source's series R included) and gmin dissipate, Σ R |I|² + Σ gmin |V|². Reactive power: what
 * the sources deliver, Σ Im(E conj(I)), against what the reactances absorb, Σ ωL |I|² for an inductor
 * and −|I|² / (ωC) for a capacitor (a capacitor supplies vars). `scale` is Σ |terms| of each balance,
 * and `floor` the KCL floor carried through Tellegen (Σ |V_n| × the island's KCL floor).
 */
export function acPower(
  circuit: AcCircuit,
  solution: DcSolution,
  island: NetlistIsland,
): {
  readonly real: { readonly delivered: number; readonly absorbed: number; readonly scale: number };
  readonly reactive: { readonly delivered: number; readonly absorbed: number; readonly scale: number };
  readonly floor: number;
} {
  const { netlist, values } = circuit;
  const omega = angularFrequency(circuit.frequencyHz);
  const reference = solution.islands[island.index].referenceNode;
  const real = { delivered: 0, absorbed: 0, scale: 0 };
  const reactive = { delivered: 0, absorbed: 0, scale: 0 };
  let voltages = 0;
  for (const node of island.nodes) {
    const v = cabs(phasorV(solution, node));
    voltages += v;
    if (node === reference) continue;
    const p = GMIN_S.value * v * v;
    real.absorbed += p;
    real.scale += p;
  }
  for (const index of island.branches) {
    const i = phasorI(solution, index);
    const i2 = i[0] * i[0] + i[1] * i[1];
    switch (values.stamps[index]) {
      case AC_STAMP_RESISTOR: {
        const p = i2 * values.ohms[index];
        real.absorbed += p;
        real.scale += p;
        break;
      }
      case AC_STAMP_INDUCTOR: {
        const q = i2 * omega * values.henries[index];
        reactive.absorbed += q;
        reactive.scale += q;
        break;
      }
      case AC_STAMP_CAPACITOR: {
        const q = -i2 / (omega * values.farads[index]);
        reactive.absorbed += q;
        reactive.scale += -q;
        break;
      }
      case AC_STAMP_VSOURCE: {
        const e = emf(values, index);
        const s = cmul(e, conj(i));
        const loss = i2 * values.ohms[index];
        // Each part of E conj(I) carries rounding of order ε |E| |I| (its two products), so both
        // balances take the apparent power |E| |I| as the term: a purely resistive island's Q is 0
        // only to that (a self-looped source's Q = Im(|E|² / R) came out 2.9e-11 var on 1e5 VA).
        const apparent = cabs(e) * Math.sqrt(i2);
        real.delivered += s[0];
        real.absorbed += loss;
        real.scale += apparent + loss;
        reactive.delivered += s[1];
        reactive.scale += apparent;
        break;
      }
    }
  }
  return { real, reactive, floor: voltages * acKclFloor(circuit, solution, island) };
}

export const isAcSingular = (solution: DcSolution, island: number): boolean =>
  (solution.islands[island].flags & ISLAND_FLAG_SINGULAR) !== 0;

/**
 * Every equation of the system on every solved, non-singular `ac` island (KCL at every node, every
 * source row, each passive element's law), the singular contract on the rest, and with `withPower`
 * the real and reactive power balances.
 */
export function checkAcRows(circuit: AcCircuit, solution: DcSolution, withPower = false): void {
  for (const v of solution.nodes) expect(Number.isFinite(v)).toBe(true);
  for (const v of solution.branches) expect(Number.isFinite(v)).toBe(true);
  for (const island of circuit.netlist.islands) {
    if (island.kind !== 'ac') continue;
    expect(solution.islands[island.index].solved).toBe(true);
    if (isAcSingular(solution, island.index)) {
      for (const node of island.nodes) {
        expect(Object.is(solution.nodes[2 * node], 0) && Object.is(solution.nodes[2 * node + 1], 0)).toBe(true);
      }
      for (const index of island.branches) {
        expect(Object.is(solution.branches[2 * index], 0) && Object.is(solution.branches[2 * index + 1], 0)).toBe(true);
      }
      continue;
    }
    expect(acKcl(circuit, solution, island), `KCL on island ${island.index}`).toBeLessThanOrEqual(1);
    expect(acSourceRows(circuit, solution, island), `source rows on island ${island.index}`).toBeLessThanOrEqual(1);
    acElementRows(circuit, solution, island.branches);
    if (withPower) {
      const { real, reactive, floor } = acPower(circuit, solution, island);
      expect(Math.abs(real.delivered - real.absorbed), `real power, island ${island.index}`).toBeLessThanOrEqual(
        1e-9 * real.scale + floor,
      );
      expect(
        Math.abs(reactive.delivered - reactive.absorbed),
        `reactive power, island ${island.index}`,
      ).toBeLessThanOrEqual(1e-9 * reactive.scale + floor);
    }
  }
}

/** One solve in a linear combination d = Σ c_p x̂_p, with a complex coefficient. */
export interface AcCombined {
  readonly values: AcBranchValues;
  readonly solution: DcSolution;
  readonly coefficient: Phasor;
}

/**
 * Linearity and superposition in residual space (the floor policy), for complex coefficients: every
 * row of the system applied to d = Σ c_p x̂_p (with Σ c_p b_p = 0) is that combination of the solves'
 * own residuals plus the rounding of forming d. So, once each solve has passed its rows, each KCL row
 * of d must hold within Σ |c_p| × that solve's KCL floor plus 8 ε Σ |c_p| × the row's terms (a complex
 * product rounds twice), and each source row within Σ |c_p| × (its bound + 8 ε × its terms); the
 * right-hand sides must cancel. Returns the worst ratio of a row's |residual| to its bound.
 */
export function acLinearResidual(netlist: Netlist, frequencyHz: number, parts: readonly AcCombined[]): number {
  const gmin = GMIN_S.value;
  let worst = 0;
  const circuitOf = (p: AcCombined): AcCircuit => ({ netlist, values: p.values, frequencyHz });
  const combine = (get: (s: DcSolution) => Phasor): Phasor => {
    const acc = new ComplexAccumulator();
    for (const p of parts) acc.addProduct(p.coefficient, get(p.solution));
    return acc.value;
  };
  for (const island of netlist.islands) {
    if (island.kind !== 'ac') continue;
    const first = parts[0].solution.islands[island.index];
    if (!first.solved || (first.flags & ISLAND_FLAG_SINGULAR) !== 0) continue;
    const reference = first.referenceNode;
    let kclBound = 0;
    for (const p of parts) {
      let terms = 0;
      for (const index of island.branches) terms += cabs(phasorI(p.solution, index));
      for (const node of island.nodes) terms += gmin * cabs(phasorV(p.solution, node));
      kclBound += cabs(p.coefficient) * (acKclFloor(circuitOf(p), p.solution, island) + 8 * EPS * terms);
    }
    const sums = new Map<number, ComplexAccumulator>(island.nodes.map((n) => [n, new ComplexAccumulator()]));
    for (const node of island.nodes) {
      if (node === reference) continue;
      const v = combine((s) => phasorV(s, node));
      sums.get(node)?.addProduct([gmin, 0], v);
      sums.get(reference)?.addProduct([-gmin, 0], v);
    }
    for (const index of island.branches) {
      const { a, b } = netlist.branches[index];
      if (a === b) continue;
      const i = combine((s) => phasorI(s, index));
      sums.get(a)?.add(i);
      sums.get(b)?.add([-i[0], -i[1]]);
    }
    for (const acc of sums.values()) worst = Math.max(worst, cabs(acc.value) / kclBound);
    const rows = sources(circuitOf(parts[0]), island);
    const largest = parts.map((p) =>
      rows.reduce((m, index) => Math.max(m, sourceRowTerm(circuitOf(p), p.solution, index)), 0),
    );
    for (const index of rows) {
      const { a, b } = netlist.branches[index];
      const acc = new ComplexAccumulator();
      let bound = 0;
      parts.forEach((p, j) => {
        const c = p.coefficient;
        if (a !== b) acc.addScaledDifference(c, phasorV(p.solution, b), phasorV(p.solution, a));
        acc.addProduct(cmul(c, [p.values.ohms[index], 0]), phasorI(p.solution, index));
        acc.addProduct([-c[0], -c[1]], emf(p.values, index));
        const circuit = circuitOf(p);
        bound +=
          cabs(c) *
          (sourceRowBound(circuit, p.solution, index, largest[j]) +
            8 * EPS * sourceRowTerm(circuit, p.solution, index));
      });
      worst = Math.max(worst, cabs(acc.value) / bound);
    }
  }
  return worst;
}

/** As `floorShares` (DC): each live `ac` island's KCL floor as a share of its largest |I|. */
export function acFloorShares(circuit: AcCircuit, solution: DcSolution): number[] {
  const shares: number[] = [];
  for (const island of circuit.netlist.islands) {
    if (island.kind !== 'ac' || isAcSingular(solution, island.index)) continue;
    const largest = island.branches.reduce((m, b) => Math.max(m, cabs(phasorI(solution, b))), 0);
    if (!(largest > 1e-6)) continue;
    shares.push(acKclFloor(circuit, solution, island) / largest);
  }
  return shares;
}
