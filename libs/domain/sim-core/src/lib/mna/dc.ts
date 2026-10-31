import { GMIN_S } from '../constants';
import { DenseLu } from '../lu/dense-lu';
import type { Netlist, NetlistIsland } from '../netlist/types';
import { DC_STAMP_ISOURCE, DC_STAMP_RESISTOR, DC_STAMP_UNSET, DC_STAMP_VSOURCE, type DcBranchValues } from './values';

/*
 * Dense DC modified nodal analysis (plan F2.2 part 1), reimplemented from the published formulation
 * (C.-W. Ho, A. E. Ruehli and P. A. Brennan, "The Modified Nodal Approach to Network Analysis", IEEE
 * Trans. Circuits and Systems 22(6), 1975): no third-party code.
 *
 * Each island is solved on its own, against its own reference node, which is eliminated. Unknowns,
 * in this order:
 *
 * 1. the voltage of every other node of the island, in ascending node order;
 * 2. the current of every `vsource` element of the island, in ascending branch order.
 *
 * Rows are KCL at each non-reference node (current leaving through every element, plus `gmin` to the
 * reference, is zero), then one row per `vsource` element: Vb − Va + R·I = E, or I = amps while it is
 * stamped as a current source. The layout depends only on the topology, never on values.
 *
 * Singular islands: with `gmin` on every node and R ≥ 0 the matrix is singular exactly when the
 * island's zero-ohm voltage sources contain a loop (two ideal sources in parallel, or one shorted by
 * a closed switch): then xᵀMx = Vᵀ G V + Iᵀ R I vanishes only for a circulating current through those
 * sources. The solver checks that structurally, with a union-find, before any arithmetic, so the
 * flag never depends on a pivot tolerance. As a backstop, a zero or non-finite pivot or a non-finite
 * result flags the island too. A singular island's values are all +0, never NaN.
 */

/** Island flag bits, as in the snapshot's island entry (ADR 0011 §5.3). */
export const ISLAND_FLAG_SINGULAR = 1;
export const ISLAND_FLAG_NON_CONVERGED = 2;

/** One island's result. */
export interface DcIslandResult {
  /** Whether the DC solver solved it: `dc` and `empty` islands. `ac` and `mixed` islands are F2.2 part 2's. */
  solved: boolean;
  /** The solver's ground for this island: its node voltages are against this node, whose own is 0. */
  referenceNode: number;
  /** The order of the island's MNA system. */
  unknowns: number;
  /** `ISLAND_FLAG_*` bits. */
  flags: number;
  /** Outer-loop iterations of the last solve: 1 for a linear solve, 0 when not solved. */
  iterations: number;
}

/**
 * A DC solution, in the netlist's canonical order, so it maps directly onto `WorldV2.sim` and the
 * snapshot payload (ADR 0011 §5.3 and §9.6). Every value is finite and `-0` is `+0`.
 */
export interface DcSolution {
  /** The netlist it solves. */
  topologyHash: string;
  /** Node voltages in V against the island's reference, `re, im` interleaved (`im` is 0 for DC). */
  readonly nodes: Float64Array;
  /** Branch currents in A, positive from end `a` to end `b`, `re, im` interleaved. */
  readonly branches: Float64Array;
  readonly islands: DcIslandResult[];
}

/** An empty solution sized for `netlist`. */
export function createDcSolution(netlist: Netlist): DcSolution {
  return {
    topologyHash: netlist.topologyHash,
    nodes: new Float64Array(2 * netlist.nodes.length),
    branches: new Float64Array(2 * netlist.branches.length),
    islands: netlist.islands.map(() => ({ solved: false, referenceNode: -1, unknowns: 0, flags: 0, iterations: 0 })),
  };
}

function fits(solution: DcSolution, netlist: Netlist): boolean {
  return (
    solution.nodes.length === 2 * netlist.nodes.length &&
    solution.branches.length === 2 * netlist.branches.length &&
    solution.islands.length === netlist.islands.length
  );
}

/**
 * An island's reference node: the negative end (`a`) of its lowest-numbered `vsource` element, or
 * its smallest node if it has none. A pure function of the topology. For a floating DC island with
 * one source that is its most negative source terminal (ADR 0011 §5.3).
 */
