import { GMIN_S } from '../lib/constants';
import type { DcSolution } from '../lib/mna/dc';
import { DC_STAMP_ISOURCE, DC_STAMP_RESISTOR, DC_STAMP_VSOURCE, type DcBranchValues } from '../lib/mna/values';
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
  return { nodes, branches: netBranches, islands, devices: [], topologyHash: 'synthetic', diagnostics: [] };
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
 * The KCL floor at each node of an island: 1e-9 · max|I| + 1e-12 A + the rounding term of every
 * branch at the node, each node's `gmin` to the reference included. The reference node also gets
 * the sum of every other node's terms (see below).
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
  const rounding = new Map<number, number>(island.nodes.map((n) => [n, 0]));
  const add = (node: number, x: number) => rounding.set(node, (rounding.get(node) ?? 0) + x);
  for (const node of island.nodes) {
    if (node === reference) continue;
    const v = Math.abs(voltage(solution, node));
    maxI = Math.max(maxI, gmin * v);
    add(node, 16 * EPS * gmin * v);
    add(reference, 16 * EPS * gmin * v);
  }
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    maxI = Math.max(maxI, Math.abs(current(solution, index)));
    const r = branchRounding(netlist, values, solution, index);
    add(branch.a, r);
    if (branch.b !== branch.a) add(branch.b, r);
  }
  // The reference node's KCL is not a row of the system (it is eliminated): it is identically minus
  // the sum of every other node's KCL, so its imbalance is minus the sum of theirs, and the rounding
  // the other rows leave reaches it through the source currents. Its floor carries their terms.
  let others = 0;
  for (const [node, r] of rounding) if (node !== reference) others += r;
  rounding.set(reference, (rounding.get(reference) ?? 0) + others);
  const floors = new Map<number, number>();
  for (const [node, r] of rounding) floors.set(node, 1e-9 * maxI + 1e-12 + r);
  return floors;
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
