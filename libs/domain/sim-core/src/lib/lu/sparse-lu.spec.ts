import fc from 'fast-check';
import { PIVOT_THRESHOLD } from '../constants';
import { amdOrder } from './amd';
import { DenseLu } from './dense-lu';
import { type CscPattern, SparseFactors, SparseLu } from './sparse-lu';

/** A CSC matrix from dense rows (zeros left out unless `keepZeros`). */
function fromRows(
  rows: readonly (readonly number[])[],
  keepZeros = false,
): { pattern: CscPattern; values: Float64Array } {
  const n = rows.length;
  const colPtr = new Int32Array(n + 1);
  const rowIdx: number[] = [];
  const values: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (rows[i][j] !== 0 || (keepZeros && i === j)) {
        rowIdx.push(i);
        values.push(rows[i][j]);
      }
    }
    colPtr[j + 1] = rowIdx.length;
  }
  return { pattern: { n, colPtr, rowIdx: Int32Array.from(rowIdx) }, values: Float64Array.from(values) };
}

const identity = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

function sparseSolve(
  rows: readonly (readonly number[])[],
  b: readonly number[],
  options: { order?: Int32Array; threshold?: number; lu?: SparseLu; factors?: SparseFactors } = {},
): Float64Array | null {
  const { pattern, values } = fromRows(rows);
  const lu = options.lu ?? new SparseLu();
  const factors = options.factors ?? new SparseFactors();
  const order = options.order ?? amdOrder(pattern.n, pattern.colPtr, pattern.rowIdx);
  if (!lu.factor(pattern, values, order, options.threshold ?? PIVOT_THRESHOLD.value, factors)) return null;
  const x = Float64Array.from(b);
  lu.solve(factors, x);
  return x;
}

/** The normwise backward error ‖A x − b‖∞ / (‖A‖∞ ‖x‖∞ + ‖b‖∞), as in the dense LU spec. */
function backwardError(rows: readonly (readonly number[])[], x: Float64Array, b: readonly number[]): number {
  let residual = 0;
  let normA = 0;
  rows.forEach((row, i) => {
    let r = -b[i];
    let rowSum = 0;
    row.forEach((v, j) => {
      r += v * x[j];
      rowSum += Math.abs(v);
    });
    residual = Math.max(residual, Math.abs(r));
    normA = Math.max(normA, rowSum);
  });
  const normX = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const normB = b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return residual / (normA * normX + normB + 1e-300);
}

// Arbitraries, built once at module level. Sparse systems up to 60 × 60: a few entries per row,
// zeros common on the diagonal (so the pivots must move), and an optional dominant diagonal.
const MAX_N = 60;
const entryValue = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((k) => k / 1000);
const sparseArb = fc
  .record({
    n: fc.integer({ min: 1, max: MAX_N }),
    entries: fc.array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), entryValue), {
      minLength: 1,
      maxLength: 5 * MAX_N,
    }),
    diagonal: fc.array(fc.oneof(fc.constant(0), entryValue), { minLength: MAX_N, maxLength: MAX_N }),
    dominance: fc.constantFrom(0, 0, 1e4),
    rhs: fc.array(entryValue, { minLength: MAX_N, maxLength: MAX_N }),
    rotate: fc.nat({ max: MAX_N - 1 }),
  })
  .map(({ n, entries, diagonal, dominance, rhs, rotate }) => {
    const rows = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) rows[i][i] = diagonal[i] + (diagonal[i] >= 0 ? dominance : -dominance);
    for (const [i, j, v] of entries) rows[i % n][j % n] += v;
    // Rotating the rows moves every dominant pivot off the diagonal.
    const shift = rotate % n;
    return { rows: rows.map((_, i) => rows[(i + shift) % n]), b: rhs.slice(0, n) };
  });

