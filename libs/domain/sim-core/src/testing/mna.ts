import { GMIN_S } from '../lib/constants';
import { type DcSolution, ISLAND_FLAG_SINGULAR } from '../lib/mna/dc';
import { DC_STAMP_ISOURCE, DC_STAMP_RESISTOR, DC_STAMP_VSOURCE, type DcBranchValues } from '../lib/mna/values';
import { computeTopologyHash } from '../lib/netlist/hash';
import { UnionFind } from '../lib/netlist/union-find';
import type { ElementKind, IslandKind, Netlist, NetlistBranch, NetlistIsland, NetlistNode } from '../lib/netlist/types';

/*
 * Helpers for the MNA specs (F2.2): synthetic netlists built straight from an edge list, and the
 * physical checks the properties assert (KCL, power balance). Specs only; excluded from the lib build.
 */

export interface SyntheticBranch {
  readonly a: number;
  readonly b: number;
  readonly kind: ElementKind;
}

/**
 * A netlist of `nodeCount` nodes and the given branches, with islands computed as the compiler
 * would (connected components numbered by their smallest node) and classified `dc` when they hold a
 * `vsource` element, else `empty`. Node `i` has the single member `(i + 1, 't')`; branch `i` is
 * connection `i + 1` of model `test.element`.
 */
export function syntheticNetlist(nodeCount: number, branches: readonly SyntheticBranch[]): Netlist {
  const sets = new UnionFind(nodeCount);
  for (const branch of branches) sets.union(branch.a, branch.b);
  const islandOfRoot = new Map<number, number>();
  const islandOfNode: number[] = [];
  for (let node = 0; node < nodeCount; node++) {
    const root = sets.find(node);
    let island = islandOfRoot.get(root);
    if (island === undefined) {
      island = islandOfRoot.size;
      islandOfRoot.set(root, island);
    }
    islandOfNode.push(island);
  }
  const nodes: NetlistNode[] = islandOfNode.map((island, index) => ({
    index,
    island,
    members: [{ entity: index + 1, terminal: 't' }],
  }));
  const netBranches: NetlistBranch[] = branches.map((branch, index) => ({
    index,
    element: { kind: 'connection', connection: index + 1 },
    kind: branch.kind,
    model: 'test.element',
    source: branch.kind === 'vsource' ? 'dc' : null,
    a: branch.a,
    b: branch.b,
    island: islandOfNode[branch.a],
    values: {},
  }));
  const islands: NetlistIsland[] = [...islandOfRoot.values()].map((index) => {
    const islandBranches = netBranches.filter((b) => b.island === index);
    const kind: IslandKind = islandBranches.some((b) => b.kind === 'vsource') ? 'dc' : 'empty';
    return {
      index,
      kind,
      nodes: nodes.filter((n) => n.island === index).map((n) => n.index),
      branches: islandBranches.map((b) => b.index),
    };
  });
  // A real hash of the structure: the factorisation cache keys on it, so two different synthetic
  // netlists must never share one.
  const topologyHash = computeTopologyHash(nodes, netBranches);
  return { nodes, branches: netBranches, islands, devices: [], topologyHash, diagnostics: [] };
}

/** The node holding `entity:terminal`. */
export function nodeOf(netlist: Netlist, entity: number, terminal: string): number {
  const node = netlist.nodes.find((n) => n.members.some((m) => m.entity === entity && m.terminal === terminal));
  if (node === undefined) throw new Error(`no node holds ${entity}:${terminal}`);
  return node.index;
}

/** The branch of an entity's part, or of a connection. */
export function branchOf(netlist: Netlist, entity: number, part: string): number;
export function branchOf(netlist: Netlist, connection: number): number;
export function branchOf(netlist: Netlist, id: number, part?: string): number {
  const branch = netlist.branches.find((b) =>
    part === undefined
      ? b.element.kind === 'connection' && b.element.connection === id
      : b.element.kind === 'entity' && b.element.entity === id && b.element.part === part,
  );
  if (branch === undefined) throw new Error(`no branch for ${id} ${part ?? ''}`);
  return branch.index;
}

