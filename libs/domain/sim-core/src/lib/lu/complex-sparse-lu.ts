import { cabs1, complexReciprocal } from './complex-dense-lu';
import { type CscPattern, sparseReach } from './sparse-lu';

/*
 * Complex sparse LU with threshold partial pivoting (plan F2.2 part 2): `SparseLu`'s algorithm
 * (Gilbert–Peierls, left-looking, a fixed AMD column order, threshold pivoting after Duff, Erisman
 * and Reid; see `sparse-lu.ts`) in complex arithmetic, for phasor MNA islands. No third-party code.
 *
 * The pattern work is the real LU's, shared: the CSC pattern (`CscPattern`), the depth-first reach
 * over the graph of L (`sparseReach`) and the factorisation cache's symbolic data. Every numeric array
 * is **interleaved**: value k of a pattern or a factor is the pair `[2k]` (real), `[2k + 1]`
 * (imaginary), and so are right-hand sides.
 *
 * - **Pivot magnitude:** |re| + |im| (CABS1), as in `ComplexDenseLu`: the largest candidate, the lowest
 *   row on a tie, unless the diagonal has at least `threshold` times its magnitude.
 * - **Division:** each pivot's reciprocal, by Smith's algorithm, once per column; L(:, k) is multiplied
 *   by it, and the back substitution reuses it.
 * - **Replay:** as in the real LU, a factorisation of the same pattern, order and threshold is
 *   replayed (the same L/U patterns and pivot sequence, values recomputed in the same order) when the
 *   full pivot rule still picks the same row at every column, else redone afresh. So a warm
 *   factorisation is bit-identical to a cold one, and a cached factorisation can never be reused for
 *   values (a new frequency, a new impedance) it wasn't computed from.
 */

const VISIT_GENERATION_LIMIT = 0x40000000;

const REPLAY_OK = 0;
const REPLAY_SINGULAR = 1;
const REPLAY_MISMATCH = 2;

/** One complex matrix's LU factors (P A Q = L U), reusable by a later factorisation of the same pattern. */
export class ComplexSparseFactors {
  n = 0;
  /** Whether the factors are a successful factorisation of `pattern` in `order` at `threshold`. */
  valid = false;
  pattern: CscPattern | null = null;
  order: Int32Array | null = null;
  threshold = 0;
  // L: unit lower triangle, original row numbers, by step; values interleaved.
  lp = new Int32Array(1);
  li = new Int32Array(16);
  lx = new Float64Array(32);
  // U: strictly upper part by step (entries are step numbers, in topological order); values interleaved.
  up = new Int32Array(1);
  ui = new Int32Array(16);
  ux = new Float64Array(32);
  /** Each step's pivot U(k, k) and its reciprocal, interleaved. */
  udiag = new Float64Array(0);
  uinv = new Float64Array(0);
  /** Row → the step it is pivotal at. */
  pinv = new Int32Array(0);
  /** Step → its pivot row. */
  prow = new Int32Array(0);

  /** Entries of L below the diagonal (0 unless valid). */
  get lowerNonzeros(): number {
    return this.valid ? this.lp[this.n] : 0;
  }

  /** Entries of U above the diagonal (0 unless valid). */
  get upperNonzeros(): number {
    return this.valid ? this.up[this.n] : 0;
  }

  reserve(n: number): void {
    this.n = n;
    if (this.pinv.length >= n && this.lp.length > n) return;
    this.lp = new Int32Array(n + 1);
    this.up = new Int32Array(n + 1);
    this.udiag = new Float64Array(2 * n);
    this.uinv = new Float64Array(2 * n);
    this.pinv = new Int32Array(n);
    this.prow = new Int32Array(n);
  }

  growL(needed: number): void {
    if (needed <= this.li.length) return;
    const size = Math.max(needed, 2 * this.li.length);
    const li = new Int32Array(size);
    li.set(this.li);
    const lx = new Float64Array(2 * size);
    lx.set(this.lx);
    this.li = li;
    this.lx = lx;
  }

  growU(needed: number): void {
    if (needed <= this.ui.length) return;
    const size = Math.max(needed, 2 * this.ui.length);
    const ui = new Int32Array(size);
    ui.set(this.ui);
    const ux = new Float64Array(2 * size);
    ux.set(this.ux);
    this.ui = ui;
    this.ux = ux;
  }
}

