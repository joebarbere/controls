import fc from 'fast-check';
import { PIVOT_THRESHOLD } from '../constants';
import { amdOrder } from './amd';
import { cabs1, ComplexDenseLu, complexReciprocal } from './complex-dense-lu';
import { ComplexSparseFactors, ComplexSparseLu } from './complex-sparse-lu';
import type { CscPattern } from './sparse-lu';

/*
 * The complex LUs of F2.2 part 2 (`ComplexDenseLu`, `ComplexSparseLu`): exact small cases, pivoting,
 * the singular contract, argument checks, and properties on random complex systems: backward stability,
 * dense against sparse, exact scaling by j, and bit-identical reuse and replay.
 */

/** A complex matrix as dense rows of [re, im] entries. */
type Rows = readonly (readonly (readonly [number, number])[])[];

function denseSolve(
  rows: Rows,
  b: readonly (readonly [number, number])[],
  lu = new ComplexDenseLu(),
): Float64Array | null {
  const n = rows.length;
  const a = lu.begin(n);
  rows.forEach((row, i) =>
    row.forEach(([re, im], j) => {
      a[2 * (i * n + j)] = re;
      a[2 * (i * n + j) + 1] = im;
    }),
  );
  if (!lu.factor()) return null;
  const x = Float64Array.from(b.flat());
  lu.solve(x);
  return x;
}

/** A CSC pattern of `rows` (zeros left out unless `keepZeros`) with interleaved values. */
function fromRows(rows: Rows, keepZeros = false): { pattern: CscPattern; values: Float64Array } {
  const n = rows.length;
  const colPtr = new Int32Array(n + 1);
  const rowIdx: number[] = [];
  const values: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [re, im] = rows[i][j];
      if (re !== 0 || im !== 0 || (keepZeros && i === j)) {
        rowIdx.push(i);
        values.push(re, im);
      }
    }
    colPtr[j + 1] = rowIdx.length;
  }
  return { pattern: { n, colPtr, rowIdx: Int32Array.from(rowIdx) }, values: Float64Array.from(values) };
}

function sparseSolve(
  rows: Rows,
  b: readonly (readonly [number, number])[],
  options: { order?: Int32Array; lu?: ComplexSparseLu; factors?: ComplexSparseFactors; keepZeros?: boolean } = {},
): Float64Array | null {
  const { pattern, values } = fromRows(rows, options.keepZeros);
  const lu = options.lu ?? new ComplexSparseLu();
  const factors = options.factors ?? new ComplexSparseFactors();
  const order = options.order ?? amdOrder(pattern.n, pattern.colPtr, pattern.rowIdx);
  if (!lu.factor(pattern, values, order, PIVOT_THRESHOLD.value, factors)) return null;
  const x = Float64Array.from(b.flat());
  lu.solve(factors, x);
  return x;
}

/** The normwise backward error ‖A x − b‖∞ / (‖A‖∞ ‖x‖∞ + ‖b‖∞), with complex moduli. */
function backwardError(rows: Rows, x: Float64Array, b: readonly (readonly [number, number])[]): number {
  let residual = 0;
  let normA = 0;
  rows.forEach((row, i) => {
    let rr = -b[i][0];
    let ri = -b[i][1];
    let rowSum = 0;
    row.forEach(([ar, ai], j) => {
      rr += ar * x[2 * j] - ai * x[2 * j + 1];
      ri += ar * x[2 * j + 1] + ai * x[2 * j];
      rowSum += Math.hypot(ar, ai);
    });
    residual = Math.max(residual, Math.hypot(rr, ri));
    normA = Math.max(normA, rowSum);
  });
  let normX = 0;
  for (let j = 0; j < x.length; j += 2) normX = Math.max(normX, Math.hypot(x[j], x[j + 1]));
  const normB = b.reduce((m, [re, im]) => Math.max(m, Math.hypot(re, im)), 0);
  return residual / (normA * normX + normB + 1e-300);
}

const Z: readonly [number, number] = [0, 0];
const zeros = (n: number): (readonly [number, number])[][] =>
  Array.from({ length: n }, () => Array.from({ length: n }, () => Z));

