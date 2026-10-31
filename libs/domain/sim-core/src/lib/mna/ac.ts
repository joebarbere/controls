import { GMIN_S, PIVOT_THRESHOLD, SPARSE_MIN_UNKNOWNS } from '../constants';
import { ComplexDenseLu } from '../lu/complex-dense-lu';
import { ComplexSparseFactors, ComplexSparseLu } from '../lu/complex-sparse-lu';
import type { Netlist, NetlistIsland } from '../netlist/types';
import {
  AC_STAMP_CAPACITOR,
  AC_STAMP_INDUCTOR,
  AC_STAMP_RESISTOR,
  AC_STAMP_UNSET,
  AC_STAMP_VSOURCE,
  type AcBranchValues,
} from './ac-values';
import {
  createDcSolution,
  type DcIslandResult,
  type DcSolution,
  ISLAND_FLAG_SINGULAR,
  islandReferenceNode,
} from './dc';
import { FactorisationCache, type IslandSymbolic } from './factorisation-cache';
import { angularFrequency } from './phasor';
import { buildSymbolic, endsChecksum, find, grow, type StampProgram } from './shared';

/*
 * Phasor (AC steady-state) modified nodal analysis (plan F2.2 part 2): the DC solver's formulation
 * (Ho, Ruehli and Brennan 1975, `dc.ts`) in complex arithmetic, at one angular frequency ω = 2π f,
 * the region's (`RegionProfile.frequencyHz`, 60 Hz for NEC). Each `ac` island is solved on its own
 * against its reference node (the negative end of its first `vsource` element, else its smallest
 * node), with the same unknowns in the same order as DC:
 *
 * 1. the voltage phasor of every other node of the island, in ascending node order;
 * 2. the current phasor of every `vsource` element, in ascending branch order.
 *
 * Rows are KCL at each non-reference node (Σ y (Va − Vb) + gmin · V + source currents = 0), then one
 * row per source: Vb − Va + R·I = E. Values are RMS phasors (ADR 0011 §5.3), interleaved `re, im` in
 * the solution record exactly as DC's are, so `DcSolution` is the record for both.
 *
 * Stamps (`ac-values.ts`): a resistor's admittance 1 / R, an inductor's 1 / (jωL) = −j / (ωL), a
 * capacitor's jωC, all four-entry two-terminal stamps; `gmin` (real) from every node to the reference;
 * a voltage source's ±1 incidence and its series R. Every matrix entry is complex and stored
 * interleaved (`ComplexDenseLu`, `ComplexSparseLu`).
 *
 * **Singular is still structural.** With M = [[Y, B], [−Bᵀ, R]], Re(xᴴ M x) = Vᴴ Re(Y) V + Iᴴ R I
 * (the incidence terms cancel to an imaginary part, and an inductor's or capacitor's admittance is
 * purely imaginary, so it adds nothing real). Re(Y) holds gmin on every node, so the real part is
 * positive unless V = 0 and current flows only in zero-ohm sources; M x = 0 then needs a current
 * circulating through those sources: a loop of ideal sources. So M is singular exactly when the
 * island's zero-ohm sources close a loop, as in DC, and the same union-find decides it before any
 * arithmetic; a zero or non-finite pivot or result is the numerical backstop. A singular island is
 * all +0, never NaN. An L–C pair at resonance is not singular (gmin holds it), only ill-conditioned:
 * its circulating current is physical for ideal parts.
 *
 * **No floating components.** Every AC stamp conducts (there is no AC current source, `ac-values.ts`),
 * so an island is one conductive component holding its reference, and the DC solver's floating-
 * component pinning isn't needed.
 *
 * **Dense or sparse,** as in DC (part 3): fewer than `SPARSE_MIN_UNKNOWNS` unknowns go to complex
 * dense LU, more to complex sparse LU in AMD order, whose symbolic factorisation (the pattern, the
 * slot map, the order and the recorded stamp program) is cached by `topologyHash`, island and stamp
 * classes. The program records value *codes* (gmin, ±1, R, ±y), never values: each solve recomputes
 * every admittance from its own ω and values, and the numeric factorisation replays the last pivot
 * sequence only when the full pivot rule still picks it (`complex-sparse-lu.ts`), so a cached
 * factorisation is never reused across a frequency or value change.
 *
 * **Islands it solves:** `ac` only. `dc` and `empty` islands are the DC solver's, and `mixed` islands
 * stay a diagnostic (P2 has no converters), so `solve` leaves every other island's entries as they
 * are in `out`. Solve DC first, then AC, into the same record: `DcSolver.solve` zeroes every island
 * it doesn't solve.
 */