/** The complex sparse LU kernels and their workspace. One per solver; the factors are passed in. */
export class ComplexSparseLu {
  /** Factorisations done by replaying the previous pivot sequence. */
  replays = 0;
  /** Factorisations done afresh, including replays that fell back. */
  fresh = 0;
  /** Replays abandoned because the pivot rule chose another row. */
  fallbacks = 0;
  /** The dense work column, interleaved. */
  private x = new Float64Array(0);
  private xi = new Int32Array(0);
  private stack = new Int32Array(0);
  private cursor = new Int32Array(0);
  private visited = new Int32Array(0);
  private visitGen = 0;
  private work = new Float64Array(0);

  private reserve(n: number): void {
    if (this.xi.length >= n) return;
    this.x = new Float64Array(2 * n);
    this.xi = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.cursor = new Int32Array(n);
    this.visited = new Int32Array(n);
    this.visitGen = 0;
    this.work = new Float64Array(2 * n);
  }

  /**
   * Factors the complex matrix with `pattern` and interleaved entries `values` (pair k is entry k of
   * `pattern.rowIdx`) in the column order `order`, into `factors`; as `SparseLu.factor`, replaying
   * `factors` when they hold a factorisation of the same pattern, order and threshold. Returns `false`
   * when the matrix is numerically singular; the factors are then invalid and `solve` throws.
   */
  factor(
    pattern: CscPattern,
    values: Float64Array,
    order: Int32Array,
    threshold: number,
    factors: ComplexSparseFactors,
  ): boolean {
    const n = pattern.n;
    if (order.length < n) throw new RangeError(`ComplexSparseLu: column order shorter than ${n}`);
    if (!(threshold > 0 && threshold <= 1)) {
      throw new RangeError(`ComplexSparseLu: threshold must be in (0, 1], got ${threshold}`);
    }
    this.reserve(n);
    const replayable =
      factors.valid && factors.pattern === pattern && factors.order === order && factors.threshold === threshold;
    factors.valid = false;
    if (replayable) {
      const outcome = this.replay(pattern, values, order, threshold, factors);
      if (outcome !== REPLAY_MISMATCH) {
        this.replays++;
        factors.valid = outcome === REPLAY_OK;
        return factors.valid;
      }
      this.fallbacks++;
    }
    this.fresh++;
    factors.reserve(n);
    factors.pattern = pattern;
    factors.order = order;
    factors.threshold = threshold;
    factors.valid = this.factorFresh(pattern, values, order, threshold, factors);
    return factors.valid;
  }