// Random sparse complex systems up to 40 × 40, built once at module level.
const MAX_N = 40;
const part = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((k) => k / 1000);
const entry = fc.tuple(part, part);
const systemArb = fc
  .record({
    n: fc.integer({ min: 1, max: MAX_N }),
    entries: fc.array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), entry), {
      minLength: 1,
      maxLength: 5 * MAX_N,
    }),
    diagonal: fc.array(fc.oneof(fc.constant(Z), entry), { minLength: MAX_N, maxLength: MAX_N }),
    dominance: fc.constantFrom(0, 0, 1e4),
    rhs: fc.array(entry, { minLength: MAX_N, maxLength: MAX_N }),
  })
  .map(({ n, entries, diagonal, dominance, rhs }) => {
    const rows = zeros(n);
    for (let i = 0; i < n; i++) rows[i][i] = [diagonal[i][0] + dominance, diagonal[i][1]];
    for (const [i, j, v] of entries) {
      const [r, c] = [i % n, j % n];
      rows[r][c] = [rows[r][c][0] + v[0], rows[r][c][1] + v[1]];
    }
    return { rows: rows as Rows, b: rhs.slice(0, n) };
  });

describe('complex helpers', () => {
  it('cabs1 is |re| + |im|', () => {
    expect(cabs1(-3, 4)).toBe(7);
    expect(cabs1(0, -0)).toBe(0);
  });

  it("complexReciprocal is Smith's algorithm on either branch", () => {
    const out = new Float64Array(4);
    complexReciprocal(3, 4, out, 0); // |im| > |re|: 1 / (3 + 4j) = (3 − 4j) / 25
    complexReciprocal(4, 3, out, 2); // |re| ≥ |im|: (4 − 3j) / 25
    [3 / 25, -4 / 25, 4 / 25, -3 / 25].forEach((want, i) => expect(Math.abs(out[i] - want)).toBeLessThan(1e-16));
    expect(out[0] * 3 - out[1] * 4).toBeCloseTo(1, 15);
    expect(out[2] * 4 - out[3] * 3).toBeCloseTo(1, 15);
    // No overflow where |p|² would: 1 / (1e200 j).
    complexReciprocal(0, 1e200, out, 0);
    expect([out[0], out[1]]).toStrictEqual([0, -1e-200]);
  });
});

