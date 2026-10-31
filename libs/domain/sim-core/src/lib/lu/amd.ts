/*
 * Approximate minimum degree (AMD) ordering (plan F2.2 part 3), reimplemented from the published
 * algorithm: P. R. Amestoy, T. A. Davis and I. S. Duff, "An Approximate Minimum Degree Ordering
 * Algorithm", SIAM J. Matrix Anal. Appl. 17(4), 1996, doi:10.1137/S0895479894278952 (§2–§4: the
 * quotient graph, the approximate external degree, element absorption and supervariables). No
 * third-party code: written from the paper, without reading any implementation.
 *
 * It orders the symmetric pattern of A + Aᵀ (the diagonal ignored) so that eliminating the variables
 * in that order makes little fill-in. Sparse LU (`sparse-lu.ts`) takes the result as its column order.
 *
 * The quotient graph keeps, for each uneliminated variable i, its adjacent variables A_i and adjacent
 * elements E_i, and for each element e (an eliminated pivot) its variables L_e. Eliminating the pivot
 * p of least approximate degree makes p an element with L_p = A_p ∪ (∪_{e ∈ E_p} L_e) \ {p}, absorbing
 * every element of E_p. Each i in L_p then gets the paper's approximate external degree
 *
 *   d_i = min(remaining − |i|, d_i(old) + |L_p \ i|, |A_i \ i| + |L_p \ i| + Σ_{e ∈ E_i \ p} |L_e \ L_p|),
 *
 * with |L_e \ L_p| found for all e at once by subtracting each i ∈ L_p from |L_e| (§4). An element
 * whose L_e lies inside L_p is absorbed (aggressive absorption). Variables of L_p with the same
 * adjacency become one supervariable (|i| > 1), eliminated together (mass elimination).
 *
 * Rows denser than max(16, 10·√n) are left out of the graph and ordered last, ascending: the AMD user
 * guide's default treatment of dense rows (a floating component's sum row, `mna/dc.ts`, is one).
 *
 * Deterministic: lists are built and scanned in ascending or insertion order, degree buckets are
 * LIFO lists, supervariable candidates are compared in (hash, index) order, and only integer
 * arithmetic and `Math.sqrt` are used. The same pattern always gives the same permutation.
 */

const VARIABLE = 0;
const ELEMENT = 1;
const ABSORBED = 2;
const MERGED = 3;
const DENSE = 4;

/**
 * The AMD elimination order of the symmetric pattern of `A + Aᵀ`, where `A` is `n × n` in CSC
 * (`colPtr`, `rowIdx`; values are not needed). `order[k]` is the variable eliminated `k`-th: a
 * permutation of `0 … n − 1`.
 */