export const voltage = (solution: DcSolution, node: number): number => solution.nodes[2 * node];
export const current = (solution: DcSolution, branch: number): number => solution.branches[2 * branch];

/** Machine epsilon (2⁻⁵²). */
const EPS = Number.EPSILON;

/**
 * A branch's rounding term in the floor policy (plan F2.2, decided in the #46 review):
 * 16 · ε · |y_b| · (|V_a| + |V_b|). A resistor's current is g · (Va − Vb) from node voltages known only
 * to an ulp, so it carries about g · ulp(V) of rounding however exact the solve. Sources stamp no
 * admittance between their ends (their current is an unknown or exact), so their term is 0.
 */
export function branchRounding(netlist: Netlist, values: DcBranchValues, solution: DcSolution, branch: number): number {
  if (values.stamps[branch] !== DC_STAMP_RESISTOR) return 0;
  const { a, b } = netlist.branches[branch];
  const y = 1 / values.ohms[branch];
  return 16 * EPS * y * (Math.abs(voltage(solution, a)) + Math.abs(voltage(solution, b)));
}

/**
 * The KCL floor at each node of an island: 1e-9 · max|I| + 1e-12 A + the island's rounding: the sum
 * over its branches (each node's `gmin` to the reference included) of their g · ulp(V) terms.
 *
 * Island-wide, not per node, because Gaussian elimination's residual is normwise (|L||U|, not |A|):
 * a weak node's row can carry a stiff neighbour's rounding through the multipliers or through a
 * source current set by the neighbour's row. Seed −710639118 (#46): a 0 V ideal source joins a node
 * held by 10 kΩ to one carrying 1e4 S at 21 V, and the source's current carries that row's
 * ε · 1e4 · 21 ≈ 5e-11 A into the weak node, 27× a per-node floor. The same reasoning covers the
 * nodes whose own KCL isn't a row (the eliminated reference, a floating component's representative):
 * their imbalance is minus the sum of the rows that imply them.
 */
export function kclFloors(
  netlist: Netlist,
  values: DcBranchValues,
  solution: DcSolution,
  island: NetlistIsland,
): Map<number, number> {
  const reference = solution.islands[island.index].referenceNode;
  const gmin = GMIN_S.value;
  let maxI = 0;
  // Each branch's term counts at both its ends, as it would per node; the floor is their island sum.
  let rounding = 0;
  for (const node of island.nodes) {
    if (node === reference) continue;
    const v = Math.abs(voltage(solution, node));
    maxI = Math.max(maxI, gmin * v);
    rounding += 2 * 16 * EPS * gmin * v;
  }
  const conductance = new Map<number, number>(island.nodes.map((n) => [n, gmin]));
  let sourceScale = 0;
  for (const index of island.branches) {
    maxI = Math.max(maxI, Math.abs(current(solution, index)));
    rounding += 2 * branchRounding(netlist, values, solution, index);
    const { a, b } = netlist.branches[index];
    if (values.stamps[index] === DC_STAMP_RESISTOR) {
      conductance.set(a, (conductance.get(a) ?? 0) + 1 / values.ohms[index]);
      conductance.set(b, (conductance.get(b) ?? 0) + 1 / values.ohms[index]);
    } else if (netlist.branches[index].kind === 'vsource') {
      sourceScale = Math.max(sourceScale, sourceRowTerm(netlist, values, solution, index));
    }
  }
  // Elimination mixes the source rows (volts) into the KCL rows (amps) through the conductances, so a
  // KCL row can carry a source row's rounding times a node's conductance (seed 1369986703: an ideal
  // 28 650 V source off a 1 S node leaves ε · 28 650 · 1 ≈ 6e-12 A where the node voltages are 3e-8 V).
  const stiffest = Math.max(...conductance.values());
  rounding += 2 * 16 * EPS * sourceScale * stiffest;
  const floor = 1e-9 * maxI + 1e-12 + rounding;
  return new Map<number, number>(island.nodes.map((n) => [n, floor]));
}