export function islandReferenceNode(netlist: Netlist, island: NetlistIsland): number {
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    if (branch.kind === 'vsource') return branch.a;
  }
  return island.nodes[0];
}

/** `+0` for `-0`, so every stored value has one bit pattern. */
const positiveZero = (x: number): number => (x === 0 ? 0 : x);

/**
 * Solves netlists' DC islands. Reuse one solver: its LU storage and index maps grow to the largest
 * system seen and are then reused, so a steady-state solve allocates nothing. Reuse never changes a
 * result: every solve is a pure function of the netlist and the values.
 */
export class DcSolver {
  private readonly lu = new DenseLu();
  /** Node → its unknown in the current island, or −1 for the reference. */
  private nodeUnknown = new Int32Array(0);
  /** Branch → its current unknown in the current island, or −1. */
  private branchUnknown = new Int32Array(0);
  /** Union-find parents over node indices, for the zero-ohm source loop check. */
  private parent = new Int32Array(0);
  private rhs = new Float64Array(0);

  /**
   * Solves every `dc` and `empty` island of `netlist` with `values`, into `out` if it fits (else a
   * new solution). `ac` and `mixed` islands are left at zero, `solved: false`. Throws on a missing
   * value or a stamp that doesn't suit its element kind (a programming error).
   */
  solve(netlist: Netlist, values: DcBranchValues, out?: DcSolution): DcSolution {
    if (values.count !== netlist.branches.length) {
      throw new RangeError(`DcSolver: ${values.count} values for ${netlist.branches.length} branches`);
    }
    const solution = out !== undefined && fits(out, netlist) ? out : createDcSolution(netlist);
    solution.topologyHash = netlist.topologyHash;
    if (this.nodeUnknown.length < netlist.nodes.length) {
      this.nodeUnknown = new Int32Array(netlist.nodes.length);
      this.parent = new Int32Array(netlist.nodes.length);
    }
    if (this.branchUnknown.length < netlist.branches.length)
      this.branchUnknown = new Int32Array(netlist.branches.length);
    for (const island of netlist.islands) this.solveIsland(netlist, island, values, solution);
    return solution;
  }

  private solveIsland(netlist: Netlist, island: NetlistIsland, values: DcBranchValues, solution: DcSolution): void {
    const result = solution.islands[island.index];
    const reference = islandReferenceNode(netlist, island);
    result.referenceNode = reference;
    const dc = island.kind === 'dc' || island.kind === 'empty';
    result.solved = dc;
    result.flags = 0;
    result.iterations = dc ? 1 : 0;
    if (!dc) {
      result.unknowns = 0;
      this.zero(netlist, island, solution);
      return;
    }

    // Layout: node unknowns, then vsource current unknowns.
    const nodeUnknown = this.nodeUnknown;
    const branchUnknown = this.branchUnknown;
    let n = 0;
    for (const node of island.nodes) nodeUnknown[node] = node === reference ? -1 : n++;
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const stamp = values.stamps[index];
      if (stamp === DC_STAMP_UNSET) throw new Error(`DcSolver: branch ${index} has no DC value`);
      if (branch.kind === 'vsource') {
        if (stamp === DC_STAMP_RESISTOR) throw new Error(`DcSolver: vsource branch ${index} stamped as a resistor`);
        branchUnknown[index] = n++;
      } else {
        if (stamp === DC_STAMP_VSOURCE) throw new Error(`DcSolver: resistor branch ${index} stamped as a vsource`);
        branchUnknown[index] = -1;
      }
    }
    result.unknowns = n;

    if (this.hasIdealSourceLoop(netlist, island, values)) {
      this.singular(netlist, island, solution, result);
      return;
    }