/** How an `AcSolver` is set up. */
export interface AcSolverOptions {
  /** Islands with at least this many unknowns are solved by sparse LU (`SPARSE_MIN_UNKNOWNS` by default). */
  readonly sparseMinUnknowns?: number;
  /** The factorisation cache, which may be shared between AC solvers; a private one by default. */
  readonly cache?: FactorisationCache<ComplexSparseFactors>;
}

const MODE_DENSE = 0;
const MODE_RECORD = 1;

// How a stamp-program step recomputes its value: exactly as `stamp` does.
const VALUE_GMIN = 0;
const VALUE_ONE = 1;
const VALUE_MINUS_ONE = 2;
/** `ohms[b]` (real). */
const VALUE_OHMS = 3;
/** The branch's admittance y (complex). */
const VALUE_Y = 4;
/** −y. */
const VALUE_MINUS_Y = 5;
// The only right-hand-side step: a source row's EMF phasor.
const RHS_SET_EMF = 0;

/** The cache signature's per-branch class: every passive stamp has one pattern; a source another. */
const CLASS_PASSIVE = 1;
const CLASS_SOURCE = 2;

/** The solution record's island fields, for `ac` islands (no allocation). */
function setRecord(result: DcIslandResult, reference: number, unknowns: number): void {
  result.solved = true;
  result.referenceNode = reference;
  result.unknowns = unknowns;
  result.flags = 0;
  result.iterations = 1;
}

/**
 * Solves netlists' `ac` islands as phasors. Reuse one solver: its LU storage, index maps and
 * factorisation cache grow to the largest system seen and are then reused, so a steady-state solve
 * allocates nothing. Reuse never changes a result: every solve is a pure function of the netlist,
 * the values and the frequency.
 */
export class AcSolver {
  /** Islands with at least this many unknowns go to sparse LU. */
  readonly sparseMinUnknowns: number;
  /** The factorisation cache (sparse islands' symbolic factorisations, by `topologyHash`). */
  readonly cache: FactorisationCache<ComplexSparseFactors>;
  private readonly lu = new ComplexDenseLu();
  /** The sparse kernels and workspace; `sparse.replays` and `.fresh` count numeric factorisations. */
  readonly sparse = new ComplexSparseLu();
  private nodeUnknown = new Int32Array(0);
  private branchUnknown = new Int32Array(0);
  private parent = new Int32Array(0);
  /** Each branch's admittance at this solve's ω (passive branches of the current island). */
  private yRe = new Float64Array(0);
  private yIm = new Float64Array(0);
  /** The interleaved right-hand side, then solution. */
  private rhs = new Float64Array(0);
  private a: Float64Array = new Float64Array(0);
  private n = 0;
  private mode = MODE_DENSE;
  private tripletRow = new Int32Array(256);
  private tripletCol = new Int32Array(256);
  private callCode = new Uint8Array(256);
  private callBranch = new Int32Array(256);
  private calls = 0;
  private rhsTarget = new Int32Array(64);
  private rhsCode = new Uint8Array(64);
  private rhsBranch = new Int32Array(64);
  private rhsCalls = 0;
  /** ω for `omegaHz`, the last solve's frequency (see `solve`). */
  private readonly omega = new Float64Array(1);
  private omegaHz = Number.NaN;
  /** The series resistances `stamp` is stamping, read by `add` through a branch index. */
  private stampOhms: Float64Array = new Float64Array(0);
  /** The sparse matrix's values (interleaved), aligned with the current pattern. */
  private sparseValues = new Float64Array(0);
  private signature = new Uint8Array(0);