/**
 * KCL at every node of a solved island: current leaving through each element, plus `gmin` from each
 * non-reference node to the reference (which the reference receives). Returns the worst ratio of a
 * node's |imbalance| to its floor (`kclFloors`): KCL holds when it is ≤ 1.
 */
export function kcl(netlist: Netlist, values: DcBranchValues, solution: DcSolution, island: NetlistIsland): number {
  const reference = solution.islands[island.index].referenceNode;
  const gmin = GMIN_S.value;
  const sum = new Map<number, number>(island.nodes.map((n) => [n, 0]));
  const add = (node: number, x: number) => sum.set(node, (sum.get(node) ?? 0) + x);
  for (const node of island.nodes) {
    if (node === reference) continue;
    const i = gmin * voltage(solution, node);
    add(node, i);
    add(reference, -i);
  }
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    const i = current(solution, index);
    add(branch.a, i);
    add(branch.b, -i);
  }
  const floors = kclFloors(netlist, values, solution, island);
  let worst = 0;
  for (const [node, value] of sum) worst = Math.max(worst, Math.abs(value) / (floors.get(node) ?? 1));
  return worst;
}

/**
 * Power over a solved island: what the sources deliver, what the resistances (and each source's own
 * series resistance) and `gmin` dissipate, the sum of every term's magnitude (the scale for the 1e-9
 * relative bound, since sources can absorb as well as deliver), and the KCL floor carried through
 * Tellegen's theorem: delivered − dissipated = Σ V(n) · (KCL imbalance at n), so up to
 * Σ |V(n)| · floor(n) of imbalance is rounding, not physics.
 */
export function power(
  netlist: Netlist,
  values: DcBranchValues,
  solution: DcSolution,
  island: NetlistIsland,
): { delivered: number; dissipated: number; scale: number; floor: number } {
  let delivered = 0;
  let dissipated = 0;
  let scale = 0;
  const reference = solution.islands[island.index].referenceNode;
  for (const node of island.nodes) {
    if (node === reference) continue;
    const v = voltage(solution, node);
    const p = GMIN_S.value * v * v;
    dissipated += p;
    scale += p;
  }
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    const i = current(solution, index);
    const va = voltage(solution, branch.a);
    const vb = voltage(solution, branch.b);
    const stamp = values.stamps[index];
    if (stamp === DC_STAMP_RESISTOR) {
      const p = i * i * values.ohms[index];
      dissipated += p;
      scale += p;
    } else if (stamp === DC_STAMP_VSOURCE) {
      const source = values.emfV[index] * i;
      const loss = i * i * values.ohms[index];
      delivered += source;
      dissipated += loss;
      scale += Math.abs(source) + loss;
    } else if (stamp === DC_STAMP_ISOURCE) {
      const p = i * (vb - va);
      delivered += p;
      scale += Math.abs(p);
    }
  }
  let floor = 0;
  for (const [node, f] of kclFloors(netlist, values, solution, island)) {
    floor += Math.abs(voltage(solution, node)) * f;
  }
  return { delivered, dissipated, scale, floor };
}

/*
 * Error-free transformations (Knuth's TwoSum; Dekker's split and TwoProduct), with + − × only, so a
 * residual is accumulated almost exactly: a residual computed in plain double is itself ε·|A||x̂|,
 * the size of what it measures.
 */
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}
const SPLITTER = 134217729; // 2^27 + 1
function split(a: number): [number, number] {
  const c = SPLITTER * a;
  const hi = c - (c - a);
  return [hi, a - hi];
}
function twoProduct(a: number, b: number): [number, number] {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, al * bl - (p - ah * bh - al * bh - ah * bl)];
}

/** A compensated accumulator (sum and running error). */
class Accumulator {
  private hi = 0;
  private lo = 0;
  add(x: number): void {
    const [s, e] = twoSum(this.hi, x);
    this.hi = s;
    this.lo += e;
  }
  /** Adds a · (x − y), nearly exactly. */
  addScaledDifference(a: number, x: number, y: number): void {
    const [d, de] = twoSum(x, -y);
    const [p, pe] = twoProduct(a, d);
    this.add(p);
    this.add(pe);
    this.add(a * de);
  }
  /** Adds a · x, nearly exactly. */
  addProduct(a: number, x: number): void {
    const [p, pe] = twoProduct(a, x);
    this.add(p);
    this.add(pe);
  }
  get value(): number {
    return this.hi + this.lo;
  }
}