    const a = this.lu.begin(n);
    if (this.rhs.length < n) this.rhs = new Float64Array(n);
    const rhs = this.rhs;
    rhs.fill(0, 0, n);
    const gmin = GMIN_S.value;
    for (const node of island.nodes) {
      const i = nodeUnknown[node];
      if (i >= 0) a[i * n + i] += gmin;
    }
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const ia = nodeUnknown[branch.a];
      const ib = nodeUnknown[branch.b];
      const stamp = values.stamps[index];
      const k = branchUnknown[index];
      if (k >= 0) {
        // KCL: the source's current I leaves `a` and enters `b`.
        if (branch.a !== branch.b) {
          if (ia >= 0) a[ia * n + k] += 1;
          if (ib >= 0) a[ib * n + k] -= 1;
        }
        if (stamp === DC_STAMP_VSOURCE) {
          // Vb − Va + R·I = E.
          if (branch.a !== branch.b) {
            if (ib >= 0) a[k * n + ib] += 1;
            if (ia >= 0) a[k * n + ia] -= 1;
          }
          a[k * n + k] = values.ohms[index];
          rhs[k] = values.emfV[index];
        } else {
          // Current limit: I = amps.
          a[k * n + k] = 1;
          rhs[k] = values.amps[index];
        }
      } else if (branch.a !== branch.b) {
        if (stamp === DC_STAMP_RESISTOR) {
          const g = 1 / values.ohms[index];
          if (ia >= 0) a[ia * n + ia] += g;
          if (ib >= 0) a[ib * n + ib] += g;
          if (ia >= 0 && ib >= 0) {
            a[ia * n + ib] -= g;
            a[ib * n + ia] -= g;
          }
        } else {
          // A current source on a resistor element: amps leave `a` and enter `b`.
          const amps = values.amps[index];
          if (ia >= 0) rhs[ia] -= amps;
          if (ib >= 0) rhs[ib] += amps;
        }
      }
    }

    if (!this.lu.factor()) {
      this.singular(netlist, island, solution, result);
      return;
    }
    this.lu.solve(rhs);

    const nodes = solution.nodes;
    const branches = solution.branches;
    let ok = true;
    for (const node of island.nodes) {
      const i = nodeUnknown[node];
      const v = i >= 0 ? positiveZero(rhs[i]) : 0;
      if (!Number.isFinite(v)) ok = false;
      nodes[2 * node] = v;
      nodes[2 * node + 1] = 0;
    }
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const k = branchUnknown[index];
      let current: number;
      if (k >= 0) current = rhs[k];
      else if (values.stamps[index] === DC_STAMP_ISOURCE) current = values.amps[index];
      else current = (nodes[2 * branch.a] - nodes[2 * branch.b]) * (1 / values.ohms[index]);
      current = positiveZero(current);
      if (!Number.isFinite(current)) ok = false;
      branches[2 * index] = current;
      branches[2 * index + 1] = 0;
    }
    if (!ok) this.singular(netlist, island, solution, result);
  }

  /** Whether the island's zero-ohm voltage sources close a loop (a self-loop included). */
  private hasIdealSourceLoop(netlist: Netlist, island: NetlistIsland, values: DcBranchValues): boolean {
    const parent = this.parent;
    for (const node of island.nodes) parent[node] = node;
    for (const index of island.branches) {
      if (values.stamps[index] !== DC_STAMP_VSOURCE || values.ohms[index] !== 0) continue;
      const branch = netlist.branches[index];
      const ra = this.find(branch.a);
      const rb = this.find(branch.b);
      if (ra === rb) return true;
      // Union by the smaller root, so the structure is a pure function of the branch order.
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
    return false;
  }

  private find(x: number): number {
    const parent = this.parent;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  private singular(netlist: Netlist, island: NetlistIsland, solution: DcSolution, result: DcIslandResult): void {
    result.flags |= ISLAND_FLAG_SINGULAR;
    this.zero(netlist, island, solution);
  }

  private zero(netlist: Netlist, island: NetlistIsland, solution: DcSolution): void {
    for (const node of island.nodes) {
      solution.nodes[2 * node] = 0;
      solution.nodes[2 * node + 1] = 0;
    }
    for (const index of island.branches) {
      solution.branches[2 * index] = 0;
      solution.branches[2 * index + 1] = 0;
    }
  }
}

/** Solves `netlist`'s DC islands with a fresh solver: a convenience for scripts and tests. */
export function solveDc(netlist: Netlist, values: DcBranchValues): DcSolution {
  return new DcSolver().solve(netlist, values);
}