  private factorFresh(
    pattern: CscPattern,
    values: Float64Array,
    order: Int32Array,
    threshold: number,
    f: ComplexSparseFactors,
  ): boolean {
    const n = pattern.n;
    const { colPtr, rowIdx } = pattern;
    const pinv = f.pinv;
    const x = this.x;
    const xi = this.xi;
    pinv.fill(-1, 0, n);
    f.lp[0] = 0;
    f.up[0] = 0;
    for (let k = 0; k < n; k++) {
      const col = order[k];
      // 1. Symbolic: the reach of A(:, col), into xi[top … n) in topological order.
      if (this.visitGen >= VISIT_GENERATION_LIMIT) {
        this.visited.fill(0);
        this.visitGen = 0;
      }
      const gen = ++this.visitGen;
      let top = n;
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) {
        const root = rowIdx[p];
        if (this.visited[root] !== gen) {
          top = sparseReach(this.stack, this.cursor, this.visited, xi, pinv, f.lp, f.li, root, top, gen);
        }
      }
      // 2. Numeric: x = L⁻¹ A(:, col) over the reach.
      for (let p = top; p < n; p++) {
        x[2 * xi[p]] = 0;
        x[2 * xi[p] + 1] = 0;
      }
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) {
        x[2 * rowIdx[p]] = values[2 * p];
        x[2 * rowIdx[p] + 1] = values[2 * p + 1];
      }
      const lp = f.lp;
      const li = f.li;
      const lx = f.lx;
      let upperCount = 0;
      for (let p = top; p < n; p++) {
        const i = xi[p];
        const j = pinv[i];
        if (j < 0) continue;
        upperCount++;
        const xr = x[2 * i];
        const xim = x[2 * i + 1];
        if (xr === 0 && xim === 0) continue;
        for (let t = lp[j]; t < lp[j + 1]; t++) {
          const r = li[t];
          const lr = lx[2 * t];
          const lim = lx[2 * t + 1];
          x[2 * r] -= lr * xr - lim * xim;
          x[2 * r + 1] -= lr * xim + lim * xr;
        }
      }
      // 3. Pivot.
      let pivotRow = -1;
      let pivotAbs = -1;
      let diagonalAbs = -1;
      let candidates = 0;
      for (let p = top; p < n; p++) {
        const i = xi[p];
        if (pinv[i] >= 0) continue;
        candidates++;
        const a = cabs1(x[2 * i], x[2 * i + 1]);
        // `!(a < Infinity)` also catches NaN.
        if (!(a < Infinity)) return false;
        if (i === col) diagonalAbs = a;
        if (a > pivotAbs || (a === pivotAbs && i < pivotRow)) {
          pivotAbs = a;
          pivotRow = i;
        }
      }
      if (candidates === 0 || !(pivotAbs > 0)) return false;
      if (diagonalAbs >= threshold * pivotAbs) pivotRow = col;
      pinv[pivotRow] = k;
      f.prow[k] = pivotRow;
      f.udiag[2 * k] = x[2 * pivotRow];
      f.udiag[2 * k + 1] = x[2 * pivotRow + 1];
      complexReciprocal(x[2 * pivotRow], x[2 * pivotRow + 1], f.uinv, 2 * k);
      const pr = f.uinv[2 * k];
      const pim = f.uinv[2 * k + 1];
      // U(:, k) and L(:, k), in reach (topological) order.
      f.growU(f.up[k] + upperCount);
      f.growL(f.lp[k] + candidates - 1);
      const ui = f.ui;
      const ux = f.ux;
      const li2 = f.li;
      const lx2 = f.lx;
      let u = f.up[k];
      let l = f.lp[k];
      for (let p = top; p < n; p++) {
        const i = xi[p];
        if (i === pivotRow) continue;
        const j = pinv[i];
        const xr = x[2 * i];
        const xim = x[2 * i + 1];
        if (j >= 0) {
          ui[u] = j;
          ux[2 * u] = xr;
          ux[2 * u + 1] = xim;
          u++;
        } else {
          li2[l] = i;
          lx2[2 * l] = xr * pr - xim * pim;
          lx2[2 * l + 1] = xr * pim + xim * pr;
          l++;
        }
      }
      f.up[k + 1] = u;
      f.lp[k + 1] = l;
    }
    return true;
  }

  /** As `SparseLu`'s replay, in complex arithmetic (see the file comment). */
  private replay(
    pattern: CscPattern,
    values: Float64Array,
    order: Int32Array,
    threshold: number,
    f: ComplexSparseFactors,
  ): number {
    const n = pattern.n;
    const { colPtr, rowIdx } = pattern;
    const { lp, li, lx, up, ui, ux, udiag, uinv, prow } = f;
    const x = this.x;
    for (let k = 0; k < n; k++) {
      const col = order[k];
      const pivotRow = prow[k];
      // Zero x over the column's pattern (U rows, the pivot, L rows), scatter A(:, col).
      for (let t = up[k]; t < up[k + 1]; t++) {
        const r = prow[ui[t]];
        x[2 * r] = 0;
        x[2 * r + 1] = 0;
      }
      x[2 * pivotRow] = 0;
      x[2 * pivotRow + 1] = 0;
      for (let t = lp[k]; t < lp[k + 1]; t++) {
        x[2 * li[t]] = 0;
        x[2 * li[t] + 1] = 0;
      }
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) {
        x[2 * rowIdx[p]] = values[2 * p];
        x[2 * rowIdx[p] + 1] = values[2 * p + 1];
      }
      for (let t = up[k]; t < up[k + 1]; t++) {
        const j = ui[t];
        const r0 = prow[j];
        const xr = x[2 * r0];
        const xim = x[2 * r0 + 1];
        ux[2 * t] = xr;
        ux[2 * t + 1] = xim;
        if (xr === 0 && xim === 0) continue;
        for (let s = lp[j]; s < lp[j + 1]; s++) {
          const r = li[s];
          const lr = lx[2 * s];
          const lim = lx[2 * s + 1];
          x[2 * r] -= lr * xr - lim * xim;
          x[2 * r + 1] -= lr * xim + lim * xr;
        }
      }
      // The pivot rule over the candidates: the pivot row and L(:, k)'s rows.
      let best = pivotRow;
      let bestAbs = cabs1(x[2 * pivotRow], x[2 * pivotRow + 1]);
      if (!(bestAbs < Infinity)) return REPLAY_SINGULAR;
      let diagonalAbs = pivotRow === col ? bestAbs : -1;
      for (let t = lp[k]; t < lp[k + 1]; t++) {
        const i = li[t];
        const a = cabs1(x[2 * i], x[2 * i + 1]);
        if (!(a < Infinity)) return REPLAY_SINGULAR;
        if (i === col) diagonalAbs = a;
        if (a > bestAbs || (a === bestAbs && i < best)) {
          bestAbs = a;
          best = i;
        }
      }
      if (!(bestAbs > 0)) return REPLAY_SINGULAR;
      if (diagonalAbs >= threshold * bestAbs) best = col;
      if (best !== pivotRow) return REPLAY_MISMATCH;
      udiag[2 * k] = x[2 * pivotRow];
      udiag[2 * k + 1] = x[2 * pivotRow + 1];
      complexReciprocal(x[2 * pivotRow], x[2 * pivotRow + 1], uinv, 2 * k);
      const pr = uinv[2 * k];
      const pim = uinv[2 * k + 1];
      for (let t = lp[k]; t < lp[k + 1]; t++) {
        const i = li[t];
        const xr = x[2 * i];
        const xim = x[2 * i + 1];
        lx[2 * t] = xr * pr - xim * pim;
        lx[2 * t + 1] = xr * pim + xim * pr;
      }
    }
    return REPLAY_OK;
  }

  /** Solves `A x = b` in place over the interleaved `b[0 … 2n)` with valid `factors`. */
  solve(factors: ComplexSparseFactors, b: Float64Array): void {
    if (!factors.valid || factors.order === null) throw new Error('ComplexSparseLu.solve: no successful factorisation');
    const n = factors.n;
    if (b.length < 2 * n) throw new RangeError(`ComplexSparseLu.solve: right-hand side shorter than 2 × ${n}`);
    this.reserve(n);
    const { lp, li, lx, up, ui, ux, uinv, prow } = factors;
    const q = factors.order;
    const z = this.work;
    // Forward: L y = P b, in original row numbering; y by step into z.
    for (let k = 0; k < n; k++) {
      const yr = b[2 * prow[k]];
      const yi = b[2 * prow[k] + 1];
      z[2 * k] = yr;
      z[2 * k + 1] = yi;
      if (yr === 0 && yi === 0) continue;
      for (let t = lp[k]; t < lp[k + 1]; t++) {
        const r = li[t];
        const lr = lx[2 * t];
        const lim = lx[2 * t + 1];
        b[2 * r] -= lr * yr - lim * yi;
        b[2 * r + 1] -= lr * yi + lim * yr;
      }
    }
    // Backward: U w = y, column-oriented, in step numbering.
    for (let k = n - 1; k >= 0; k--) {
      const sr = z[2 * k];
      const si = z[2 * k + 1];
      const pr = uinv[2 * k];
      const pim = uinv[2 * k + 1];
      const wr = sr * pr - si * pim;
      const wi = sr * pim + si * pr;
      z[2 * k] = wr;
      z[2 * k + 1] = wi;
      if (wr === 0 && wi === 0) continue;
      for (let t = up[k]; t < up[k + 1]; t++) {
        const s = ui[t];
        const ur = ux[2 * t];
        const uim = ux[2 * t + 1];
        z[2 * s] -= ur * wr - uim * wi;
        z[2 * s + 1] -= ur * wi + uim * wr;
      }
    }
    // x = Q w.
    for (let k = 0; k < n; k++) {
      b[2 * q[k]] = z[2 * k];
      b[2 * q[k] + 1] = z[2 * k + 1];
    }
  }
}