  constructor(options: AcSolverOptions = {}) {
    const threshold = options.sparseMinUnknowns ?? SPARSE_MIN_UNKNOWNS.value;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError(`AcSolver: sparseMinUnknowns must be an integer ≥ 1, got ${threshold}`);
    }
    this.sparseMinUnknowns = threshold;
    this.cache = options.cache ?? new FactorisationCache<ComplexSparseFactors>();
  }

  /**
   * Solves every `ac` island of `netlist` at `frequencyHz` with `values`, into `out` if it fits (else
   * a new solution, whose other islands are zero and unsolved). Other islands' entries in `out` are
   * left untouched. Throws on a bad frequency, a missing value or a stamp that doesn't suit its
   * element kind (a programming error).
   */
  solve(netlist: Netlist, values: AcBranchValues, frequencyHz: number, out?: DcSolution): DcSolution {
    // ω kept in a slot, never passed or returned per solve: a double crossing a call V8 doesn't inline is
    // boxed into a heap number (1.6 B/step in a mixed-device process; simulation caveats).
    if (frequencyHz !== this.omegaHz) {
      this.omega[0] = angularFrequency(frequencyHz);
      this.omegaHz = frequencyHz;
    }
    if (values.count !== netlist.branches.length) {
      throw new RangeError(`AcSolver: ${values.count} values for ${netlist.branches.length} branches`);
    }
    const fits =
      out !== undefined &&
      out.nodes.length === 2 * netlist.nodes.length &&
      out.branches.length === 2 * netlist.branches.length &&
      out.islands.length === netlist.islands.length;
    const solution = fits ? out : createDcSolution(netlist);
    solution.topologyHash = netlist.topologyHash;
    if (this.nodeUnknown.length < netlist.nodes.length) {
      this.nodeUnknown = new Int32Array(netlist.nodes.length);
      this.parent = new Int32Array(netlist.nodes.length);
    }
    if (this.branchUnknown.length < netlist.branches.length) {
      this.branchUnknown = new Int32Array(netlist.branches.length);
      this.signature = new Uint8Array(netlist.branches.length);
      this.yRe = new Float64Array(netlist.branches.length);
      this.yIm = new Float64Array(netlist.branches.length);
    }
    for (let ii = 0; ii < netlist.islands.length; ii++) {
      const island = netlist.islands[ii];
      if (island.kind === 'ac') this.solveIsland(netlist, island, values, solution);
    }
    return solution;
  }

  private solveIsland(netlist: Netlist, island: NetlistIsland, values: AcBranchValues, solution: DcSolution): void {
    const omega = this.omega[0];
    const result = solution.islands[island.index];
    const reference = islandReferenceNode(netlist, island);
    const nodeUnknown = this.nodeUnknown;
    const branchUnknown = this.branchUnknown;
    let n = 0;
    for (let ni = 0; ni < island.nodes.length; ni++) {
      const node = island.nodes[ni];
      nodeUnknown[node] = node === reference ? -1 : n++;
    }
    for (let bi = 0; bi < island.branches.length; bi++) {
      const index = island.branches[bi];
      const branch = netlist.branches[index];
      const stamp = values.stamps[index];
      if (stamp === AC_STAMP_UNSET) throw new Error(`AcSolver: branch ${index} has no AC value`);
      if (branch.kind === 'vsource') {
        if (stamp !== AC_STAMP_VSOURCE) throw new Error(`AcSolver: vsource branch ${index} stamped as passive`);
        branchUnknown[index] = n++;
      } else {
        if (stamp === AC_STAMP_VSOURCE) throw new Error(`AcSolver: resistor branch ${index} stamped as a vsource`);
        branchUnknown[index] = -1;
        this.admittance(index, stamp, values);
      }
    }
    setRecord(result, reference, n);

    if (this.hasIdealSourceLoop(netlist, island, values)) {
      this.singular(netlist, island, solution, result);
      return;
    }

    if (this.rhs.length < 2 * n) this.rhs = new Float64Array(2 * n);
    const rhs = this.rhs;
    rhs.fill(0, 0, 2 * n);
    this.n = n;

    let factored: boolean;
    if (n < this.sparseMinUnknowns) {
      this.mode = MODE_DENSE;
      this.a = this.lu.begin(n);
      this.stamp(netlist, island, values);
      factored = this.lu.factor();
      if (factored) this.lu.solve(rhs);
    } else {
      const symbolic = this.symbolic(netlist, island, values, n);
      this.assemble(symbolic, values, rhs);
      factored = this.sparse.factor(
        symbolic.pattern,
        this.sparseValues,
        symbolic.order,
        PIVOT_THRESHOLD.value,
        symbolic.factors,
      );
      if (factored) this.sparse.solve(symbolic.factors, rhs);
    }
    if (!factored) {
      this.singular(netlist, island, solution, result);
      return;
    }

    const nodes = solution.nodes;
    const branches = solution.branches;
    let ok = true;
    for (let ni = 0; ni < island.nodes.length; ni++) {
      const node = island.nodes[ni];
      const i = nodeUnknown[node];
      const re = i >= 0 ? rhs[2 * i] + 0 : 0;
      const im = i >= 0 ? rhs[2 * i + 1] + 0 : 0;
      if (!Number.isFinite(re) || !Number.isFinite(im)) ok = false;
      nodes[2 * node] = re;
      nodes[2 * node + 1] = im;
    }
    for (let bi = 0; bi < island.branches.length; bi++) {
      const index = island.branches[bi];
      const branch = netlist.branches[index];
      const k = branchUnknown[index];
      let re: number;
      let im: number;
      if (k >= 0) {
        re = rhs[2 * k];
        im = rhs[2 * k + 1];
      } else {
        // I = y (Va − Vb), from the node phasors just written.
        const dr = nodes[2 * branch.a] - nodes[2 * branch.b];
        const di = nodes[2 * branch.a + 1] - nodes[2 * branch.b + 1];
        const yr = this.yRe[index];
        const yi = this.yIm[index];
        re = yr * dr - yi * di;
        im = yr * di + yi * dr;
      }
      re += 0; // −0 becomes +0, so every stored value has one bit pattern (inline: a call returning a double boxes it)
      im += 0;
      if (!Number.isFinite(re) || !Number.isFinite(im)) ok = false;
      branches[2 * index] = re;
      branches[2 * index + 1] = im;
    }
    if (!ok) this.singular(netlist, island, solution, result);
  }

  /** Writes a passive branch's admittance at ω into `yRe`, `yIm`. */
  private admittance(index: number, stamp: number, values: AcBranchValues): void {
    const omega = this.omega[0];
    if (stamp === AC_STAMP_RESISTOR) {
      this.yRe[index] = 1 / values.ohms[index];
      this.yIm[index] = 0;
    } else if (stamp === AC_STAMP_INDUCTOR) {
      // 1 / (jωL) = −j / (ωL).
      this.yRe[index] = 0;
      this.yIm[index] = -(1 / (omega * values.henries[index]));
    } else if (stamp === AC_STAMP_CAPACITOR) {
      this.yRe[index] = 0;
      this.yIm[index] = omega * values.farads[index];
    } else {
      throw new Error(`AcSolver: branch ${index} has an unknown AC stamp ${stamp}`);
    }
  }

  /**
   * The island's symbolic factorisation: from the cache, or built by stamping once in record mode and
   * ordering with AMD, then cached. Its signature is each branch's pattern class (passive or source),
   * a function of the topology: R, L and C share one pattern.
   */
  private symbolic(
    netlist: Netlist,
    island: NetlistIsland,
    values: AcBranchValues,
    n: number,
  ): IslandSymbolic<ComplexSparseFactors> {
    const signature = this.signature;
    const count = island.branches.length;
    for (let i = 0; i < count; i++) {
      signature[i] = values.stamps[island.branches[i]] === AC_STAMP_VSOURCE ? CLASS_SOURCE : CLASS_PASSIVE;
    }
    const ends = endsChecksum(netlist, island);
    const cached = this.cache.find(netlist.topologyHash, island.index, signature, count);
    if (cached !== undefined) {
      if (cached.unknowns !== n) {
        throw new Error(
          `AcSolver: island ${island.index} has ${n} unknowns but its cached symbolic factorisation ${cached.unknowns}: two netlists share topologyHash ${netlist.topologyHash}`,
        );
      }
      if (cached.ends !== ends) {
        throw new Error(
          `AcSolver: island ${island.index}'s branch ends differ from its cached symbolic factorisation: a stale or mismatched topologyHash ${netlist.topologyHash}`,
        );
      }
      return cached;
    }
    this.mode = MODE_RECORD;
    this.calls = 0;
    this.rhsCalls = 0;
    this.stamp(netlist, island, values);
    const built = buildSymbolic(
      n,
      this.program(),
      signature.slice(0, count),
      new Int32Array(0),
      ends,
      new ComplexSparseFactors(),
    );
    this.cache.store(netlist.topologyHash, island.index, built);
    return built;
  }

  private program(): StampProgram {
    return {
      rows: this.tripletRow.slice(0, this.calls),
      cols: this.tripletCol.slice(0, this.calls),
      codes: this.callCode.slice(0, this.calls),
      branches: this.callBranch.slice(0, this.calls),
      rhsTargets: this.rhsTarget.slice(0, this.rhsCalls),
      rhsCodes: this.rhsCode.slice(0, this.rhsCalls),
      rhsBranches: this.rhsBranch.slice(0, this.rhsCalls),
    };
  }

  /** Fills the sparse values and the right-hand side from `symbolic`'s stamp program, in call order. */
  private assemble(symbolic: IslandSymbolic<ComplexSparseFactors>, values: AcBranchValues, rhs: Float64Array): void {
    const nnz = symbolic.pattern.colPtr[symbolic.unknowns];
    if (this.sparseValues.length < 2 * nnz) this.sparseValues = new Float64Array(2 * nnz);
    const out = this.sparseValues;
    out.fill(0, 0, 2 * nnz);
    rhs.fill(0, 0, 2 * symbolic.unknowns);
    const { slots, codes, branches } = symbolic;
    const gmin = GMIN_S.value;
    const yRe = this.yRe;
    const yIm = this.yIm;
    for (let c = 0; c < slots.length; c++) {
      const code = codes[c];
      const s = 2 * slots[c];
      if (code === VALUE_GMIN) out[s] += gmin;
      else if (code === VALUE_ONE) out[s] += 1;
      else if (code === VALUE_MINUS_ONE) out[s] += -1;
      else if (code === VALUE_OHMS) out[s] += values.ohms[branches[c]];
      else if (code === VALUE_Y) {
        out[s] += yRe[branches[c]];
        out[s + 1] += yIm[branches[c]];
      } else {
        out[s] += -yRe[branches[c]];
        out[s + 1] += -yIm[branches[c]];
      }
    }
    const { rhsTargets, rhsBranches } = symbolic;
    for (let r = 0; r < rhsTargets.length; r++) {
      const b = rhsBranches[r];
      rhs[2 * rhsTargets[r]] = values.emfRe[b];
      rhs[2 * rhsTargets[r] + 1] = values.emfIm[b];
    }
  }

  /**
   * Adds the value `code` and `branch` give (exactly as `assemble` computes it) to entry (row, col):
   * into the dense matrix, or, in record mode, as a step of the stamp program. Only codes cross the
   * call, never a double: a non-integer double passed to a call V8 doesn't inline is boxed into a heap
   * number, and whether it inlines varies from process to process (simulation caveats; DC's `add` too).
   * A real value adds nothing to the imaginary part, which is bit-identical to adding +0 there: an
   * entry's imaginary part starts at +0 and can't become −0 (+0 + −0 is +0).
   */
  private add(row: number, col: number, code: number, branch: number): void {
    if (this.mode === MODE_DENSE) {
      const a = this.a;
      const at = 2 * (row * this.n + col);
      if (code === VALUE_GMIN) a[at] += GMIN_S.value;
      else if (code === VALUE_ONE) a[at] += 1;
      else if (code === VALUE_MINUS_ONE) a[at] += -1;
      else if (code === VALUE_OHMS) a[at] += this.stampOhms[branch];
      else if (code === VALUE_Y) {
        a[at] += this.yRe[branch];
        a[at + 1] += this.yIm[branch];
      } else {
        a[at] += -this.yRe[branch];
        a[at + 1] += -this.yIm[branch];
      }
      return;
    }
    const c = this.calls++;
    if (c >= this.tripletRow.length) {
      this.tripletRow = grow(this.tripletRow);
      this.tripletCol = grow(this.tripletCol);
      this.callBranch = grow(this.callBranch);
      const codes = new Uint8Array(2 * this.callCode.length);
      codes.set(this.callCode);
      this.callCode = codes;
    }
    this.tripletRow[c] = row;
    this.tripletCol[c] = col;
    this.callCode[c] = code;
    this.callBranch[c] = branch;
  }

  /** Sets a source row's right-hand side to its EMF phasor, recording it in record mode. */
  private rhsEmf(target: number, values: AcBranchValues, branch: number): void {
    this.rhs[2 * target] = values.emfRe[branch];
    this.rhs[2 * target + 1] = values.emfIm[branch];
    if (this.mode !== MODE_RECORD) return;
    const r = this.rhsCalls++;
    if (r >= this.rhsTarget.length) {
      this.rhsTarget = grow(this.rhsTarget);
      this.rhsBranch = grow(this.rhsBranch);
      const codes = new Uint8Array(2 * this.rhsCode.length);
      codes.set(this.rhsCode);
      this.rhsCode = codes;
    }
    this.rhsTarget[r] = target;
    this.rhsCode[r] = RHS_SET_EMF;
    this.rhsBranch[r] = branch;
  }

  /** Stamps the current island's matrix (through `add`, in a fixed order) and right-hand side. */
  private stamp(netlist: Netlist, island: NetlistIsland, values: AcBranchValues): void {
    const nodeUnknown = this.nodeUnknown;
    const branchUnknown = this.branchUnknown;
    this.stampOhms = values.ohms;
    for (let ni = 0; ni < island.nodes.length; ni++) {
      const node = island.nodes[ni];
      const i = nodeUnknown[node];
      if (i >= 0) this.add(i, i, VALUE_GMIN, -1);
    }
    for (let bi = 0; bi < island.branches.length; bi++) {
      const index = island.branches[bi];
      const branch = netlist.branches[index];
      const k = branchUnknown[index];
      const ia = nodeUnknown[branch.a];
      const ib = nodeUnknown[branch.b];
      if (k >= 0) {
        if (branch.a !== branch.b) {
          // KCL: the source's current I leaves `a` and enters `b`.
          if (ia >= 0) this.add(ia, k, VALUE_ONE, index);
          if (ib >= 0) this.add(ib, k, VALUE_MINUS_ONE, index);
          // Vb − Va + R·I = E.
          if (ib >= 0) this.add(k, ib, VALUE_ONE, index);
          if (ia >= 0) this.add(k, ia, VALUE_MINUS_ONE, index);
        }
        this.add(k, k, VALUE_OHMS, index);
        this.rhsEmf(k, values, index);
      } else if (branch.a !== branch.b) {
        if (ia >= 0) this.add(ia, ia, VALUE_Y, index);
        if (ib >= 0) this.add(ib, ib, VALUE_Y, index);
        if (ia >= 0 && ib >= 0) {
          this.add(ia, ib, VALUE_MINUS_Y, index);
          this.add(ib, ia, VALUE_MINUS_Y, index);
        }
      }
    }
  }

  /** Whether the island's zero-ohm voltage sources close a loop (a self-loop included). */
  private hasIdealSourceLoop(netlist: Netlist, island: NetlistIsland, values: AcBranchValues): boolean {
    const parent = this.parent;
    for (let ni = 0; ni < island.nodes.length; ni++) {
      const node = island.nodes[ni];
      parent[node] = node;
    }
    for (let bi = 0; bi < island.branches.length; bi++) {
      const index = island.branches[bi];
      if (values.stamps[index] !== AC_STAMP_VSOURCE || values.ohms[index] !== 0) continue;
      const branch = netlist.branches[index];
      const ra = find(parent, branch.a);
      const rb = find(parent, branch.b);
      if (ra === rb) return true;
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
    return false;
  }

  private singular(netlist: Netlist, island: NetlistIsland, solution: DcSolution, result: DcIslandResult): void {
    result.flags |= ISLAND_FLAG_SINGULAR;
    for (let ni = 0; ni < island.nodes.length; ni++) {
      const node = island.nodes[ni];
      solution.nodes[2 * node] = 0;
      solution.nodes[2 * node + 1] = 0;
    }
    for (let bi = 0; bi < island.branches.length; bi++) {
      const index = island.branches[bi];
      solution.branches[2 * index] = 0;
      solution.branches[2 * index + 1] = 0;
    }
  }
}

/** Solves `netlist`'s `ac` islands at `frequencyHz` with a fresh solver: a convenience for scripts and tests. */
export function solveAc(netlist: Netlist, values: AcBranchValues, frequencyHz: number): DcSolution {
  return new AcSolver().solve(netlist, values, frequencyHz);
}