/** A source's row minus its value: Vb − Va + R I − E in voltage mode, I − amps in current mode. */
function sourceResidual(netlist: Netlist, values: DcBranchValues, s: DcSolution, index: number): number {
  const { a, b } = netlist.branches[index];
  const acc = new Accumulator();
  if (values.stamps[index] === DC_STAMP_VSOURCE) {
    if (a !== b) acc.addScaledDifference(1, voltage(s, b), voltage(s, a));
    acc.addProduct(values.ohms[index], current(s, index));
    acc.add(-values.emfV[index]);
  } else {
    acc.add(current(s, index));
    acc.add(-values.amps[index]);
  }
  return acc.value;
}

/**
 * The source rows of a solved island: each source element's equation (Vb − Va + R I = E, or I =
 * amps) holds within 1e-9 · T + 1e-12 + 16 ε t, where t is the row's |Va| + |Vb| + |R I| + |E| (or
 * |I| + |amps|) and T the island's largest t: the voltage-side counterpart of KCL's
 * 1e-9 · max|I| + 1e-12 A. Returns the worst ratio of |residual| to its bound (≤ 1 holds). Together
 * with KCL it checks every row of the system, so a solve that is wrong in any equation fails here,
 * and superposition's forward-error bound can't absorb a model error.
 */
export function sourceRows(
  netlist: Netlist,
  values: DcBranchValues,
  solution: DcSolution,
  island: NetlistIsland,
): number {
  const term = (index: number) => {
    const { a, b } = netlist.branches[index];
    const i = current(solution, index);
    if (values.stamps[index] === DC_STAMP_VSOURCE) {
      return (
        Math.abs(voltage(solution, a)) +
        Math.abs(voltage(solution, b)) +
        Math.abs(values.ohms[index] * i) +
        Math.abs(values.emfV[index])
      );
    }
    return Math.abs(i) + Math.abs(values.amps[index]);
  };
  const sources = island.branches.filter((index) => netlist.branches[index].kind === 'vsource');
  const largest = sources.reduce((m, index) => Math.max(m, term(index)), 0);
  let worst = 0;
  for (const index of sources) {
    const bound = sourceRowBound(netlist, values, solution, index, largest);
    worst = Math.max(worst, Math.abs(sourceResidual(netlist, values, solution, index)) / bound);
  }
  return worst;
}

/** |Va| + |Vb| + |R I| + |E| for a voltage-mode source row, |I| + |amps| for a current-mode one. */
function sourceRowTerm(netlist: Netlist, values: DcBranchValues, solution: DcSolution, index: number): number {
  const { a, b } = netlist.branches[index];
  const i = current(solution, index);
  if (values.stamps[index] === DC_STAMP_VSOURCE) {
    return (
      Math.abs(voltage(solution, a)) +
      Math.abs(voltage(solution, b)) +
      Math.abs(values.ohms[index] * i) +
      Math.abs(values.emfV[index])
    );
  }
  return Math.abs(i) + Math.abs(values.amps[index]);
}

/** A source row's bound: 1e-9 · the island's largest row term + 1e-12 + 16 ε · its own. */
function sourceRowBound(
  netlist: Netlist,
  values: DcBranchValues,
  solution: DcSolution,
  index: number,
  largest: number,
): number {
  return 1e-9 * largest + 1e-12 + 16 * EPS * sourceRowTerm(netlist, values, solution, index);
}

/** One solve in a linear combination d = Σ coefficient · x̂. */
export interface Combined {
  readonly values: DcBranchValues;
  readonly solution: DcSolution;
  readonly coefficient: number;
}

