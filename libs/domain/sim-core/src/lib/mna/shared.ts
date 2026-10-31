import { amdOrder } from '../lu/amd';
import type { Netlist, NetlistIsland } from '../netlist/types';
import type { IslandSymbolic } from './factorisation-cache';

/*
 * Pieces the DC (`dc.ts`) and phasor (`ac.ts`) solvers share: integer and structural work only, so
 * sharing them can't change a result bit. Internal to `mna/`, not part of the package's API.
 */

/** Union-find root with path halving. */
export function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

/** A recorded stamping: what `buildSymbolic` turns into a pattern, a slot map and a program. */
export interface StampProgram {
  readonly rows: Int32Array;
  readonly cols: Int32Array;
  readonly codes: Uint8Array;
  readonly branches: Int32Array;
  readonly rhsTargets: Int32Array;
  readonly rhsCodes: Uint8Array;
  readonly rhsBranches: Int32Array;
}

export function grow(array: Int32Array): Int32Array<ArrayBuffer> {
  const grown = new Int32Array(2 * array.length);
  grown.set(array);
  return grown;
}

/**
 * A cheap fingerprint of an island's branch ends (Math.imul is exact), so a symbolic factorisation
 * cached under a `topologyHash` that another netlist reuses is refused rather than misapplied.
 */
export function endsChecksum(netlist: Netlist, island: NetlistIsland): number {
  let h = island.nodes.length;
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    h = (Math.imul(h, 31) + branch.a) | 0;
    h = (Math.imul(h, 31) + branch.b) | 0;
  }
  return h;
}

/**
 * Builds a symbolic factorisation from a recorded stamping: the CSC pattern (rows ascending in each
 * column, duplicates merged), each call's slot in it, the AMD order, and the stamp program itself
 * (each call's value code and branch, and the right-hand-side steps), which `assemble` replays in
 * call order, so every entry sums the same terms in the same order as `stamp` would.
 * `factors` is the (empty) numeric factors object the island's factorisations will reuse: real for
 * the DC solver, complex for the phasor solver.
 * Two stable bucket passes (by row, then by column) sort the calls without comparisons.
 */
export function buildSymbolic<F>(
  n: number,
  program: StampProgram,
  signature: Uint8Array,
  comp: Int32Array,
  ends: number,
  factors: F,
): IslandSymbolic<F> {
  const { rows, cols } = program;
  const calls = rows.length;
  // Pass 1: calls bucketed by row (stable).
  const rowStart = new Int32Array(n + 1);
  for (let c = 0; c < calls; c++) rowStart[rows[c] + 1]++;
  for (let i = 0; i < n; i++) rowStart[i + 1] += rowStart[i];
  const byRow = new Int32Array(calls);
  const rowFill = rowStart.slice(0, n);
  for (let c = 0; c < calls; c++) byRow[rowFill[rows[c]]++] = c;
  // Pass 2: those, bucketed by column (stable), so rows ascend within each column.
  const colStart = new Int32Array(n + 1);
  for (let c = 0; c < calls; c++) colStart[cols[c] + 1]++;
  for (let j = 0; j < n; j++) colStart[j + 1] += colStart[j];
  const sorted = new Int32Array(calls);
  const colFill = colStart.slice(0, n);
  for (let t = 0; t < calls; t++) {
    const c = byRow[t];
    sorted[colFill[cols[c]]++] = c;
  }
  // Merge duplicates into slots.
  const colPtr = new Int32Array(n + 1);
  const rowIdxAll = new Int32Array(calls);
  const slots = new Int32Array(calls);
  let nnz = 0;
  for (let j = 0; j < n; j++) {
    colPtr[j] = nnz;
    let lastRow = -1;
    for (let t = colStart[j]; t < colStart[j + 1]; t++) {
      const c = sorted[t];
      const r = rows[c];
      if (r !== lastRow) {
        rowIdxAll[nnz++] = r;
        lastRow = r;
      }
      slots[c] = nnz - 1;
    }
  }
  colPtr[n] = nnz;
  const rowIdx = rowIdxAll.slice(0, nnz);
  const pattern = { n, colPtr, rowIdx };
  return {
    unknowns: n,
    signature,
    pattern,
    slots,
    order: amdOrder(n, colPtr, rowIdx),
    factors,
    codes: program.codes,
    branches: program.branches,
    rhsTargets: program.rhsTargets,
    rhsCodes: program.rhsCodes,
    rhsBranches: program.rhsBranches,
    comp,
    ends,
  };
}
