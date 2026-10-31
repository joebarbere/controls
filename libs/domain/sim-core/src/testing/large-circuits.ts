import { dcBranchValues, type DcBranchValues } from '../lib/mna/values';
import type { Netlist } from '../lib/netlist/types';
import { syntheticNetlist, type SyntheticBranch } from './mna';

/*
 * Large synthetic DC circuits for the sparse-LU specs (F2.2 part 3): plant-like islands of tens to
 * hundreds of nodes, so the sparse path is exercised at and above `SPARSE_MIN_UNKNOWNS`. Each island
 * is a random tree (mostly radial feeders, with some long chains) closed into loops by extra
 * elements, holding resistors, voltage sources (some ideal), current sources on resistor elements and
 * `vsource` elements in current limit. Current sources only ever join two nodes the tree already
 * connects, so no node hangs on gmin alone.
 *
 * `wellConditioned` restricts the values to the subset where comparing two solvers' values is
 * meaningful (plan F2.2 floor policy): resistances 1 Ω–10 kΩ, every source behind at least 0.1 Ω, so
 * there are no near-ideal source loops and no busbar-scale conductances. Elsewhere resistances run
 * from 0.1 mΩ and a third of the voltage sources are ideal.
 *
 * Deterministic from `seed` (xorshift32, integer operations only), so a fast-check draw of a few
 * integers names a whole circuit and the arbitraries stay at module level.
 */

export interface LargeCircuitSpec {
  /** Nodes in the whole netlist (≥ 2). */
  readonly nodes: number;
  /** Islands it is split into (1–4). */
  readonly islands: number;
  readonly seed: number;
  /** Extra loop-closing elements per 100 nodes (0–30). */
  readonly meshPercent: number;
  readonly wellConditioned: boolean;
}

export interface LargeCircuit {
  readonly netlist: Netlist;
  readonly values: DcBranchValues;
}

/** xorshift32: integer-only, the same sequence in every runtime. */
class Xorshift {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0 || 0x9e3779b9;
  }
  /** An integer in [0, n). */
  below(n: number): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) % n;
  }
}

const DECADES = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1e3, 1e4];
const WELL_DECADES = [1, 10, 100, 1e3];

type Stamp = { kind: 'r'; ohms: number } | { kind: 'v'; emf: number; ohms: number } | { kind: 'i'; amps: number };

/** Builds the circuit `spec` names. */
export function largeCircuit(spec: LargeCircuitSpec): LargeCircuit {
  const rng = new Xorshift(spec.seed);
  const n = Math.max(2, spec.nodes);
  const groups = Math.max(1, Math.min(spec.islands, Math.floor(n / 2)));
  const start = (g: number) => Math.floor((g * n) / groups);
  const decades = spec.wellConditioned ? WELL_DECADES : DECADES;
  const ohms = () => (1 + rng.below(9000) / 1000) * decades[rng.below(decades.length)];
  const emf = () => (rng.below(9601) - 4800) / 100;
  // Non-ideal sources keep at least 1e-4 Ω, the plan's smallest generated resistance (F2.2).
  const sourceOhms = () =>
    spec.wellConditioned ? 0.1 + rng.below(1000) / 100 : rng.below(3) === 0 ? 0 : Math.max(1e-4, ohms() / 100);
  const edges: SyntheticBranch[] = [];
  const stamps: Stamp[] = [];
  const push = (a: number, b: number, stamp: Stamp) => {
    edges.push({
      a,
      b,
      kind: stamp.kind === 'v' || (stamp.kind === 'i' && rng.below(2) === 0) ? 'vsource' : 'resistor',
    });
    stamps.push(stamp);
  };
  for (let g = 0; g < groups; g++) {
    const first = start(g);
    const end = g + 1 < groups ? start(g + 1) : n;
    // One source at the root of each feeder tree, then a tree of mostly resistors.
    for (let node = first + 1; node < end; node++) {
      // Half the time the newest node (a chain), else any earlier node of the group (radial fan-out).
      const parent = rng.below(2) === 0 ? node - 1 : first + rng.below(node - first);
      const roll = rng.below(20);
      const stamp: Stamp =
        roll < 2 || node === first + 1 ? { kind: 'v', emf: emf(), ohms: sourceOhms() } : { kind: 'r', ohms: ohms() };
      if (rng.below(2) === 0) push(parent, node, stamp);
      else push(node, parent, stamp);
    }
    // Loops, current sources and the odd self-loop, all inside the group.
    const size = end - first;
    const extra = Math.floor((size * spec.meshPercent) / 100);
    for (let e = 0; e < extra; e++) {
      const a = first + rng.below(size);
      const b = rng.below(25) === 0 ? a : first + rng.below(size);
      const roll = rng.below(10);
      if (roll < 6) push(a, b, { kind: 'r', ohms: ohms() });
      else if (roll < 8) push(a, b, { kind: 'v', emf: emf(), ohms: sourceOhms() });
      else push(a, b, { kind: 'i', amps: emf() / 10 });
    }
  }
  const netlist = syntheticNetlist(n, edges);
  const values = dcBranchValues(netlist, (branch, v) => {
    const stamp = stamps[branch.index];
    if (stamp.kind === 'r') v.resistor(branch.index, stamp.ohms);
    else if (stamp.kind === 'v') v.vsource(branch.index, stamp.emf, stamp.ohms);
    else v.isource(branch.index, stamp.amps);
    return true;
  });
  return { netlist, values };
}

/** The number of MNA unknowns of each island: its nodes but the reference, plus its `vsource` elements. */
export function islandUnknowns(netlist: Netlist): number[] {
  return netlist.islands.map(
    (island) => island.nodes.length - 1 + island.branches.filter((b) => netlist.branches[b].kind === 'vsource').length,
  );
}