describe('ComplexDenseLu', () => {
  it('solves a small complex system exactly', () => {
    // (1 + j) x = 2 j → x = 1 + j; with a coupling row.
    const x = denseSolve(
      [
        [
          [1, 1],
          [0, 0],
        ],
        [
          [1, 0],
          [0, 2],
        ],
      ],
      [
        [0, 2],
        [1, 3],
      ],
    );
    // Row 0: x0 = 2j / (1 + j) = 1 + j. Row 1: x0 + 2j x1 = 1 + 3j → x1 = 2j / 2j = 1.
    expect(Array.from(x ?? [])).toStrictEqual([1, 1, 1, 0]);
  });

  it('pivots by |re| + |im|, past a zero diagonal, the lowest row on a tie', () => {
    // Column 0: rows 1 and 2 both have |re| + |im| = 3; row 1 wins the tie.
    const rows: Rows = [
      [Z, [1, 0], [0, 1]],
      [
        [1, 2],
        [1, 0],
        [0, 0],
      ],
      [
        [3, 0],
        [0, 0],
        [1, 0],
      ],
    ];
    const b: [number, number][] = [
      [1, 0],
      [0, 1],
      [2, -1],
    ];
    const x = denseSolve(rows, b);
    expect(x).not.toBeNull();
    expect(backwardError(rows, x as Float64Array, b)).toBeLessThan(1e-15);
  });

  it('reports an exactly singular matrix, and a non-finite one', () => {
    const lu = new ComplexDenseLu();
    expect(
      denseSolve(
        [
          [
            [1, 1],
            [2, 2],
          ],
          [
            [1, 1],
            [2, 2],
          ],
        ],
        [Z, Z],
        lu,
      ),
    ).toBeNull();
    expect(() => lu.solve(new Float64Array(4))).toThrow(/no successful factorisation/);
    expect(denseSolve([[[NaN, 0]]], [Z])).toBeNull();
    expect(denseSolve([[[1, Infinity]]], [Z])).toBeNull();
    expect(denseSolve([[Z]], [Z])).toBeNull();
  });

  it('handles the empty system, refuses a bad order and a short right-hand side, and grows on demand', () => {
    const lu = new ComplexDenseLu(1);
    lu.begin(0);
    expect(lu.factor()).toBe(true);
    lu.solve(new Float64Array(0));
    expect(() => lu.begin(-1)).toThrow(RangeError);
    expect(() => lu.begin(1.5)).toThrow(RangeError);
    const a = lu.begin(3);
    expect(lu.size).toBe(3);
    expect(a.length).toBeGreaterThanOrEqual(18);
    a.fill(0);
    for (let i = 0; i < 3; i++) a[2 * (i * 3 + i)] = 2;
    expect(lu.factor()).toBe(true);
    expect(() => lu.solve(new Float64Array(5))).toThrow(RangeError);
    const b = Float64Array.from([2, 4, 6, 8, 10, 12]);
    lu.solve(b);
    expect(Array.from(b)).toStrictEqual([1, 2, 3, 4, 5, 6]);
    // A fresh begin zeroes the system and forgets the factorisation.
    expect(
      Array.from(lu.begin(3))
        .slice(0, 18)
        .every((v) => v === 0),
    ).toBe(true);
    expect(() => lu.solve(new Float64Array(6))).toThrow(/no successful factorisation/);
  });

  it('is backward stable, exact under scaling by j, and bit-identical on reuse (property)', () => {
    const shared = new ComplexDenseLu(2);
    fc.assert(
      fc.property(systemArb, ({ rows, b }) => {
        const x = denseSolve(rows, b);
        if (x === null) return;
        expect(backwardError(rows, x, b)).toBeLessThan(1e-12);
        const again = denseSolve(rows, b, shared);
        expect(Array.from(again ?? []).every((v, i) => Object.is(v, x[i]))).toBe(true);
        // j · b gives j · x bit for bit: a quarter turn only swaps and negates parts.
        const jb = b.map(([re, im]): [number, number] => [-im, re]);
        const jx = denseSolve(rows, jb) as Float64Array;
        for (let i = 0; i < x.length; i += 2) {
          expect(jx[i] === -x[i + 1] && jx[i + 1] === x[i], `entry ${i / 2}`).toBe(true);
        }
      }),
      { numRuns: 120 },
    );
  });
});