/**
 * Linearity and superposition in residual space (floor policy, plan F2.2). For d = Σ c_p x̂_p (with
 * Σ c_p b_p = 0: k · x̂(b) against x̂(k b), or x̂(first) + x̂(second) against x̂(all)), every row of
 * the system applied to d is the same combination of each solve's own residual in that row, plus
 * the rounding of forming d. So, once each solve has passed KCL and its source rows (`kcl`,
 * `sourceRows`), each row of d must hold within Σ |c_p| × that solve's bound, plus 4 ε Σ |c_p| ×
 * the row's terms. It also checks that the right-hand sides cancel: a source's Σ c_p E_p must be 0.
 *
 * Values are not compared: a value comparison measures forward error, the residual times |A⁻¹|,
 * which near-ideal source loops held by weak ties make unbounded by any local or measured floor
 * (CI on `48faae4`: 7.3e-8 V from 7e4 A circulating against a 1e-4 S tie). Linearity by a power of
 * two is checked on values, exactly. Returns the worst ratio of a row's |residual| to its bound.
 */
export function linearResidual(netlist: Netlist, parts: readonly Combined[]): number {
  const gmin = GMIN_S.value;
  let worst = 0;
  const combine = (get: (s: DcSolution) => number) => {
    const acc = new Accumulator();
    for (const p of parts) acc.addProduct(p.coefficient, get(p.solution));
    return acc.value;
  };
  for (const island of netlist.islands) {
    const first = parts[0].solution.islands[island.index];
    if (!first.solved || (first.flags & ISLAND_FLAG_SINGULAR) !== 0) continue;
    const reference = first.referenceNode;
    // KCL of d, with the island-wide floors of each solve.
    const floors = parts.map((p) => kclFloors(netlist, p.values, p.solution, island).get(reference) ?? 0);
    let scale = 0;
    for (const p of parts) {
      let t = 0;
      for (const index of island.branches) t += Math.abs(current(p.solution, index));
      for (const node of island.nodes) t += gmin * Math.abs(voltage(p.solution, node));
      scale += Math.abs(p.coefficient) * t;
    }
    const kclBound = parts.reduce((f, p, j) => f + Math.abs(p.coefficient) * floors[j], 0) + 4 * EPS * scale;
    const sum = new Map<number, Accumulator>(island.nodes.map((n) => [n, new Accumulator()]));
    for (const node of island.nodes) {
      if (node === reference) continue;
      const i = gmin * combine((s) => voltage(s, node));
      sum.get(node)?.add(i);
      sum.get(reference)?.add(-i);
    }
    for (const index of island.branches) {
      const { a, b } = netlist.branches[index];
      if (a === b) continue;
      const i = combine((s) => current(s, index));
      sum.get(a)?.add(i);
      sum.get(b)?.add(-i);
    }
    for (const acc of sum.values()) worst = Math.max(worst, Math.abs(acc.value) / kclBound);
    // Each source row of d.
    const largest = parts.map((p) =>
      island.branches
        .filter((index) => netlist.branches[index].kind === 'vsource')
        .reduce((m, index) => Math.max(m, sourceRowTerm(netlist, p.values, p.solution, index)), 0),
    );
    for (const index of island.branches) {
      if (netlist.branches[index].kind !== 'vsource') continue;
      const { a, b } = netlist.branches[index];
      const acc = new Accumulator();
      const voltageMode = parts[0].values.stamps[index] === DC_STAMP_VSOURCE;
      for (const p of parts) {
        const c = p.coefficient;
        if (voltageMode) {
          if (a !== b) {
            acc.addProduct(c, voltage(p.solution, b));
            acc.addProduct(-c, voltage(p.solution, a));
          }
          acc.addProduct(c * p.values.ohms[index], current(p.solution, index));
          acc.addProduct(-c, p.values.emfV[index]);
        } else {
          acc.addProduct(c, current(p.solution, index));
          acc.addProduct(-c, p.values.amps[index]);
        }
      }
      const bound = parts.reduce(
        (f, p, j) =>
          f +
          Math.abs(p.coefficient) *
            (sourceRowBound(netlist, p.values, p.solution, index, largest[j]) +
              4 * EPS * sourceRowTerm(netlist, p.values, p.solution, index)),
        0,
      );
      worst = Math.max(worst, Math.abs(acc.value) / bound);
    }
  }
  return worst;
}
