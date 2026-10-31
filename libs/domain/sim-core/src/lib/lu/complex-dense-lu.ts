/*
 * Dense complex LU factorisation with partial pivoting (plan F2.2 part 2), for phasor MNA systems.
 * The same textbook algorithm as `DenseLu` (Golub and Van Loan, "Matrix Computations", §3.4) in
 * complex arithmetic: no third-party code.
 *
 * Storage is **interleaved**: entry (i, j) of the row-major `n × n` matrix is the pair
 * `[2 (i n + j)]` (real part) and `[2 (i n + j) + 1]` (imaginary part), in one preallocated
 * `Float64Array`, factored in place into a unit lower triangle L and an upper triangle U, with
 * LAPACK-style row swaps. Right-hand sides are interleaved the same way: `b[2i]`, `b[2i + 1]`.
 *
 * - **Pivot magnitude:** |re| + |im| (LAPACK's CABS1, used by its complex IZAMAX), not the modulus:
 *   no square root, and it is within a factor √2 of the modulus, so partial pivoting's growth bound
 *   only changes by that factor. The largest candidate wins, the lowest row on a tie.
 * - **Division:** each pivot's reciprocal is computed once, by Smith's algorithm (R. L. Smith, "Algorithm
 *   116: Complex division", CACM 5(8), 1962), which never forms |p|² and so can't overflow or underflow
 *   for any finite non-zero pivot. Elimination multiplies by it; back substitution reuses it.
 *
 * Why complex arithmetic and not the equivalent real system of order 2n ([Re −Im; Im Re]): that system
 * has the same solution, but 4n² stored numbers instead of 2n², and Gaussian elimination on it does
 * twice the real flops (16n³/3 against 8n³/3 for n³/3 complex multiply-adds). Its partial pivoting is
 * also free to pick a real row that splits a complex entry's pair, so its rounding isn't that of a
 * complex factorisation (the plan's F2.2 part 2 decision).
 *
 * Deterministic: a fixed loop order, IEEE-exact operations only (D6), and an order-free pivot rule,
 * so the same matrix gives bit-identical factors in every runtime.
 */

/** |re| + |im| of an entry: the pivot magnitude (CABS1). */
export function cabs1(re: number, im: number): number {
  return Math.abs(re) + Math.abs(im);
}

/**
 * Writes 1 / (re + j·im) into `out[at]`, `out[at + 1]`, by Smith's algorithm. The caller ensures the
 * value is finite and non-zero.
 */
export function complexReciprocal(re: number, im: number, out: Float64Array, at: number): void {
  if (Math.abs(re) >= Math.abs(im)) {
    const r = im / re;
    const d = re + im * r;
    out[at] = 1 / d;
    out[at + 1] = -r / d;
  } else {
    const r = re / im;
    const d = re * r + im;
    out[at] = r / d;
    out[at + 1] = -1 / d;
  }
}

export class ComplexDenseLu {
  private matrix: Float64Array;
  private perm: Int32Array;
  /** The reciprocal of each pivot U(k, k), interleaved. */
  private inverse: Float64Array;
  private n = 0;
  private factored = false;

  constructor(capacity = 16) {
    this.matrix = new Float64Array(2 * capacity * capacity);
    this.perm = new Int32Array(capacity);
    this.inverse = new Float64Array(2 * capacity);
  }

  /** The order of the current system. */
  get size(): number {
    return this.n;
  }