describe('ComplexSparseLu', () => {
  it('solves small complex systems, pivoting past a zero diagonal', () => {
    const rows: Rows = [
      [Z, [1, 1], Z],
      [[2, 0], Z, [0, 1]],
      [Z, [1, 0], [3, -1]],
    ];
    const b: [number, number][] = [
      [1, 2],
      [3, 0],
      [0, -1],
    ];
    const x = sparseSolve(rows, b) as Float64Array;
    expect(backwardError(rows, x, b)).toBeLessThan(1e-15);
    const d = denseSolve(rows, b) as Float64Array;
    for (let i = 0; i < x.length; i++) expect(Math.abs(x[i] - d[i])).toBeLessThan(1e-14);
  });

  it('keeps the diagonal on an exact CABS1 tie with a lower row (the diagonal wins ties)', () => {
    // Column 1 is eliminated first. Its candidates are row 0, (3, 0), and its diagonal, row 1, (1, 2):
    // |re| + |im| = 3 for both. The lowest row would be row 0; the threshold rule keeps the diagonal.
    const rows: Rows = [
      [
        [2, 0],
        [3, 0],
      ],
      [
        [1, 1],
        [1, 2],
      ],
    ];
    const { pattern, values } = fromRows(rows);
    for (const threshold of [1, PIVOT_THRESHOLD.value]) {
      const lu = new ComplexSparseLu();
      const factors = new ComplexSparseFactors();
      expect(lu.factor(pattern, values, Int32Array.of(1, 0), threshold, factors)).toBe(true);
      expect(factors.prow[0]).toBe(1);
      const b: [number, number][] = [
        [1, 0],
        [0, 1],
      ];
      const x = Float64Array.from(b.flat());
      lu.solve(factors, x);
      expect(backwardError(rows, x, b)).toBeLessThan(1e-15);
    }
  });

  it('reports structurally and numerically singular matrices, and non-finite entries', () => {
    // An empty column: no candidate.
    expect(
      sparseSolve(
        [
          [[1, 0], Z],
          [[1, 0], Z],
        ],
        [Z, Z],
      ),
    ).toBeNull();
    // Two equal rows: a zero pivot after elimination.
    expect(
      sparseSolve(
        [
          [
            [1, 1],
            [2, 0],
          ],
          [
            [1, 1],
            [2, 0],
          ],
        ],
        [Z, Z],
      ),
    ).toBeNull();
    expect(sparseSolve([[[NaN, 0]]], [Z])).toBeNull();
    expect(sparseSolve([[[0, -Infinity]]], [Z])).toBeNull();
    // An explicit zero in the pattern only.
    expect(sparseSolve([[Z]], [Z], { keepZeros: true })).toBeNull();
  });

  it('refuses a bad threshold, a short order, a short right-hand side and a solve without factors', () => {
    const { pattern, values } = fromRows([[[1, 0]]]);
    const lu = new ComplexSparseLu();
    const factors = new ComplexSparseFactors();
    expect(() => lu.factor(pattern, values, new Int32Array(0), 0.1, factors)).toThrow(RangeError);
    expect(() => lu.factor(pattern, values, Int32Array.of(0), 0, factors)).toThrow(RangeError);
    expect(() => lu.factor(pattern, values, Int32Array.of(0), 1.5, factors)).toThrow(RangeError);
    expect(() => lu.solve(factors, new Float64Array(2))).toThrow(/no successful factorisation/);
    expect(lu.factor(pattern, values, Int32Array.of(0), 1, factors)).toBe(true);
    expect(factors.lowerNonzeros + factors.upperNonzeros).toBe(0);
    expect(() => lu.solve(factors, new Float64Array(1))).toThrow(RangeError);
    expect(new ComplexSparseFactors().lowerNonzeros + new ComplexSparseFactors().upperNonzeros).toBe(0);
  });

  it('survives a visit-generation reset', () => {
    const lu = new ComplexSparseLu();
    const rows: Rows = [
      [
        [2, 1],
        [1, 0],
      ],
      [
        [1, 0],
        [3, -1],
      ],
    ];
    const b: [number, number][] = [
      [1, 0],
      [0, 1],
    ];
    const before = sparseSolve(rows, b, { lu }) as Float64Array;
    (lu as unknown as { visitGen: number }).visitGen = 0x40000000;
    const after = sparseSolve(rows, b, { lu }) as Float64Array;
    expect(Array.from(after)).toStrictEqual(Array.from(before));
  });

  it('is backward stable, agrees with dense LU and is bit-identical on reuse (property)', () => {
    const shared = new ComplexSparseLu();
    fc.assert(
      fc.property(systemArb, ({ rows, b }) => {
        const x = sparseSolve(rows, b);
        const d = denseSolve(rows, b);
        if (x === null || d === null) return;
        expect(backwardError(rows, x, b)).toBeLessThan(1e-12);
        expect(backwardError(rows, d, b)).toBeLessThan(1e-12);
        const again = sparseSolve(rows, b, { lu: shared });
        expect(Array.from(again ?? []).every((v, i) => Object.is(v, x[i]))).toBe(true);
        const jb = b.map(([re, im]): [number, number] => [-im, re]);
        const jx = sparseSolve(rows, jb) as Float64Array;
        for (let i = 0; i < x.length; i += 2) expect(jx[i] === -x[i + 1] && jx[i + 1] === x[i]).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it('replays the pivot sequence bit-identically for new values, and falls back when the pivot rule would change', () => {
    fc.assert(
      fc.property(systemArb, systemArb, ({ rows, b }, other) => {
        const { pattern, values } = fromRows(rows, true);
        const order = amdOrder(pattern.n, pattern.colPtr, pattern.rowIdx);
        const lu = new ComplexSparseLu();
        const factors = new ComplexSparseFactors();
        if (!lu.factor(pattern, values, order, PIVOT_THRESHOLD.value, factors)) return;
        // New values on the same pattern: perturb each entry by the other system's entries.
        const next = Float64Array.from(values, (v, k) => v + (other.b[(k >> 1) % other.b.length][k & 1] ?? 0) / 7);
        const replayed = lu.factor(pattern, next, order, PIVOT_THRESHOLD.value, factors);
        const freshFactors = new ComplexSparseFactors();
        const fresh = new ComplexSparseLu().factor(pattern, next, order, PIVOT_THRESHOLD.value, freshFactors);
        expect(replayed).toBe(fresh);
        expect(lu.replays + lu.fallbacks).toBe(1);
        if (!fresh) return;
        const x = Float64Array.from(b.flat());
        const y = Float64Array.from(b.flat());
        lu.solve(factors, x);
        new ComplexSparseLu().solve(freshFactors, y);
        expect(Array.from(x).every((v, i) => Object.is(v, y[i]))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('counts replays and fallbacks, and reports a replayed singular matrix', () => {
    const lu = new ComplexSparseLu();
    const factors = new ComplexSparseFactors();
    const { pattern, values } = fromRows([
      [
        [4, 0],
        [1, 0],
      ],
      [
        [1, 0],
        [4, 0],
      ],
    ]);
    const order = Int32Array.of(0, 1);
    expect(lu.factor(pattern, values, order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([1, 0, 0]);
    // Same pivots: a replay.
    expect(lu.factor(pattern, Float64Array.of(5, 1, 1, 0, 1, 0, 5, -1), order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([1, 1, 0]);
    // Row 1 now dominates column 0: the replay falls back to a fresh factorisation.
    expect(lu.factor(pattern, Float64Array.of(1, 0, 9, 0, 1, 0, 1, 0), order, 1, factors)).toBe(true);
    expect([lu.fresh, lu.replays, lu.fallbacks]).toStrictEqual([2, 1, 1]);
    // Singular on replay: a zero pivot, then a non-finite entry.
    expect(lu.factor(pattern, Float64Array.of(1, 0, 9, 0, 1, 0, 9, 0), order, 1, factors)).toBe(false);
    expect(factors.valid).toBe(false);
    expect(lu.factor(pattern, Float64Array.of(1, 0, 9, 0, 1, 0, 1, 0), order, 1, factors)).toBe(true);
    expect(lu.factor(pattern, Float64Array.of(1, 0, 9, NaN, 1, 0, 1, 0), order, 1, factors)).toBe(false);
    expect(lu.factor(pattern, Float64Array.of(1, 0, 9, 0, 1, 0, 1, 0), order, 1, factors)).toBe(true);
    expect(lu.factor(pattern, Float64Array.of(NaN, 0, 9, 0, 1, 0, 1, 0), order, 1, factors)).toBe(false);
  });

  it('factors a 20 000-long complex chain without overflowing the call stack', () => {
    const n = 20_000;
    const colPtr = new Int32Array(n + 1);
    const rowIdx: number[] = [];
    const values: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j > 0) {
        rowIdx.push(j - 1);
        values.push(-1, 0.5);
      }
      rowIdx.push(j);
      values.push(3, 1);
      if (j + 1 < n) {
        rowIdx.push(j + 1);
        values.push(-1, -0.5);
      }
      colPtr[j + 1] = rowIdx.length;
    }
    const pattern = { n, colPtr, rowIdx: Int32Array.from(rowIdx) };
    const lu = new ComplexSparseLu();
    const factors = new ComplexSparseFactors();
    const order = Int32Array.from({ length: n }, (_, i) => n - 1 - i);
    expect(lu.factor(pattern, Float64Array.from(values), order, 1, factors)).toBe(true);
    const b = new Float64Array(2 * n).fill(1);
    lu.solve(factors, b);
    expect(b.every((v) => Number.isFinite(v))).toBe(true);
  });
});