describe('SparseLu', () => {
  it('solves small systems, pivoting past a zero or tiny diagonal', () => {
    const exact = sparseSolve(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(exact?.[0]).toBeCloseTo(1, 14);
    expect(exact?.[1]).toBeCloseTo(3, 14);
    expect(
      Array.from(
        sparseSolve(
          [
            [0, 1],
            [1, 0],
          ],
          [2, 3],
        ) ?? [],
      ),
    ).toStrictEqual([3, 2]);
    // The diagonal 1e-20 is far below threshold × 1: the off-diagonal row is the pivot.
    const x = sparseSolve(
      [
        [1e-20, 1],
        [1, 1],
      ],
      [1, 2],
      { order: identity(2) },
    );
    expect(x?.[0]).toBeCloseTo(1, 15);
    expect(x?.[1]).toBeCloseTo(1, 15);
  });

  it('keeps the diagonal above the threshold, and takes the largest entry below it', () => {
    const rows = [
      [0.5, 1],
      [4, 1],
    ];
    const { pattern, values } = fromRows(rows);
    const lu = new SparseLu();
    const kept = new SparseFactors();
    // |0.5| ≥ 0.1 · |4|: threshold pivoting keeps the diagonal (no row swap).
    expect(lu.factor(pattern, values, identity(2), 0.1, kept)).toBe(true);
    expect(kept.prow[0]).toBe(0);
    // Partial pivoting (threshold 1) takes row 1.
    const swapped = new SparseFactors();
    expect(lu.factor(pattern, values, identity(2), 1, swapped)).toBe(true);
    expect(swapped.prow[0]).toBe(1);
    // Ties go to the lowest row.
    const tie = fromRows([
      [0, 2],
      [2, 0],
    ]);
    const tied = new SparseFactors();
    expect(lu.factor(tie.pattern, tie.values, identity(2), 1, tied)).toBe(true);
    expect(tied.prow[0]).toBe(1);
  });

  it('reports structurally and numerically singular matrices, and non-finite entries', () => {
    expect(
      sparseSolve(
        [
          [1, 0],
          [0, 0],
        ],
        [1, 1],
      ),
    ).toBeNull(); // an empty column
    expect(
      sparseSolve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
        { order: identity(2) },
      ),
    ).toBeNull();
    expect(
      sparseSolve(
        [
          [Infinity, 0],
          [0, 1],
        ],
        [1, 1],
      ),
    ).toBeNull();
    expect(
      sparseSolve(
        [
          [NaN, 1],
          [1, 1],
        ],
        [1, 1],
        { order: identity(2) },
      ),
    ).toBeNull();
    // A non-finite entry reached only through an update.
    // Column 0 pivots on row 0 (a tie, lowest row); then 1e308 − (−1) · 1e308 overflows.
    expect(
      sparseSolve(
        [
          [1, 1e308],
          [-1, 1e308],
        ],
        [1, 1],
        { order: identity(2), threshold: 1 },
      ),
    ).toBeNull();
  });

  it('refuses a bad threshold, a short order, a short right-hand side and a solve without factors', () => {
    const { pattern, values } = fromRows([[1]]);
    const lu = new SparseLu();
    const factors = new SparseFactors();
    expect(() => lu.factor(pattern, values, identity(1), 0, factors)).toThrow(RangeError);
    expect(() => lu.factor(pattern, values, identity(1), 1.5, factors)).toThrow(RangeError);
    expect(() => lu.factor(pattern, values, new Int32Array(0), 0.1, factors)).toThrow(RangeError);
    expect(() => lu.solve(factors, new Float64Array(1))).toThrow(/no successful factorisation/);
    expect(lu.factor(pattern, values, identity(1), 0.1, factors)).toBe(true);
    expect(() => lu.solve(factors, new Float64Array(0))).toThrow(RangeError);
    expect(factors.lowerNonzeros + factors.upperNonzeros).toBe(0);
    expect(new SparseFactors().lowerNonzeros + new SparseFactors().upperNonzeros).toBe(0);
  });

  it('applies the column order: an arrow matrix factors without fill in AMD order, densely in natural order', () => {
    // Row and column 0 are full: eliminating column 0 first fills the whole trailing block.
    const n = 40;
    const rows = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 10 + i : i === 0 || j === 0 ? 1 : 0)),
    );
    const { pattern, values } = fromRows(rows);
    const lu = new SparseLu();
    const amd = new SparseFactors();
    expect(lu.factor(pattern, values, amdOrder(n, pattern.colPtr, pattern.rowIdx), 0.1, amd)).toBe(true);
    expect(amd.lowerNonzeros + amd.upperNonzeros).toBe(2 * (n - 1));
    const natural = new SparseFactors();
    expect(lu.factor(pattern, values, identity(n), 0.1, natural)).toBe(true);
    expect(natural.lowerNonzeros + natural.upperNonzeros).toBe(n * (n - 1));
  });

  it('factors a 20 000-long chain without overflowing the call stack', () => {
    // A tridiagonal chain in natural order: each column's reach runs down the whole elimination path.
    const n = 20_000;
    const colPtr = new Int32Array(n + 1);
    const rowIdx: number[] = [];
    const values: number[] = [];
    for (let j = 0; j < n; j++) {
      for (const i of [j - 1, j, j + 1]) {
        if (i < 0 || i >= n) continue;
        rowIdx.push(i);
        values.push(i === j ? 2 : -1);
      }
      colPtr[j + 1] = rowIdx.length;
    }
    const pattern = { n, colPtr, rowIdx: Int32Array.from(rowIdx) };
    const lu = new SparseLu();
    const factors = new SparseFactors();
    // Reverse order: the first column's reach is the chain itself once the rest is eliminated.
    const reverse = Int32Array.from({ length: n }, (_, i) => n - 1 - i);
    expect(lu.factor(pattern, Float64Array.from(values), reverse, 1, factors)).toBe(true);
    const x = new Float64Array(n).fill(0);
    x[0] = 1;
    lu.solve(factors, x);
    // The discrete Laplacian's Green's function: x_i = (n − i) / (n + 1).
    expect(x[0]).toBeCloseTo(n / (n + 1), 9);
    expect(x[n - 1]).toBeCloseTo(1 / (n + 1), 9);
  });

  it('survives a visit-generation reset', () => {
    const rows = [
      [4, 1, 0],
      [1, 4, 1],
      [0, 1, 4],
    ];
    const lu = new SparseLu();
    (lu as unknown as { visitGen: number }).visitGen = 0x40000000 - 1;
    const x = sparseSolve(rows, [5, 6, 5], { lu });
    expect(Array.from(x ?? []).map((v) => Math.round(v * 1e12) / 1e12)).toStrictEqual([1, 1, 1]);
  });

  it('is backward stable, agrees with dense LU and is bit-identical on reuse (property)', () => {
    const shared = new SparseLu();
    fc.assert(
      fc.property(sparseArb, ({ rows, b }) => {
        const n = rows.length;
        const x = sparseSolve(rows, b, { lu: shared });
        const dense = new DenseLu();
        const a = dense.begin(n);
        rows.forEach((row, i) => row.forEach((v, j) => (a[i * n + j] = v)));
        const denseOk = dense.factor();
        if (x === null) {
          // Sparse says singular: the matrix must be singular to rounding. Dense LU either agrees, or
          // (its rounding leaving a tiny last pivot, the matrix being exactly singular) blows up on a
          // right-hand side of ones: ‖A‖ ‖y‖ / ‖b‖ far beyond any well-posed system's.
          if (denseOk) {
            const y = new Float64Array(n).fill(1);
            dense.solve(y);
            const normA = rows.reduce(
              (m, row) =>
                Math.max(
                  m,
                  row.reduce((t, v) => t + Math.abs(v), 0),
                ),
              0,
            );
            const growth = normA * y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
            expect(!(growth < 1e8), `growth ${growth}`).toBe(true);
          }
          return;
        }
        for (const v of x) expect(Number.isFinite(v)).toBe(true);
        // Threshold pivoting bounds growth by (1 + 1/u) per step; at these sizes it stays tiny.
        expect(backwardError(rows, x, b)).toBeLessThan(1e-12 * n);
        const again = sparseSolve(rows, b);
        expect(Array.from(again ?? []).every((v, i) => Object.is(v, x[i]))).toBe(true);
      }),
      {
        numRuns: 150,
        // Exactly singular (rows 0 and 1 proportional): sparse says so; dense's rounding leaves a
        // tiny pivot and solves b = 0 (fresh-seed counterexamples).
        examples: [
          [
            {
              rows: [
                [0.001, 0, 0],
                [0.009, 0, 0],
                [-0.01, -0.001, -52.81],
              ],
              b: [0, 0, 0],
            },
          ],
          [
            {
              rows: [
                [-88.116, 0, 0, 0, 0, 0],
                [0, -0.001, 0, 0, 0, 0],
                [-115.105, 0, -543.826, 0, 0, 0.001],
                [0, 0, 0, 0.001, 0, 0],
                [0, 0, 0, 0, -0.001, 0],
                [-0.001, 0, 0, 0, 0, 0],
              ],
              b: [0, 0, 0, 0, 0, 0],
            },
          ],
        ],
      },
    );
  });

  it('replays the pivot sequence bit-identically, and falls back when the pivot rule would change', () => {
    fc.assert(
      fc.property(sparseArb, sparseArb, ({ rows }, { rows: other }) => {
        const n = rows.length;
        const { pattern, values } = fromRows(rows);
        const order = amdOrder(n, pattern.colPtr, pattern.rowIdx);
        const lu = new SparseLu();
        const factors = new SparseFactors();
        if (!lu.factor(pattern, values, order, 0.1, factors)) return;
        // New values on the same pattern (taken from another system where it has entries).
        const changed = Float64Array.from(values, (v, p) => {
          const j = pattern.colPtr.findIndex((start, c) => start <= p && p < pattern.colPtr[c + 1]);
          const w = other[pattern.rowIdx[p] % other.length][j % other.length];
          return w === 0 ? v : w;
        });
        const freshFactors = new SparseFactors();
        const freshOk = new SparseLu().factor(pattern, changed, order, 0.1, freshFactors);
        const before = { replays: lu.replays, fresh: lu.fresh, fallbacks: lu.fallbacks };
        const ok = lu.factor(pattern, changed, order, 0.1, factors);
        expect(ok).toBe(freshOk);
        // Either replayed or fell back; never both, never neither.
        expect(lu.replays - before.replays + lu.fallbacks - before.fallbacks).toBe(1);
        if (!ok) return;
        const b = Float64Array.from({ length: n }, (_, i) => i - n / 2);
        const x = Float64Array.from(b);
        lu.solve(factors, x);
        const y = Float64Array.from(b);
        new SparseLu().solve(freshFactors, y);
        expect(Array.from(x).every((v, i) => Object.is(v, y[i]))).toBe(true);
        expect(Array.from(factors.prow.subarray(0, n))).toStrictEqual(Array.from(freshFactors.prow.subarray(0, n)));
      }),
      { numRuns: 150 },
    );
  });

  it('counts replays and fallbacks', () => {
    const rows = [
      [4, 1],
      [1, 4],
    ];
    const { pattern, values } = fromRows(rows);
    const lu = new SparseLu();
    const factors = new SparseFactors();
    const order = identity(2);
    expect(lu.factor(pattern, values, order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([1, 0, 0]);
    expect(lu.factor(pattern, Float64Array.of(3, 1, 1, 3), order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([1, 1, 0]);
    // Now row 1 dominates column 0: the replayed pivot (row 0) is rejected and a fresh one is done.
    // (CSC values: column 0 is rows 0, 1, then column 1.) [[1, 1], [4, 1]].
    expect(lu.factor(pattern, Float64Array.of(1, 4, 1, 1), order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([2, 1, 1]);
    expect(factors.prow[0]).toBe(1);
    // A replay that meets a zero pivot fails as a fresh factorisation would ([[1, 1], [4, 4]]).
    expect(lu.factor(pattern, Float64Array.of(1, 4, 1, 1), order, 1, factors)).toBe(true);
    expect(lu.factor(pattern, Float64Array.of(1, 4, 1, 4), order, 1, factors)).toBe(false);
    expect(factors.valid).toBe(false);
    // Another order or threshold is never replayed.
    expect(lu.factor(pattern, values, order, 1, factors)).toBe(true);
    const fresh = lu.fresh;
    expect(lu.factor(pattern, values, order, 0.5, factors)).toBe(true);
    expect(lu.factor(pattern, values, Int32Array.of(1, 0), 0.5, factors)).toBe(true);
    expect(lu.fresh).toBe(fresh + 2);
    // A replay with a non-finite entry fails.
    expect(lu.factor(pattern, Float64Array.of(4, 1, 1, Infinity), Int32Array.of(1, 0), 0.5, factors)).toBe(false);
    expect(lu.factor(pattern, values, Int32Array.of(1, 0), 0.5, factors)).toBe(true);
    expect(lu.factor(pattern, Float64Array.of(NaN, 1, 1, 4), Int32Array.of(1, 0), 0.5, factors)).toBe(false);
  });

  it('keeps an explicit zero entry in the pattern without harm', () => {
    const { pattern, values } = fromRows(
      [
        [0, 1],
        [1, 0],
      ],
      true,
    );
    expect(pattern.colPtr[2]).toBe(4);
    const lu = new SparseLu();
    const factors = new SparseFactors();
    expect(lu.factor(pattern, values, identity(2), 0.1, factors)).toBe(true);
    const x = Float64Array.of(2, 3);
    lu.solve(factors, x);
    expect(Array.from(x)).toStrictEqual([3, 2]);
  });
});
