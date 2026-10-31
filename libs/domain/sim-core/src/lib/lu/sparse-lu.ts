/*
 * Sparse LU with threshold partial pivoting (plan F2.2 part 3), reimplemented from the published
 * algorithm: J. R. Gilbert and T. Peierls, "Sparse Partial Pivoting in Time Proportional to
 * Arithmetic Operations", SIAM J. Sci. Stat. Comput. 9(5), 1988, doi:10.1137/0909058. Threshold
 * pivoting as in I. S. Duff, A. M. Erisman and J. K. Reid, "Direct Methods for Sparse Matrices"
 * (Oxford, 1986), §7.8. No third-party code: written from the papers, without reading any
 * implementation.
 *
 * Left-looking, one column at a time, in a fixed column order `q` (AMD's, `amd.ts`). For column k:
 *
 * 1. **Symbolic:** the rows that column A(:, q[k]) reaches through the graph of the L columns already
 *    computed (an edge from a pivotal row to every row of its L column) are found by depth-first
 *    search; the reverse postorder is a topological order (Gilbert–Peierls's key result: the
 *    pattern of the sparse triangular solve L x = A(:, q[k]) is exactly that reach).
 * 2. **Numeric:** x = A(:, q[k]) is scattered, then for each reached pivotal row i, in topological
 *    order, x −= L(:, pinv[i]) · x[i]. The reached pivotal rows give U(:, k).
 * 3. **Pivot:** among the reached rows not yet pivotal, the largest |x| (the lowest row on a tie)
 *    unless the "diagonal" row q[k] has at least `threshold` times its magnitude, which is then kept.
 *    The rest, divided by the pivot, give L(:, k).
 *
 * So P A Q = L U, with L unit lower triangular stored in original row numbering.
 *
 * **Replay.** The factors live in a `SparseFactors` object the caller keeps per matrix pattern (the
 * factorisation cache keeps one per island). When it already holds a factorisation of the same
 * pattern, order and threshold, `factor` first *replays* it: it reuses the L and U patterns and the
 * pivot sequence, skipping the depth-first searches, and recomputes every value in the same order a
 * fresh factorisation would. At every column it applies the full pivot rule to the replayed
 * candidates; if the rule would pick another row (the values moved too far), it starts again with a
 * fresh factorisation. So a replay is accepted only when a fresh factorisation would have made the
 * same pivot choices, hence the same reach, the same operations in the same order and the same bits:
 * a warm factorisation is bit-identical to a cold one by construction.
 *
 * Deterministic: a fixed column order, a fixed scan order of each column, a pivot rule that doesn't
 * depend on scan order, and IEEE-exact operations only (D6). Storage grows (doubling) only when a
 * factorisation needs more, so steady-state solves allocate nothing.
 */

/** A compressed sparse column pattern of an `n × n` matrix: rows ascending within each column. */
export interface CscPattern {
  readonly n: number;
  /** Column `j`'s entries are `colPtr[j] … colPtr[j + 1] − 1`. */
  readonly colPtr: Int32Array;
  readonly rowIdx: Int32Array;
}

/** Visit generations are reset at 2^30, well inside `Int32Array`'s range. */
const VISIT_GENERATION_LIMIT = 0x40000000;

/** One matrix's LU factors (P A Q = L U), reusable by a later factorisation of the same pattern. */
export class SparseFactors {
  n = 0;
  /** Whether the factors are a successful factorisation of `pattern` in `order` at `threshold`. */
  valid = false;
  pattern: CscPattern | null = null;
  order: Int32Array | null = null;
  threshold = 0;
  // L: unit lower triangle, original row numbers, by step.
  lp = new Int32Array(1);
  li = new Int32Array(16);
  lx = new Float64Array(16);
  // U: strictly upper part by step (entries are step numbers, in topological order), diagonal apart.
  up = new Int32Array(1);
  ui = new Int32Array(16);
  ux = new Float64Array(16);
  udiag = new Float64Array(0);
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
    this.udiag = new Float64Array(n);
    this.pinv = new Int32Array(n);
    this.prow = new Int32Array(n);
  }

  growL(needed: number): void {
    if (needed <= this.li.length) return;
    const size = Math.max(needed, 2 * this.li.length);
    const li = new Int32Array(size);
    li.set(this.li);
    const lx = new Float64Array(size);
    lx.set(this.lx);
    this.li = li;
    this.lx = lx;
  }

  growU(needed: number): void {
    if (needed <= this.ui.length) return;
    const size = Math.max(needed, 2 * this.ui.length);
    const ui = new Int32Array(size);
    ui.set(this.ui);
    const ux = new Float64Array(size);
    ux.set(this.ux);
    this.ui = ui;
    this.ux = ux;
  }
}

