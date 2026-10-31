import fc from 'fast-check';
import { DenseLu } from './dense-lu';

/** Fills `lu` with the row-major `rows` and returns the matrix. */
function load(lu: DenseLu, rows: readonly (readonly number[])[]): Float64Array {
  const n = rows.length;
  const a = lu.begin(n);
  rows.forEach((row, i) => row.forEach((v, j) => (a[i * n + j] = v)));
  return a;
}

function solve(rows: readonly (readonly number[])[], b: readonly number[], lu = new DenseLu(2)): Float64Array | null {
  load(lu, rows);
  if (!lu.factor()) return null;
  const x = Float64Array.from(b);
  lu.solve(x);
  return x;
}

/**
 * ‖A x − b‖∞ / (‖A‖∞ ‖x‖∞ + ‖b‖∞): the normwise backward error, which Gaussian elimination with
 * partial pivoting keeps at a small multiple of n · eps (Golub and Van Loan §3.4.6). The componentwise
 * error has no such guarantee.
 */
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
  // The 1e-300 floor absorbs subnormal underflow (b = 5e-324 over a pivot of 1e4 rounds to 0).
  return residual / (normA * normX + normB + 1e-300);
}

// Arbitraries, built once at module level.
/**
 * Entries on a 1e-3 grid in [−1000, 1000], with zeros common. Not arbitrary doubles: a subnormal
 * pivot (5e-324) overflows the solve to ±Infinity, which `DcSolver` catches and flags (dc.spec.ts);
 * this property is about stability, not underflow.
 */
const entry = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000, max: 1_000_000 }).map((k) => k / 1000) },
);
const MAX_N = 12;
/** An order, then a full-size pool of entries the system takes its first n × n (no `.chain`). */
const systemArb = fc
  .record({
    n: fc.integer({ min: 1, max: MAX_N }),
    pool: fc.array(entry, { minLength: MAX_N * MAX_N, maxLength: MAX_N * MAX_N }),
    rhs: fc.array(entry, { minLength: MAX_N, maxLength: MAX_N }),
    // Diagonal dominance fixes where the pivots are; 0 leaves the matrix raw.
    dominance: fc.constantFrom(0, 1e4),
    // A cyclic row rotation, so dominant systems need row swaps (0 leaves them in place).
    rotate: fc.nat({ max: MAX_N - 1 }),
  })
  .map(({ n, pool, rhs, dominance, rotate }) => ({
    rows: Array.from({ length: n }, (_, i) => pool.slice(i * MAX_N, i * MAX_N + n)),
    b: rhs.slice(0, n),
    dominance,
    rotate,
  }));

describe('DenseLu', () => {
  it('solves a small system exactly', () => {
    // 2x + y = 5, x + 3y = 10 → x = 1, y = 3.
    expect(
      Array.from(
        solve(
          [
            [2, 1],
            [1, 3],
          ],
          [5, 10],
        ) ?? [],
      ),
    ).toStrictEqual([1, 3]);
  });

  it('pivots past a zero on the diagonal', () => {
    // Without row exchange the first pivot is 0. y = 2, x = 3.
    expect(
      Array.from(
        solve(
          [
            [0, 1],
            [1, 0],
          ],
          [2, 3],
        ) ?? [],
      ),
    ).toStrictEqual([3, 2]);
  });

  it('chooses the largest pivot, which keeps a tiny leading entry accurate', () => {
    // [[1e-20, 1], [1, 1]] x = [1, 2]: x ≈ [1, 1]. Without pivoting, 1 − 1e20 swamps the second row
    // and x₀ comes out 0.
    const x = solve(
      [
        [1e-20, 1],
        [1, 1],
      ],
      [1, 2],
    );
    expect(x?.[0]).toBeCloseTo(1, 15);
    expect(x?.[1]).toBeCloseTo(1, 15);
  });

  it('reports an exactly singular matrix, and a non-finite one', () => {
    expect(
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
    expect(
      solve(
        [
          [0, 0],
          [0, 0],
        ],
        [0, 0],
      ),
    ).toBeNull();
    expect(
      solve(
        [
          [Infinity, 0],
          [0, 1],
        ],
        [1, 1],
      ),
    ).toBeNull();
    expect(
      solve(
        [
          [NaN, 0],
          [0, 1],
        ],
        [1, 1],
      ),
    ).toBeNull();
  });

  it('handles the empty system', () => {
    expect(Array.from(solve([], []) ?? [1])).toStrictEqual([]);
  });

  it('refuses a solve without a successful factorisation, a short right-hand side and a bad order', () => {
    const lu = new DenseLu();
    expect(() => lu.solve(new Float64Array(0))).toThrow(/no successful factorisation/);
    load(lu, [
      [1, 2],
      [2, 4],
    ]);
    expect(lu.factor()).toBe(false);
    expect(() => lu.solve(new Float64Array(2))).toThrow(/no successful factorisation/);
    load(lu, [
      [1, 0],
      [0, 1],
    ]);
    expect(lu.factor()).toBe(true);
    expect(() => lu.solve(new Float64Array(1))).toThrow(RangeError);
    expect(() => lu.begin(-1)).toThrow(RangeError);
    expect(() => lu.begin(1.5)).toThrow(RangeError);
    expect(lu.size).toBe(2);
  });

  it('grows its storage on demand and zeroes each new system', () => {
    const lu = new DenseLu(1);
    expect(Array.from(solve([[4]], [8], lu) ?? [])).toStrictEqual([2]);
    expect(
      Array.from(
        solve(
          [
            [1, 0, 0],
            [0, 2, 0],
            [0, 0, 4],
          ],
          [1, 2, 4],
          lu,
        ) ?? [],
      ),
    ).toStrictEqual([1, 1, 1]);
    // A smaller system after a larger one sees no stale entries.
    expect(Array.from(solve([[3]], [9], lu) ?? [])).toStrictEqual([3]);
  });

  it('a factorisation is forgotten by the next begin', () => {
    const lu = new DenseLu();
    load(lu, [[2]]);
    expect(lu.factor()).toBe(true);
    lu.begin(1);
    expect(() => lu.solve(new Float64Array(1))).toThrow(/no successful factorisation/);
  });

  it('is backward stable and bit-identical on reuse (property)', () => {
    const shared = new DenseLu(1);
    fc.assert(
      fc.property(systemArb, ({ rows, b, dominance, rotate }) => {
        const n = rows.length;
        // Dominance makes the diagonal the natural pivot; rotating the rows then moves every pivot off
        // the diagonal, so the dominant systems are solved only if the row swaps are right.
        const dominant = rows.map((row, i) => row.map((v, j) => (i === j ? v + (v >= 0 ? dominance : -dominance) : v)));
        const shift = rotate % n;
        const a = dominant.map((_, i) => dominant[(i + shift) % n]);
        const rhs = b.map((_, i) => b[(i + shift) % n]);
        const x = solve(a, rhs, shared);
        if (x === null) return; // a raw random matrix may be singular; the solver must say so, not produce NaN
        for (const v of x) expect(Number.isFinite(v)).toBe(true);
        // GEPP is normwise backward stable whatever the conditioning (Golub and Van Loan §3.4.6): the
        // growth factor, not cond(A), bounds it, and it is tiny at these sizes.
        expect(backwardError(a, x, rhs)).toBeLessThan(1e-13 * n);
        const again = solve(a, rhs, new DenseLu());
        expect(again).not.toBeNull();
        expect(Array.from(again ?? []).every((v, i) => Object.is(v, x[i]))).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});
