/*
 * Dense LU factorisation with partial pivoting (plan F2.2 part 1), reimplemented from the textbook
 * algorithm (Golub and Van Loan, "Matrix Computations", §3.4, Gaussian elimination with partial
 * pivoting): no third-party code.
 *
 * The matrix is row-major with stride `n` in one preallocated `Float64Array`, factored in place into a
 * unit lower triangle L (below the diagonal) and an upper triangle U (on and above it), with the row
 * swaps recorded LAPACK-style (`perm[k]` is the row swapped into row k at step k). Storage grows only
 * when a larger system arrives, so a steady-state solve allocates nothing.
 *
 * Deterministic: a fixed loop order, IEEE-exact operations only (D6), and ties between equal pivot
 * candidates go to the lowest row, so the same matrix gives bit-identical factors in every runtime.
 */
export class DenseLu {
  private matrix: Float64Array;
  private perm: Int32Array;
  private n = 0;
  private factored = false;

  constructor(capacity = 16) {
    this.matrix = new Float64Array(capacity * capacity);
    this.perm = new Int32Array(capacity);
  }

  /** The order of the current system. */
  get size(): number {
    return this.n;
  }

  /**
   * Starts an `n × n` system: grows the storage if it is too small (the only allocation), zeroes the
   * first `n²` entries and returns the matrix to fill, row-major with stride `n` (entry `(i, j)` is
   * `[i * n + j]`). Entries past `n²` are scratch and never read.
   */
  begin(n: number): Float64Array {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`DenseLu: order must be a natural number, got ${n}`);
    if (n * n > this.matrix.length) this.matrix = new Float64Array(n * n);
    if (n > this.perm.length) this.perm = new Int32Array(n);
    this.matrix.fill(0, 0, n * n);
    this.n = n;
    this.factored = false;
    return this.matrix;
  }

  /**
   * Factors the matrix in place. Returns `false` when it is numerically singular: some pivot column
   * had no non-zero candidate, or a candidate was not finite. The factors are then unusable, and
   * `solve` throws until the next successful `factor`.
   */
  factor(): boolean {
    const a = this.matrix;
    const n = this.n;
    this.factored = false;
    for (let k = 0; k < n; k++) {
      // Partial pivoting: the largest |a(i, k)| for i ≥ k, the lowest row on a tie.
      let pivotRow = k;
      let pivotAbs = Math.abs(a[k * n + k]);
      for (let i = k + 1; i < n; i++) {
        const candidate = Math.abs(a[i * n + k]);
        if (candidate > pivotAbs) {
          pivotAbs = candidate;
          pivotRow = i;
        }
      }
      // `!(x > 0)` also catches NaN; an infinite pivot would spread NaN through the update.
      if (!(pivotAbs > 0) || pivotAbs === Infinity) return false;
      this.perm[k] = pivotRow;
      if (pivotRow !== k) {
        const rowK = k * n;
        const rowP = pivotRow * n;
        for (let j = 0; j < n; j++) {
          const t = a[rowK + j];
          a[rowK + j] = a[rowP + j];
          a[rowP + j] = t;
        }
      }
      const rowK = k * n;
      const pivot = a[rowK + k];
      for (let i = k + 1; i < n; i++) {
        const rowI = i * n;
        const l = a[rowI + k] / pivot;
        a[rowI + k] = l;
        if (l === 0) continue;
        for (let j = k + 1; j < n; j++) a[rowI + j] -= l * a[rowK + j];
      }
    }
    this.factored = true;
    return true;
  }

  /** Solves `A x = b` in place over `b[0 … n)`, after a successful `factor`. */
  solve(b: Float64Array): void {
    if (!this.factored) throw new Error('DenseLu.solve: no successful factorisation');
    const a = this.matrix;
    const n = this.n;
    if (b.length < n) throw new RangeError(`DenseLu.solve: right-hand side shorter than ${n}`);
    for (let k = 0; k < n; k++) {
      const p = this.perm[k];
      if (p !== k) {
        const t = b[k];
        b[k] = b[p];
        b[p] = t;
      }
    }
    // Forward substitution with the unit lower triangle.
    for (let i = 1; i < n; i++) {
      const rowI = i * n;
      let sum = b[i];
      for (let j = 0; j < i; j++) sum -= a[rowI + j] * b[j];
      b[i] = sum;
    }
    // Back substitution with the upper triangle.
    for (let i = n - 1; i >= 0; i--) {
      const rowI = i * n;
      let sum = b[i];
      for (let j = i + 1; j < n; j++) sum -= a[rowI + j] * b[j];
      b[i] = sum / a[rowI + i];
    }
  }
}