export function amdOrder(n: number, colPtr: Int32Array, rowIdx: Int32Array): Int32Array {
  const order = new Int32Array(n);
  if (n === 0) return order;

  // A + Aᵀ without the diagonal: ascending, duplicate-free adjacency lists.
  const raw: number[][] = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j++) {
    for (let p = colPtr[j]; p < colPtr[j + 1]; p++) {
      const i = rowIdx[p];
      if (i === j) continue;
      raw[i].push(j);
      raw[j].push(i);
    }
  }
  const vars: number[][] = raw.map((list) => {
    list.sort((x, y) => x - y);
    const unique: number[] = [];
    for (const v of list) if (unique.length === 0 || unique[unique.length - 1] !== v) unique.push(v);
    return unique;
  });

  const status = new Uint8Array(n);
  const dense = Math.max(16, Math.floor(10 * Math.sqrt(n)));
  let denseCount = 0;
  for (let i = 0; i < n; i++) {
    if (vars[i].length > dense) {
      status[i] = DENSE;
      denseCount++;
    }
  }
  if (denseCount > 0) {
    for (let i = 0; i < n; i++) if (status[i] !== DENSE) vars[i] = vars[i].filter((v) => status[v] !== DENSE);
  }

  const elems: number[][] = Array.from({ length: n }, () => []);
  const elementVars: (number[] | null)[] = new Array<number[] | null>(n).fill(null);
  const members: number[][] = Array.from({ length: n }, () => []);
  const nv = new Int32Array(n).fill(1);
  const degree = new Int32Array(n);

  // Degree buckets: doubly linked LIFO lists.
  const head = new Int32Array(n + 1).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const insert = (i: number, d: number) => {
    prev[i] = -1;
    next[i] = head[d];
    if (head[d] >= 0) prev[head[d]] = i;
    head[d] = i;
  };
  const remove = (i: number) => {
    if (prev[i] >= 0) next[prev[i]] = next[i];
    else head[degree[i]] = next[i];
    if (next[i] >= 0) prev[next[i]] = prev[i];
    prev[i] = -1;
    next[i] = -1;
  };

  let remaining = n - denseCount;
  for (let i = 0; i < n; i++) {
    if (status[i] !== VARIABLE) continue;
    degree[i] = vars[i].length;
    insert(i, degree[i]);
  }

  const mark = new Int32Array(n);
  let markGen = 0;
  const wStamp = new Int32Array(n);
  const wValue = new Int32Array(n);
  let wGen = 0;
  const weight = (list: readonly number[]) => {
    let w = 0;
    for (const v of list) if (status[v] === VARIABLE) w += nv[v];
    return w;
  };

  let k = 0;
  let minDegree = 0;
  while (remaining > 0) {
    while (head[minDegree] < 0) minDegree++;
    const p = head[minDegree];
    remove(p);

    // L_p: p's variables and those of every element adjacent to p, which p absorbs.
    markGen++;
    mark[p] = markGen;
    const lp: number[] = [];
    for (const v of vars[p]) {
      if (status[v] === VARIABLE && mark[v] !== markGen) {
        mark[v] = markGen;
        lp.push(v);
      }
    }
    for (const e of elems[p]) {
      if (status[e] !== ELEMENT) continue;
      for (const v of elementVars[e] as number[]) {
        if (status[v] === VARIABLE && mark[v] !== markGen) {
          mark[v] = markGen;
          lp.push(v);
        }
      }
      status[e] = ABSORBED;
      elementVars[e] = null;
    }
    status[p] = ELEMENT;
    vars[p] = [];
    elems[p] = [];
    order[k++] = p;
    for (const m of members[p]) order[k++] = m;
    remaining -= nv[p];
    const lpWeight = weight(lp);

    // |L_e \ L_p| for every element adjacent to a variable of L_p (paper §4).
    wGen++;
    for (const i of lp) {
      for (const e of elems[i]) {
        if (status[e] !== ELEMENT) continue;
        if (wStamp[e] !== wGen) {
          wStamp[e] = wGen;
          wValue[e] = weight(elementVars[e] as number[]) - nv[i];
        } else {
          wValue[e] -= nv[i];
        }
      }
    }

    // Prune each i ∈ L_p's lists and give it its approximate external degree.
    for (const i of lp) {
      remove(i);
      const keptElems: number[] = [];
      let external = 0;
      for (const e of elems[i]) {
        if (status[e] !== ELEMENT) continue;
        if (wValue[e] === 0) {
          // L_e ⊆ L_p: aggressive absorption into p.
          status[e] = ABSORBED;
          elementVars[e] = null;
          continue;
        }
        keptElems.push(e);
        external += wValue[e];
      }
      keptElems.push(p);
      elems[i] = keptElems;
      const keptVars: number[] = [];
      let varWeight = 0;
      for (const v of vars[i]) {
        if (status[v] !== VARIABLE || mark[v] === markGen) continue;
        keptVars.push(v);
        varWeight += nv[v];
      }
      vars[i] = keptVars;
      const others = lpWeight - nv[i];
      let d = varWeight + others + external;
      d = Math.min(d, degree[i] + others, remaining - nv[i]);
      degree[i] = Math.max(d, 0);
    }

    // Supervariables: variables of L_p with identical (A_i, E_i) merge into the smallest-indexed one.
    const hashes = new Map<number, number>();
    for (const i of lp) {
      vars[i].sort((x, y) => x - y);
      elems[i].sort((x, y) => x - y);
      let h = 0;
      for (const v of vars[i]) h = (h + v + 1) % 1_000_003;
      for (const e of elems[i]) h = (h + 7 * (e + 1)) % 1_000_003;
      hashes.set(i, h);
    }
    const candidates = lp.slice().sort((x, y) => (hashes.get(x) as number) - (hashes.get(y) as number) || x - y);
    for (let s = 0; s < candidates.length; s++) {
      const i = candidates[s];
      if (status[i] !== VARIABLE) continue;
      const hi = hashes.get(i);
      for (let t = s + 1; t < candidates.length && hashes.get(candidates[t]) === hi; t++) {
        const j = candidates[t];
        if (status[j] !== VARIABLE || !sameList(vars[i], vars[j]) || !sameList(elems[i], elems[j])) continue;
        degree[i] = Math.max(degree[i] - nv[j], 0);
        nv[i] += nv[j];
        members[i].push(j, ...members[j]);
        members[j] = [];
        nv[j] = 0;
        status[j] = MERGED;
        vars[j] = [];
        elems[j] = [];
      }
    }

    const principal: number[] = [];
    for (const i of lp) {
      if (status[i] !== VARIABLE) continue;
      principal.push(i);
      insert(i, degree[i]);
      if (degree[i] < minDegree) minDegree = degree[i];
    }
    elementVars[p] = principal;
  }

  for (let i = 0; i < n; i++) if (status[i] === DENSE) order[k++] = i;
  return order;
}

function sameList(x: readonly number[], y: readonly number[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