  /**
   * Starts an `n × n` complex system: grows the storage if it is too small (the only allocation),
   * zeroes the first `2n²` numbers and returns the interleaved matrix to fill (entry (i, j) at
   * `[2 (i n + j)]` and `[2 (i n + j) + 1]`).
   */
  begin(n: number): Float64Array {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`ComplexDenseLu: order must be a natural number, got ${n}`);
    }
    if (2 * n * n > this.matrix.length) this.matrix = new Float64Array(2 * n * n);
    if (n > this.perm.length) {
      this.perm = new Int32Array(n);
      this.inverse = new Float64Array(2 * n);
    }
    this.matrix.fill(0, 0, 2 * n * n);
    this.n = n;
    this.factored = false;
    return this.matrix;
  }

  /**
   * Factors the matrix in place. Returns `false` when it is numerically singular (a pivot column with
   * no non-zero candidate, or a non-finite candidate); `solve` then throws until the next success.
   */
  factor(): boolean {
    const a = this.matrix;
    const n = this.n;
    const inverse = this.inverse;
    this.factored = false;
    for (let k = 0; k < n; k++) {
      let pivotRow = k;
      let at = 2 * (k * n + k);
      let pivotAbs = cabs1(a[at], a[at + 1]);
      for (let i = k + 1; i < n; i++) {
        at = 2 * (i * n + k);
        const candidate = cabs1(a[at], a[at + 1]);
        if (candidate > pivotAbs) {
          pivotAbs = candidate;
          pivotRow = i;
        }
      }
      // `!(x > 0)` also catches NaN; an infinite pivot would spread NaN through the update.
      if (!(pivotAbs > 0) || pivotAbs === Infinity) return false;
      this.perm[k] = pivotRow;
      if (pivotRow !== k) {
        const rowK = 2 * k * n;
        const rowP = 2 * pivotRow * n;
        for (let j = 0; j < 2 * n; j++) {
          const t = a[rowK + j];
          a[rowK + j] = a[rowP + j];
          a[rowP + j] = t;
        }
      }
      const rowK = 2 * k * n;
      complexReciprocal(a[rowK + 2 * k], a[rowK + 2 * k + 1], inverse, 2 * k);
      const pr = inverse[2 * k];
      const pi = inverse[2 * k + 1];
      for (let i = k + 1; i < n; i++) {
        const rowI = 2 * i * n;
        const xr = a[rowI + 2 * k];
        const xi = a[rowI + 2 * k + 1];
        const lr = xr * pr - xi * pi;
        const li = xr * pi + xi * pr;
        a[rowI + 2 * k] = lr;
        a[rowI + 2 * k + 1] = li;
        if (lr === 0 && li === 0) continue;
        for (let j = k + 1; j < n; j++) {
          const ur = a[rowK + 2 * j];
          const ui = a[rowK + 2 * j + 1];
          a[rowI + 2 * j] -= lr * ur - li * ui;
          a[rowI + 2 * j + 1] -= lr * ui + li * ur;
        }
      }
    }
    this.factored = true;
    return true;
  }

  /** Solves `A x = b` in place over the interleaved `b[0 … 2n)`, after a successful `factor`. */
  solve(b: Float64Array): void {
    if (!this.factored) throw new Error('ComplexDenseLu.solve: no successful factorisation');
    const a = this.matrix;
    const n = this.n;
    const inverse = this.inverse;
    if (b.length < 2 * n) throw new RangeError(`ComplexDenseLu.solve: right-hand side shorter than 2 × ${n}`);
    for (let k = 0; k < n; k++) {
      const p = this.perm[k];
      if (p !== k) {
        const tr = b[2 * k];
        const ti = b[2 * k + 1];
        b[2 * k] = b[2 * p];
        b[2 * k + 1] = b[2 * p + 1];
        b[2 * p] = tr;
        b[2 * p + 1] = ti;
      }
    }
    // Forward substitution with the unit lower triangle.
    for (let i = 1; i < n; i++) {
      const rowI = 2 * i * n;
      let sr = b[2 * i];
      let si = b[2 * i + 1];
      for (let j = 0; j < i; j++) {
        const lr = a[rowI + 2 * j];
        const li = a[rowI + 2 * j + 1];
        const xr = b[2 * j];
        const xi = b[2 * j + 1];
        sr -= lr * xr - li * xi;
        si -= lr * xi + li * xr;
      }
      b[2 * i] = sr;
      b[2 * i + 1] = si;
    }
    // Back substitution with the upper triangle, multiplying by each pivot's reciprocal.
    for (let i = n - 1; i >= 0; i--) {
      const rowI = 2 * i * n;
      let sr = b[2 * i];
      let si = b[2 * i + 1];
      for (let j = i + 1; j < n; j++) {
        const ur = a[rowI + 2 * j];
        const ui = a[rowI + 2 * j + 1];
        const xr = b[2 * j];
        const xi = b[2 * j + 1];
        sr -= ur * xr - ui * xi;
        si -= ur * xi + ui * xr;
      }
      const pr = inverse[2 * i];
      const pi = inverse[2 * i + 1];
      b[2 * i] = sr * pr - si * pi;
      b[2 * i + 1] = sr * pi + si * pr;
    }
  }
}