/** The sparse LU kernels and their workspace. One per solver; the factors are passed in. */
export class SparseLu {
  /** Factorisations done by replaying the previous pivot sequence (counters for tests and the bench). */
  replays = 0;
  /** Factorisations done afresh, including replays that fell back. */
  fresh = 0;
  /** Replays abandoned because the pivot rule chose another row. */
  fallbacks = 0;
  private x = new Float64Array(0);
  private xi = new Int32Array(0);
  private stack = new Int32Array(0);
  private cursor = new Int32Array(0);
  private visited = new Int32Array(0);
  private visitGen = 0;
  private work = new Float64Array(0);

  private reserve(n: number): void {
    if (this.x.length >= n) return;
    this.x = new Float64Array(n);
    this.xi = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.cursor = new Int32Array(n);
    this.visited = new Int32Array(n);
    this.visitGen = 0;
    this.work = new Float64Array(n);
  }

  /**
   * Factors the matrix with `pattern` and entries `values` (aligned with `pattern.rowIdx`) in the
   * column order `order` (a permutation of `0 … n − 1`), into `factors`. `threshold` in (0, 1] is the
   * diagonal preference: 1 is plain partial pivoting. Replays `factors` when they hold a
   * factorisation of the same pattern, order and threshold (see the file comment). Returns `false`
   * when the matrix is numerically singular: some column had no non-zero candidate, or a candidate
   * was not finite; the factors are then invalid and `solve` throws.
   */
  factor(
    pattern: CscPattern,
    values: Float64Array,
    order: Int32Array,
    threshold: number,
    factors: SparseFactors,
  ): boolean {
    const n = pattern.n;
    if (order.length < n) throw new RangeError(`SparseLu: column order shorter than ${n}`);
    if (!(threshold > 0 && threshold <= 1))
      throw new RangeError(`SparseLu: threshold must be in (0, 1], got ${threshold}`);
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
    f: SparseFactors,
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
      // 1. Symbolic: the reach of A(:, col), into xi[top … n) in topological order. The visit marks
      // are generation-stamped (no clearing per column) and reset long before an Int32 would wrap.
      if (this.visitGen >= VISIT_GENERATION_LIMIT) {
        this.visited.fill(0);
        this.visitGen = 0;
      }
      const gen = ++this.visitGen;
      let top = n;
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) {
        const root = rowIdx[p];
        if (this.visited[root] !== gen) top = this.reach(f, root, top, gen);
      }
      // 2. Numeric: x = L⁻¹ A(:, col) over the reach.
      for (let p = top; p < n; p++) x[xi[p]] = 0;
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) x[rowIdx[p]] = values[p];
      const lp = f.lp;
      const li = f.li;
      const lx = f.lx;
      let upperCount = 0;
      for (let p = top; p < n; p++) {
        const i = xi[p];
        const j = pinv[i];
        if (j < 0) continue;
        upperCount++;
        const xj = x[i];
        if (xj === 0) continue;
        for (let t = lp[j]; t < lp[j + 1]; t++) x[li[t]] -= lx[t] * xj;
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
        const a = Math.abs(x[i]);
        // `!(a < Infinity)` also catches NaN; an infinite entry spreads NaN through later columns.
        if (!(a < Infinity)) return false;
        if (i === col) diagonalAbs = a;
        if (a > pivotAbs || (a === pivotAbs && i < pivotRow)) {
          pivotAbs = a;
          pivotRow = i;
        }
      }
      if (candidates === 0 || !(pivotAbs > 0)) return false;
      if (diagonalAbs >= threshold * pivotAbs) pivotRow = col;
      const pivot = x[pivotRow];
      pinv[pivotRow] = k;
      f.prow[k] = pivotRow;
      f.udiag[k] = pivot;
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
        if (j >= 0) {
          ui[u] = j;
          ux[u++] = x[i];
        } else {
          li2[l] = i;
          lx2[l++] = x[i] / pivot;
        }
      }
      f.up[k + 1] = u;
      f.lp[k + 1] = l;
    }
    return true;
  }

  /**
   * Recomputes `f`'s values for new `values`, keeping its patterns and pivot sequence, and checks the
   * pivot rule at every column. U(:, k)'s entries are stored in the fresh factorisation's topological
   * order, so the updates run in the same order; the pivot rule (largest |x|, lowest row on a tie,
   * the diagonal kept above the threshold) doesn't depend on the order candidates are scanned in.
   */
  private replay(
    pattern: CscPattern,
    values: Float64Array,
    order: Int32Array,
    threshold: number,
    f: SparseFactors,
  ): number {
    const n = pattern.n;
    const { colPtr, rowIdx } = pattern;
    const { lp, li, lx, up, ui, ux, udiag, prow } = f;
    const x = this.x;
    for (let k = 0; k < n; k++) {
      const col = order[k];
      const pivotRow = prow[k];
      // Zero x over the column's pattern (U rows, the pivot, L rows), scatter A(:, col).
      for (let t = up[k]; t < up[k + 1]; t++) x[prow[ui[t]]] = 0;
      x[pivotRow] = 0;
      for (let t = lp[k]; t < lp[k + 1]; t++) x[li[t]] = 0;
      for (let p = colPtr[col]; p < colPtr[col + 1]; p++) x[rowIdx[p]] = values[p];
      for (let t = up[k]; t < up[k + 1]; t++) {
        const j = ui[t];
        const xj = x[prow[j]];
        ux[t] = xj;
        if (xj === 0) continue;
        for (let s = lp[j]; s < lp[j + 1]; s++) x[li[s]] -= lx[s] * xj;
      }
      // The pivot rule over the candidates: the pivot row and L(:, k)'s rows.
      let best = pivotRow;
      let bestAbs = Math.abs(x[pivotRow]);
      if (!(bestAbs < Infinity)) return REPLAY_SINGULAR;
      let diagonalAbs = pivotRow === col ? bestAbs : -1;
      for (let t = lp[k]; t < lp[k + 1]; t++) {
        const i = li[t];
        const a = Math.abs(x[i]);
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
      const pivot = x[pivotRow];
      udiag[k] = pivot;
      for (let t = lp[k]; t < lp[k + 1]; t++) lx[t] = x[li[t]] / pivot;
    }
    return REPLAY_OK;
  }

  /**
   * Depth-first search from `root` over the graph of L, pushing finished rows onto `xi` from `top`
   * downwards (so `xi[top … n)` ends up in reverse postorder). Iterative, so a long chain (a radial
   * feeder) can't overflow the call stack. Returns the new `top`.
   */
  private reach(f: SparseFactors, root: number, top: number, gen: number): number {
    const stack = this.stack;
    const cursor = this.cursor;
    const visited = this.visited;
    const pinv = f.pinv;
    const lp = f.lp;
    const li = f.li;
    let depth = 0;
    stack[0] = root;
    visited[root] = gen;
    const j0 = pinv[root];
    cursor[0] = j0 >= 0 ? lp[j0] : 0;
    while (depth >= 0) {
      const i = stack[depth];
      const j = pinv[i];
      let descended = false;
      if (j >= 0) {
        const end = lp[j + 1];
        for (let t = cursor[depth]; t < end; t++) {
          const child = li[t];
          if (visited[child] === gen) continue;
          cursor[depth] = t + 1;
          visited[child] = gen;
          depth++;
          stack[depth] = child;
          const jc = pinv[child];
          cursor[depth] = jc >= 0 ? lp[jc] : 0;
          descended = true;
          break;
        }
      }
      if (!descended) {
        this.xi[--top] = i;
        depth--;
      }
    }
    return top;
  }

  /** Solves `A x = b` in place over `b[0 … n)` with valid `factors`. */
  solve(factors: SparseFactors, b: Float64Array): void {
    if (!factors.valid || factors.order === null) throw new Error('SparseLu.solve: no successful factorisation');
    const n = factors.n;
    if (b.length < n) throw new RangeError(`SparseLu.solve: right-hand side shorter than ${n}`);
    this.reserve(n);
    const { lp, li, lx, up, ui, ux, udiag, prow } = factors;
    const q = factors.order;
    const z = this.work;
    // Forward: L y = P b, in original row numbering; y by step into z.
    for (let k = 0; k < n; k++) {
      const yk = b[prow[k]];
      z[k] = yk;
      if (yk === 0) continue;
      for (let t = lp[k]; t < lp[k + 1]; t++) b[li[t]] -= lx[t] * yk;
    }
    // Backward: U w = y, column-oriented, in step numbering.
    for (let k = n - 1; k >= 0; k--) {
      const wk = z[k] / udiag[k];
      z[k] = wk;
      if (wk === 0) continue;
      for (let t = up[k]; t < up[k + 1]; t++) z[ui[t]] -= ux[t] * wk;
    }
    // x = Q w.
    for (let k = 0; k < n; k++) b[q[k]] = z[k];
  }
}

const REPLAY_OK = 0;
const REPLAY_SINGULAR = 1;
const REPLAY_MISMATCH = 2;
