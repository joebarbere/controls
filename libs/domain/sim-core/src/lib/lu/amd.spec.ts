import fc from 'fast-check';
import { amdOrder } from './amd';

/** A CSC pattern from (row, column) pairs (duplicates allowed), rows ascending per column. */
function csc(n: number, entries: readonly (readonly [number, number])[]): { colPtr: Int32Array; rowIdx: Int32Array } {
  const cols: number[][] = Array.from({ length: n }, () => []);
  for (const [i, j] of entries) if (!cols[j].includes(i)) cols[j].push(i);
  const colPtr = new Int32Array(n + 1);
  const rows: number[] = [];
  cols.forEach((c, j) => {
    c.sort((x, y) => x - y);
    rows.push(...c);
    colPtr[j + 1] = rows.length;
  });
  return { colPtr, rowIdx: Int32Array.from(rows) };
}

/**
 * The entries of L (below the diagonal) when the symmetric pattern of A + Aᵀ is eliminated in
 * `order`: a direct simulation of symbolic Gaussian elimination (each pivot's remaining neighbours
 * become a clique). Test-only, O(n · d²).
 */
function choleskyFill(n: number, entries: readonly (readonly [number, number])[], order: ArrayLike<number>): number {
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (const [i, j] of entries) {
    if (i === j) continue;
    adj[i].add(j);
    adj[j].add(i);
  }
  const done = new Uint8Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    const p = order[k];
    const rest = [...adj[p]].filter((v) => done[v] === 0);
    count += rest.length;
    for (const a of rest) for (const b of rest) if (a !== b) adj[a].add(b);
    done[p] = 1;
  }
  return count;
}

const isPermutation = (order: Int32Array, n: number) =>
  order.length === n && new Set(order).size === n && order.every((v) => v >= 0 && v < n);

const identity = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

// Arbitraries, built once at module level.
const patternArb = fc
  .record({
    n: fc.integer({ min: 1, max: 120 }),
    entries: fc.array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 })), { maxLength: 400 }),
    diagonal: fc.boolean(),
    /** A few rows made dense (degree beyond AMD's dense threshold). */
    dense: fc.array(fc.nat({ max: 10_000 }), { maxLength: 3 }),
  })
  .map(({ n, entries, diagonal, dense }) => {
    const pairs: [number, number][] = entries.map(([i, j]) => [i % n, j % n]);
    if (diagonal) for (let i = 0; i < n; i++) pairs.push([i, i]);
    if (n > 40) for (const d of dense) for (let j = 0; j < n; j++) pairs.push([d % n, j]);
    return { n, pairs };
  });

describe('amdOrder', () => {
  it('returns a permutation, deterministically, for any pattern (unsymmetric, dense rows, empty columns)', () => {
    fc.assert(
      fc.property(patternArb, ({ n, pairs }) => {
        const { colPtr, rowIdx } = csc(n, pairs);
        const order = amdOrder(n, colPtr, rowIdx);
        expect(isPermutation(order, n)).toBe(true);
        expect(amdOrder(n, colPtr, rowIdx)).toStrictEqual(order);
      }),
      { numRuns: 150 },
    );
  });

  it('never makes more fill than the natural order on random sparse patterns, on average far less', () => {
    let amdTotal = 0;
    let naturalTotal = 0;
    for (const { n, pairs } of fc.sample(patternArb, { seed: 20261030, numRuns: 60 })) {
      const { colPtr, rowIdx } = csc(n, pairs);
      amdTotal += choleskyFill(n, pairs, amdOrder(n, colPtr, rowIdx));
      naturalTotal += choleskyFill(n, pairs, identity(n));
    }
    expect(amdTotal).toBeLessThan(0.6 * naturalTotal);
  });

  it('eliminates a tree with no fill, leaves first', () => {
    // A path 0–1–…–49 and a star around node 60, joined: fill-free orders exist; AMD must find one.
    const pairs: [number, number][] = [];
    for (let i = 0; i < 49; i++) pairs.push([i, i + 1]);
    for (let i = 50; i < 80; i++) if (i !== 60) pairs.push([60, i]);
    pairs.push([49, 60]);
    const { colPtr, rowIdx } = csc(80, pairs);
    const order = amdOrder(80, colPtr, rowIdx);
    expect(choleskyFill(80, pairs, order)).toBe(79); // n − 1 edges: exactly the tree, nothing added
  });

  it('orders an arrow matrix hub last (natural order fills completely)', () => {
    // Node 0 is joined to every other node: eliminating it first makes a clique of the rest.
    const n = 30;
    const pairs: [number, number][] = [];
    for (let i = 1; i < n; i++) pairs.push([0, i], [i, 0], [i, i]);
    const { colPtr, rowIdx } = csc(n, pairs);
    const order = amdOrder(n, colPtr, rowIdx);
    // Once one leaf is left, it and the hub tie (degree 1): either order is fill-free.
    expect([...order.slice(n - 2)]).toContain(0);
    expect(choleskyFill(n, pairs, order)).toBe(n - 1);
    expect(choleskyFill(n, pairs, identity(n))).toBe(((n - 1) * n) / 2);
  });

  it('orders a 2-D grid with well under half the natural (banded) fill', () => {
    const k = 16;
    const pairs: [number, number][] = [];
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) {
        const v = r * k + c;
        if (c + 1 < k) pairs.push([v, v + 1]);
        if (r + 1 < k) pairs.push([v, v + k]);
      }
    }
    const { colPtr, rowIdx } = csc(k * k, pairs);
    const amd = choleskyFill(k * k, pairs, amdOrder(k * k, colPtr, rowIdx));
    const natural = choleskyFill(k * k, pairs, identity(k * k));
    expect(amd).toBeLessThan(0.5 * natural);
  });

  it('puts dense rows last, ascending, and merges indistinguishable variables', () => {
    // 200 nodes each joined to nodes 7 and 150 (dense: degree 199 > 10·√200 ≈ 141), plus a path.
    const n = 200;
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (i !== 7) pairs.push([7, i]);
      if (i !== 150) pairs.push([150, i]);
      if (i + 1 < n) pairs.push([i, i + 1]);
    }
    const { colPtr, rowIdx } = csc(n, pairs);
    const order = amdOrder(n, colPtr, rowIdx);
    expect([...order.slice(n - 2)]).toStrictEqual([7, 150]);
    expect(isPermutation(order, n)).toBe(true);
    // A complete bipartite K(3, 40): the 40 are indistinguishable and become one supervariable.
    const bip: [number, number][] = [];
    for (let a = 0; a < 3; a++) for (let b = 3; b < 43; b++) bip.push([a, b]);
    const g = csc(43, bip);
    const bipOrder = amdOrder(43, g.colPtr, g.rowIdx);
    expect(isPermutation(bipOrder, 43)).toBe(true);
    expect(choleskyFill(43, bip, bipOrder)).toBeLessThanOrEqual(choleskyFill(43, bip, identity(43)));
  });

  it('handles n = 0 and isolated variables', () => {
    expect(amdOrder(0, new Int32Array(1), new Int32Array(0))).toStrictEqual(new Int32Array(0));
    const { colPtr, rowIdx } = csc(3, [[1, 1]]);
    expect(isPermutation(amdOrder(3, colPtr, rowIdx), 3)).toBe(true);
  });
});
