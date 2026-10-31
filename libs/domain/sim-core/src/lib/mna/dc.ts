import {
  GMIN_S,
  OUTER_LOOP_ABSTOL,
  OUTER_LOOP_MAX_ITERATIONS,
  OUTER_LOOP_MIN_DAMPING,
  OUTER_LOOP_RELTOL,
  OUTER_LOOP_VNTOL,
  PIVOT_THRESHOLD,
  SPARSE_MIN_UNKNOWNS,
} from '../constants';
import { DenseLu } from '../lu/dense-lu';
import { SparseFactors, SparseLu } from '../lu/sparse-lu';
import type { Netlist, NetlistIsland } from '../netlist/types';
import { FactorisationCache, type IslandSymbolic } from './factorisation-cache';
import { buildSymbolic, endsChecksum, find, grow, positiveZero, type StampProgram } from './shared';
import { DC_STAMP_ISOURCE, DC_STAMP_RESISTOR, DC_STAMP_UNSET, DC_STAMP_VSOURCE, type DcBranchValues } from './values';

/*
 * DC modified nodal analysis (plan F2.2 parts 1 and 3), reimplemented from the published formulation
 * (C.-W. Ho, A. E. Ruehli and P. A. Brennan, "The Modified Nodal Approach to Network Analysis", IEEE
 * Trans. Circuits and Systems 22(6), 1975): no third-party code.
 *
 * Each island is solved on its own, against its own reference node, which is eliminated. Unknowns,
 * in this order:
 *
 * 1. the voltage of every other node of the island, in ascending node order;
 * 2. the current of every `vsource` element of the island, in ascending branch order.
 *
 * Rows are KCL at each non-reference node (current leaving through every element, plus `gmin` to the
 * reference, is zero), then one row per `vsource` element: Vb − Va + R·I = E, or I = amps while it is
 * stamped as a current source. The layout depends only on the topology, never on values.
 *
 * Singular islands: with `gmin` on every node and R ≥ 0 the matrix is singular exactly when the
 * island's zero-ohm voltage sources contain a loop (two ideal sources in parallel, or one shorted by
 * a closed switch): then xᵀMx = Vᵀ G V + Iᵀ R I vanishes only for a circulating current through those
 * sources. The solver checks that structurally, with a union-find, before any arithmetic, so the
 * flag never depends on a pivot tolerance. As a backstop, a zero or non-finite pivot or a non-finite
 * result flags the island too. A singular island's values are all +0, never NaN.
 *
 * Floating components: a conductive component (nodes joined by resistors and voltage-mode sources)
 * that doesn't hold the reference is tied to it only by gmin, through current sources. Its KCL rows
 * then sum to almost nothing: once its conductance G exceeds about gmin / ε (≈ 4.5e3 S, R below
 * ≈ 0.2 mΩ), G + gmin rounds to G and elimination leaves an exact zero pivot, though the matrix is
 * not singular. Such a component is pinned structurally, by an exact change of variables and a row
 * operation (the same solution):
 *
 * - its representative r (its smallest node) has the unknown c = V(r), its common mode, and every
 *   other member the unknown u = V − c. Differences (resistors, voltage-source rows) involve only u,
 *   where c cancels exactly; only the gmin terms carry c. So the u-block is a well-conditioned
 *   Laplacian grounded at r, instead of a nearly singular one held by gmin;
 * - r's KCL row is replaced by the sum of all the members' rows, built structurally: the internal
 *   conductances and source currents never enter, leaving gmin · (|S| c + Σ u) plus the currents of
 *   the branches that leave the component. Its pivot comes out ≈ |S| · gmin, accurately.
 *
 * Voltages are written as c + u, and currents inside the component come from u. Islands with no
 * floating component are unaffected, bit for bit. The plan's caveats record the reasoning.
 *
 * **Dense or sparse (part 3).** One stamping routine writes every matrix entry through `add`, in a
 * fixed call order. An island with fewer than `SPARSE_MIN_UNKNOWNS` unknowns is stamped into a dense
 * matrix and factored by `DenseLu`, exactly as in part 1 (the pinned 300-solve hash holds). A larger
 * one is stamped into the CSC pattern of its symbolic factorisation and factored by `SparseLu`
 * (Gilbert–Peierls, AMD order). The symbolic factorisation is built by running the same stamping
 * once in record mode (the (row, column) of every call), and is kept in the factorisation cache by
 * `topologyHash`, island and stamp modes. Both backends assemble the same terms, from the one
 * stamping routine (the sparse path replays its recorded program, in call order); they differ in
 * pivot order, so their results agree to rounding, not to the bit. The sparse path's bits are pinned
 * by their own hash (`sparse.spec.ts`), as the dense path's are (`properties.spec.ts`).
 *
 * **Nonlinear outer loop (part 3).** `solveNonlinear` repeats each island's linear solve, calling a
 * value hook with the current iterate before each one (a lamp's R(T), a supply's CV/CC mode), until
 * the solution stops moving, with damping and an iteration cap (see `solveNonlinear`).
 */

/** Island flag bits, as in the snapshot's island entry (ADR 0011 §5.3). */
export const ISLAND_FLAG_SINGULAR = 1;
export const ISLAND_FLAG_NON_CONVERGED = 2;

/** One island's result. */
export interface DcIslandResult {
  /** Whether the DC solver solved it: `dc` and `empty` islands. `ac` and `mixed` islands are F2.2 part 2's. */
  solved: boolean;
  /** The solver's ground for this island: its node voltages are against this node, whose own is 0. */
  referenceNode: number;
  /** The order of the island's MNA system. */
  unknowns: number;
  /** `ISLAND_FLAG_*` bits. */
  flags: number;
  /** Outer-loop iterations of the last solve: 1 for a linear solve, 0 when not solved. */
  iterations: number;
}

/**
 * A DC solution, in the netlist's canonical order, so it maps directly onto `WorldV2.sim` and the
 * snapshot payload (ADR 0011 §5.3 and §9.6). Every value is finite and `-0` is `+0`.
 */
export interface DcSolution {
  /** The netlist it solves. */
  topologyHash: string;
  /** Node voltages in V against the island's reference, `re, im` interleaved (`im` is 0 for DC). */
  readonly nodes: Float64Array;
  /** Branch currents in A, positive from end `a` to end `b`, `re, im` interleaved. */
  readonly branches: Float64Array;
  readonly islands: DcIslandResult[];
}

/** An empty solution sized for `netlist`. */
export function createDcSolution(netlist: Netlist): DcSolution {
  return {
    topologyHash: netlist.topologyHash,
    nodes: new Float64Array(2 * netlist.nodes.length),
    branches: new Float64Array(2 * netlist.branches.length),
    islands: netlist.islands.map(() => ({ solved: false, referenceNode: -1, unknowns: 0, flags: 0, iterations: 0 })),
  };
}

function fits(solution: DcSolution, netlist: Netlist): boolean {
  return (
    solution.nodes.length === 2 * netlist.nodes.length &&
    solution.branches.length === 2 * netlist.branches.length &&
    solution.islands.length === netlist.islands.length
  );
}

/**
 * An island's reference node: the negative end (`a`) of its lowest-numbered `vsource` element, or
 * its smallest node if it has none. A pure function of the topology. For a floating DC island with
 * one source that is its most negative source terminal (ADR 0011 §5.3).
 */
export function islandReferenceNode(netlist: Netlist, island: NetlistIsland): number {
  for (const index of island.branches) {
    const branch = netlist.branches[index];
    if (branch.kind === 'vsource') return branch.a;
  }
  return island.nodes[0];
}

/** Copies an island record's fields (no allocation). */
function copyRecord(from: DcIslandResult, to: DcIslandResult): void {
  to.solved = from.solved;
  to.referenceNode = from.referenceNode;
  to.unknowns = from.unknowns;
  to.flags = from.flags;
  to.iterations = from.iterations;
}

/**
 * Sets the values of an island's nonlinear branches for the next outer-loop iteration (F2.2 part 3),
 * from `iterate`, the current estimate of the solution: the island's entries of `iterate.nodes` and
 * `iterate.branches` (other islands' entries are meaningless), and its `islands[island.index]`
 * record. `iterate` is `null` when there is no estimate yet (a cold start without a warm start):
 * the hook then sets its initial guess (a lamp's cold resistance, a supply in CV).
 *
 * It must be a pure function of its inputs, write only branches of `island`, and write them with
 * `values.resistor`, `.vsource` or `.isource` (a stamp mode may change). A linear branch needn't be
 * touched. F2.4's supply and F2.5's lamp are its first real users.
 */
export type DcIterationHook = (island: NetlistIsland, iterate: DcSolution | null, values: DcBranchValues) => void;

/** How `solveNonlinear` iterates. */
export interface DcNonlinearOptions {
  /** The per-iteration value hook. */
  readonly hook: DcIterationHook;
  /**
   * A previous solution of the same topology (the solution record, ADR 0011 §9.6) to start from,
   * island by island; ignored when its `topologyHash` or size differs, and for islands it didn't
   * solve or flagged singular. Read only, never written.
   */
  readonly warmStart?: DcSolution | null;
  /** The iteration cap; `OUTER_LOOP_MAX_ITERATIONS` by default. */
  readonly maxIterations?: number;
}

/** How a `DcSolver` is set up. */
export interface DcSolverOptions {
  /** Islands with at least this many unknowns are solved by sparse LU (`SPARSE_MIN_UNKNOWNS` by default). */
  readonly sparseMinUnknowns?: number;
  /** The factorisation cache, which may be shared between solvers; a private one by default. */
  readonly cache?: FactorisationCache;
}

const MODE_DENSE = 0;
const MODE_RECORD = 1;

// How a stamp-program step recomputes its value from the branch values: exactly as `stamp` does.
const VALUE_GMIN = 0;
const VALUE_ONE = 1;
const VALUE_MINUS_ONE = 2;
/** `ohms[b]`. */
const VALUE_OHMS = 3;
/** `1 / ohms[b]`. */
const VALUE_G = 4;
/** `-(1 / ohms[b])`. */
const VALUE_MINUS_G = 5;
// Right-hand-side steps.
const RHS_SET_EMF = 0;
const RHS_SET_AMPS = 1;
const RHS_ADD_AMPS = 2;
const RHS_ADD_MINUS_AMPS = 3;

/**
 * Solves netlists' DC islands. Reuse one solver: its LU storage, index maps and factorisation cache
 * grow to the largest system seen and are then reused, so a steady-state solve allocates nothing.
 * Reuse never changes a result: every solve is a pure function of the netlist and the values (and,
 * for `solveNonlinear`, the hook and the warm start), whatever the solver solved before.
 */
export class DcSolver {
  /** Islands with at least this many unknowns go to sparse LU. */
  readonly sparseMinUnknowns: number;
  /** The factorisation cache (sparse islands' symbolic factorisations, by `topologyHash`). */
  readonly cache: FactorisationCache;
  private readonly lu = new DenseLu();
  /** The sparse kernels and workspace; `sparse.replays` and `.fresh` count numeric factorisations. */
  readonly sparse = new SparseLu();
  /** Node → its unknown in the current island, or −1 for the reference. */
  private nodeUnknown = new Int32Array(0);
  /** Branch → its current unknown in the current island, or −1. */
  private branchUnknown = new Int32Array(0);
  /** Union-find parents over node indices, for the zero-ohm source loop check. */
  private parent = new Int32Array(0);
  /** Node → the smallest node of its conductive component in the current island. */
  private comp = new Int32Array(0);
  private rhs = new Float64Array(0);
  /** The current island's dense matrix and order, and its reference node's component. */
  private a: Float64Array = new Float64Array(0);
  private n = 0;
  private referenceRoot = -1;
  /** How `add` writes: into the dense matrix, or recording the stamp program. */
  private mode = MODE_DENSE;
  // Record mode: every `add` call's (row, column, value code, branch), and every right-hand-side op.
  private tripletRow = new Int32Array(256);
  private tripletCol = new Int32Array(256);
  private callCode = new Uint8Array(256);
  private callBranch = new Int32Array(256);
  private calls = 0;
  private rhsTarget = new Int32Array(64);
  private rhsCode = new Uint8Array(64);
  private rhsBranch = new Int32Array(64);
  private rhsCalls = 0;
  /** The sparse matrix's values, aligned with the current symbolic factorisation's pattern. */
  private sparseValues = new Float64Array(0);
  /** The current island's stamp codes, for the cache's mode signature. */
  private signature = new Uint8Array(0);
  // Outer loop: the iterate, the previous step and the previous iteration's values.
  private iterate: DcSolution | null = null;
  private previousStep = new Float64Array(0);
  private savedStamps = new Uint8Array(0);
  private savedOhms = new Float64Array(0);
  private savedEmf = new Float64Array(0);
  private savedAmps = new Float64Array(0);
  /** Outer loop: each branch's current resolution, and each node's sum of its branches' terms. */
  private branchResolution = new Float64Array(0);
  private nodeResolution = new Float64Array(0);

  constructor(options: DcSolverOptions = {}) {
    const threshold = options.sparseMinUnknowns ?? SPARSE_MIN_UNKNOWNS.value;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError(`DcSolver: sparseMinUnknowns must be an integer ≥ 1, got ${threshold}`);
    }
    this.sparseMinUnknowns = threshold;
    this.cache = options.cache ?? new FactorisationCache();
  }

  /**
   * Solves every `dc` and `empty` island of `netlist` with `values`, into `out` if it fits (else a
   * new solution). `ac` and `mixed` islands are left at zero, `solved: false`. Throws on a missing
   * value or a stamp that doesn't suit its element kind (a programming error).
   */
  solve(netlist: Netlist, values: DcBranchValues, out?: DcSolution): DcSolution {
    const solution = this.prepare(netlist, values, out);
    for (const island of netlist.islands) this.solveIsland(netlist, island, values, solution);
    return solution;
  }

  /**
   * Solves `netlist` with a nonlinear outer loop (F2.2 part 3), island by island. For each DC island:
   *
   * 1. the iterate x starts at the warm start's island (if usable), else there is none;
   * 2. each iteration calls `hook(island, x, values)` (with `null` for no iterate), then solves the
   *    island linearly, giving x̃;
   * 3. it has converged when the hook, given x̃, returns the values x̃ was solved with, each within
   *    `OUTER_LOOP_RELTOL` (plus `OUTER_LOOP_VNTOL` for an EMF, `OUTER_LOOP_ABSTOL` for amps) and in
   *    the same stamp mode: the fixed point itself, tested where the law lives (#51: a current-space
   *    test alone stalled on solve noise in ill-conditioned islands, to 42 and 50 iterations on the
   *    dense path); or when every node voltage of x̃ is within `OUTER_LOOP_RELTOL` (relative) plus
   *    `OUTER_LOOP_VNTOL` of x, and every branch current within `OUTER_LOOP_RELTOL` plus
   *    `OUTER_LOOP_ABSTOL` plus that branch's own current resolution (`currentResolution`: the floor
   *    policy's 32 ε |y| (|Va| + |Vb|) term, per branch: no linear solve resolves a current better, so
   *    successive solves differ by that much noise); or when x is exactly the last x̃ and the hook left
   *    every value unchanged (a fixed point: a linear island takes one solve);
   * 4. otherwise x ← x + α (x̃ − x). The damping α starts at 1, halves (down to
   *    `OUTER_LOOP_MIN_DAMPING`) whenever a step reverses the previous one's direction or is larger (an
   *    oscillation), and doubles back (up to 1) when a step shrinks in the same direction;
   * 5. after `maxIterations` solves without converging the island is flagged `ISLAND_FLAG_NON_CONVERGED`.
   *
   * The solution is always the last linear solve x̃, never a damped blend, so every row of its system
   * holds for the values the hook set last. `iterations` counts the island's linear solves. `values`
   * is a working buffer: it is left holding the hook's last values. A singular solve ends the loop.
   */
  solveNonlinear(netlist: Netlist, values: DcBranchValues, options: DcNonlinearOptions, out?: DcSolution): DcSolution {
    const maxIterations = options.maxIterations ?? OUTER_LOOP_MAX_ITERATIONS.value;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new RangeError(`DcSolver: maxIterations must be an integer ≥ 1, got ${maxIterations}`);
    }
    const solution = this.prepare(netlist, values, out);
    const iterate = this.prepareIterate(netlist);
    const branchCount = netlist.branches.length;
    if (this.savedStamps.length < branchCount) {
      this.savedStamps = new Uint8Array(branchCount);
      this.savedOhms = new Float64Array(branchCount);
      this.savedEmf = new Float64Array(branchCount);
      this.savedAmps = new Float64Array(branchCount);
    }
    if (this.branchResolution.length < branchCount) this.branchResolution = new Float64Array(branchCount);
    if (this.nodeResolution.length < netlist.nodes.length) this.nodeResolution = new Float64Array(netlist.nodes.length);
    const stepLength = 2 * (netlist.nodes.length + branchCount);
    if (this.previousStep.length < stepLength) this.previousStep = new Float64Array(stepLength);
    const given = options.warmStart ?? null;
    const warm = given !== null && given.topologyHash === netlist.topologyHash && fits(given, netlist) ? given : null;
    for (const island of netlist.islands) {
      const dc = island.kind === 'dc' || island.kind === 'empty';
      if (!dc) {
        this.solveIsland(netlist, island, values, solution);
        continue;
      }
      const record = warm === null ? null : warm.islands[island.index];
      const warmIsland = record !== null && record.solved && (record.flags & ISLAND_FLAG_SINGULAR) === 0;
      if (warm !== null && warmIsland) this.copyIsland(netlist, island, warm, iterate);
      this.iterateIsland(netlist, island, values, solution, iterate, warmIsland, options.hook, maxIterations);
    }
    return solution;
  }

  private iterateIsland(
    netlist: Netlist,
    island: NetlistIsland,
    values: DcBranchValues,
    solution: DcSolution,
    iterate: DcSolution,
    warm: boolean,
    hook: DcIterationHook,
    maxIterations: number,
  ): void {
    const result = solution.islands[island.index];
    let haveIterate = warm;
    // Whether the iterate is exactly the last linear solve (so unchanged values mean a fixed point).
    let iterateIsLastSolve = false;
    let alpha = 1;
    let havePreviousStep = false;
    let previousNorm = 0;
    let solves = 0;
    let converged = false;
    const minDamping = OUTER_LOOP_MIN_DAMPING.value;
    for (;;) {
      hook(island, haveIterate ? iterate : null, values);
      if (iterateIsLastSolve && this.valuesUnchanged(island, values)) {
        converged = true;
        break;
      }
      if (solves >= maxIterations) {
        // Out of iterations: put back the values of the last solve, so the solution's rows hold for
        // `values` as left.
        this.restoreValues(island, values);
        break;
      }
      this.saveValues(island, values);
      this.solveIsland(netlist, island, values, solution);
      solves++;
      if ((result.flags & ISLAND_FLAG_SINGULAR) !== 0) {
        converged = true;
        break;
      }
      // Self-consistency, the fixed point itself: the values the hook gives for this solve are the
      // ones it was solved with, to OUTER_LOOP_RELTOL. Tested in value space, not on the currents: a
      // current is only as repeatable as the solve resolves it (cond · ε · V · g, 5e-5 relative for a
      // 2e-7 A current between two 108 kV nodes, #51), while a law's value R(I) moves by at most its
      // input's relative change times its slope. Then x̃ is the answer and `values` its values.
      hook(island, solution, values);
      const selfConsistent = this.valuesWithin(island, values);
      this.restoreValues(island, values);
      if (selfConsistent) {
        converged = true;
        break;
      }
      if (!haveIterate) {
        this.copyIsland(netlist, island, solution, iterate);
        haveIterate = true;
        iterateIsLastSolve = true;
        continue;
      }
      // The step x̃ − x, its size and its direction against the previous step.
      const step = this.previousStep;
      let within = true;
      let norm = 0;
      let dot = 0;
      let s = 0;
      const vntol = OUTER_LOOP_VNTOL.value;
      // A current is resolved only to its own rounding (see `currentResolution`): below that,
      // successive solves differ by noise, so the loop must not demand more. Per branch, never
      // island-wide: an island-wide sum grows with the island and swamps a small current.
      this.currentResolution(netlist, island, values, solution);
      const abstol = OUTER_LOOP_ABSTOL.value;
      const resolution = this.branchResolution;
      const reltol = OUTER_LOOP_RELTOL.value;
      for (const node of island.nodes) {
        const next = solution.nodes[2 * node];
        const now = iterate.nodes[2 * node];
        const d = next - now;
        if (Math.abs(d) > reltol * Math.max(Math.abs(next), Math.abs(now)) + vntol) within = false;
        if (havePreviousStep) dot += d * step[s];
        step[s++] = d;
        norm = Math.max(norm, Math.abs(d));
      }
      for (const index of island.branches) {
        const next = solution.branches[2 * index];
        const now = iterate.branches[2 * index];
        const d = next - now;
        const allowed = reltol * Math.max(Math.abs(next), Math.abs(now)) + abstol + resolution[index];
        if (Math.abs(d) > allowed) within = false;
        if (havePreviousStep) dot += d * step[s];
        step[s++] = d;
        norm = Math.max(norm, Math.abs(d));
      }
      if (within) {
        converged = true;
        break;
      }
      if (havePreviousStep) {
        // An oscillation (the step reverses or grows) halves the damping; a step that shrinks in
        // the same direction doubles it back towards 1, so a far-off start isn't crawled back from.
        if (dot < 0 || norm > previousNorm) {
          if (alpha > minDamping) alpha = alpha / 2;
        } else if (norm < previousNorm && alpha < 1) {
          alpha = alpha * 2;
        }
      }
      havePreviousStep = true;
      previousNorm = norm;
      if (alpha === 1) {
        this.copyIsland(netlist, island, solution, iterate);
        iterateIsLastSolve = true;
      } else {
        s = 0;
        for (const node of island.nodes) iterate.nodes[2 * node] += alpha * step[s++];
        for (const index of island.branches) iterate.branches[2 * index] += alpha * step[s++];
        copyRecord(result, iterate.islands[island.index]);
        iterateIsLastSolve = false;
      }
    }
    result.iterations = solves;
    if (!converged) result.flags |= ISLAND_FLAG_NON_CONVERGED;
  }

  /**
   * Fills `branchResolution` with each island branch's current resolution on `solution`: how finely
   * any linear solve fixes that current, so how far apart two solves of nearly the same system may
   * put it (the floor policy's per-branch rounding term, 2 · 16 ε |y| (|Va| + |Vb|)):
   *
   * - a resistor: its own term, from its end voltages and its conductance;
   * - a voltage-mode source: its current comes out of the KCL rows at its two ends, so the terms of
   *   every resistive branch (and gmin) at those nodes, plus its own if it has a series resistance;
   * - a current source: 0 (its current is exactly `amps`).
   */
  private currentResolution(
    netlist: Netlist,
    island: NetlistIsland,
    values: DcBranchValues,
    solution: DcSolution,
  ): void {
    const nodes = solution.nodes;
    const nodeTerm = this.nodeResolution;
    const out = this.branchResolution;
    const scale = 32 * Number.EPSILON;
    for (const node of island.nodes) nodeTerm[node] = scale * GMIN_S.value * Math.abs(nodes[2 * node]);
    for (const index of island.branches) {
      out[index] = 0;
      if (values.stamps[index] !== DC_STAMP_RESISTOR) continue;
      const branch = netlist.branches[index];
      const term = (scale * (Math.abs(nodes[2 * branch.a]) + Math.abs(nodes[2 * branch.b]))) / values.ohms[index];
      out[index] = term;
      nodeTerm[branch.a] += term;
      if (branch.b !== branch.a) nodeTerm[branch.b] += term;
    }
    for (const index of island.branches) {
      if (values.stamps[index] !== DC_STAMP_VSOURCE) continue;
      const branch = netlist.branches[index];
      const ohms = values.ohms[index];
      const own = ohms > 0 ? (scale * (Math.abs(nodes[2 * branch.a]) + Math.abs(nodes[2 * branch.b]))) / ohms : 0;
      out[index] = nodeTerm[branch.a] + (branch.b !== branch.a ? nodeTerm[branch.b] : 0) + own;
    }
  }

  /** Sizes the per-netlist scratch, checks the values and returns the solution to write into. */
  private prepare(netlist: Netlist, values: DcBranchValues, out?: DcSolution): DcSolution {
    if (values.count !== netlist.branches.length) {
      throw new RangeError(`DcSolver: ${values.count} values for ${netlist.branches.length} branches`);
    }
    const solution = out !== undefined && fits(out, netlist) ? out : createDcSolution(netlist);
    solution.topologyHash = netlist.topologyHash;
    if (this.nodeUnknown.length < netlist.nodes.length) {
      this.nodeUnknown = new Int32Array(netlist.nodes.length);
      this.parent = new Int32Array(netlist.nodes.length);
      this.comp = new Int32Array(netlist.nodes.length);
    }
    if (this.branchUnknown.length < netlist.branches.length) {
      this.branchUnknown = new Int32Array(netlist.branches.length);
      this.signature = new Uint8Array(netlist.branches.length);
    }
    return solution;
  }

  private prepareIterate(netlist: Netlist): DcSolution {
    if (this.iterate === null || !fits(this.iterate, netlist)) this.iterate = createDcSolution(netlist);
    this.iterate.topologyHash = netlist.topologyHash;
    return this.iterate;
  }

  /** Copies an island's node voltages and branch currents from `from` into `to`. */
  private copyIsland(netlist: Netlist, island: NetlistIsland, from: DcSolution, to: DcSolution): void {
    for (const node of island.nodes) {
      to.nodes[2 * node] = from.nodes[2 * node];
      to.nodes[2 * node + 1] = from.nodes[2 * node + 1];
    }
    for (const index of island.branches) {
      to.branches[2 * index] = from.branches[2 * index];
      to.branches[2 * index + 1] = from.branches[2 * index + 1];
    }
    copyRecord(from.islands[island.index], to.islands[island.index]);
  }

  private restoreValues(island: NetlistIsland, values: DcBranchValues): void {
    for (const index of island.branches) {
      values.stamps[index] = this.savedStamps[index];
      values.ohms[index] = this.savedOhms[index];
      values.emfV[index] = this.savedEmf[index];
      values.amps[index] = this.savedAmps[index];
    }
  }

  private saveValues(island: NetlistIsland, values: DcBranchValues): void {
    for (const index of island.branches) {
      this.savedStamps[index] = values.stamps[index];
      this.savedOhms[index] = values.ohms[index];
      this.savedEmf[index] = values.emfV[index];
      this.savedAmps[index] = values.amps[index];
    }
  }

  /**
   * Whether every island branch's value is within `OUTER_LOOP_RELTOL` of the saved one (plus
   * `OUTER_LOOP_VNTOL` for an EMF and `OUTER_LOOP_ABSTOL` for a current source's amps), in the same
   * stamp mode: the hook's law is satisfied by the last solve to the loop's relative tolerance.
   */
  private valuesWithin(island: NetlistIsland, values: DcBranchValues): boolean {
    const reltol = OUTER_LOOP_RELTOL.value;
    const close = (was: number, now: number, floor: number) =>
      Math.abs(now - was) <= reltol * Math.max(Math.abs(was), Math.abs(now)) + floor;
    for (const index of island.branches) {
      if (
        this.savedStamps[index] !== values.stamps[index] ||
        !close(this.savedOhms[index], values.ohms[index], 0) ||
        !close(this.savedEmf[index], values.emfV[index], OUTER_LOOP_VNTOL.value) ||
        !close(this.savedAmps[index], values.amps[index], OUTER_LOOP_ABSTOL.value)
      ) {
        return false;
      }
    }
    return true;
  }

  private valuesUnchanged(island: NetlistIsland, values: DcBranchValues): boolean {
    for (const index of island.branches) {
      if (
        this.savedStamps[index] !== values.stamps[index] ||
        !Object.is(this.savedOhms[index], values.ohms[index]) ||
        !Object.is(this.savedEmf[index], values.emfV[index]) ||
        !Object.is(this.savedAmps[index], values.amps[index])
      ) {
        return false;
      }
    }
    return true;
  }

  private solveIsland(netlist: Netlist, island: NetlistIsland, values: DcBranchValues, solution: DcSolution): void {
    const result = solution.islands[island.index];
    const reference = islandReferenceNode(netlist, island);
    result.referenceNode = reference;
    const dc = island.kind === 'dc' || island.kind === 'empty';
    result.solved = dc;
    result.flags = 0;
    result.iterations = dc ? 1 : 0;
    if (!dc) {
      result.unknowns = 0;
      this.zero(netlist, island, solution);
      return;
    }

    // Layout: node unknowns, then vsource current unknowns.
    const nodeUnknown = this.nodeUnknown;
    const branchUnknown = this.branchUnknown;
    let n = 0;
    for (const node of island.nodes) nodeUnknown[node] = node === reference ? -1 : n++;
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const stamp = values.stamps[index];
      if (stamp === DC_STAMP_UNSET) throw new Error(`DcSolver: branch ${index} has no DC value`);
      if (branch.kind === 'vsource') {
        if (stamp === DC_STAMP_RESISTOR) throw new Error(`DcSolver: vsource branch ${index} stamped as a resistor`);
        branchUnknown[index] = n++;
      } else {
        if (stamp === DC_STAMP_VSOURCE) throw new Error(`DcSolver: resistor branch ${index} stamped as a vsource`);
        branchUnknown[index] = -1;
      }
    }
    result.unknowns = n;

    if (this.hasIdealSourceLoop(netlist, island, values)) {
      this.singular(netlist, island, solution, result);
      return;
    }

    if (this.rhs.length < n) this.rhs = new Float64Array(n);
    const rhs = this.rhs;
    rhs.fill(0, 0, n);
    this.n = n;

    let factored: boolean;
    if (n < this.sparseMinUnknowns) {
      this.conductiveComponents(netlist, island, values);
      this.referenceRoot = this.comp[reference];
      this.mode = MODE_DENSE;
      this.a = this.lu.begin(n);
      this.stamp(netlist, island, values);
      factored = this.lu.factor();
      if (factored) this.lu.solve(rhs);
    } else {
      const symbolic = this.symbolic(netlist, island, values, n, reference);
      // Numeric assembly by the recorded stamp program: the same additions, into the same entries,
      // in the same order as `stamp`, without its branching (see `buildSymbolic`).
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

    const comp = this.comp;
    const nodes = solution.nodes;
    const branches = solution.branches;
    let ok = true;
    for (const node of island.nodes) {
      const i = nodeUnknown[node];
      const root = comp[node];
      let v = 0;
      if (i >= 0) {
        // A floating member's unknown is u = V − c; its representative's is c itself.
        v = root === this.referenceRoot || node === root ? rhs[i] : rhs[nodeUnknown[root]] + rhs[i];
      }
      v = positiveZero(v);
      if (!Number.isFinite(v)) ok = false;
      nodes[2 * node] = v;
      nodes[2 * node + 1] = 0;
    }
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const k = branchUnknown[index];
      let current: number;
      if (k >= 0) current = rhs[k];
      else if (values.stamps[index] === DC_STAMP_ISOURCE) current = values.amps[index];
      else if (comp[branch.a] === this.referenceRoot) {
        current = (nodes[2 * branch.a] - nodes[2 * branch.b]) * (1 / values.ohms[index]);
      } else {
        // Inside a floating component, from the differences u, not from c + u: no common mode to cancel.
        current = (this.relative(branch.a) - this.relative(branch.b)) * (1 / values.ohms[index]);
      }
      current = positiveZero(current);
      if (!Number.isFinite(current)) ok = false;
      branches[2 * index] = current;
      branches[2 * index + 1] = 0;
    }
    if (!ok) this.singular(netlist, island, solution, result);
  }

  /**
   * The island's symbolic factorisation for its current stamp modes: from the cache, or built by
   * stamping once in record mode (the pattern and slot map) and ordering with AMD, then cached.
   */
  private symbolic(
    netlist: Netlist,
    island: NetlistIsland,
    values: DcBranchValues,
    n: number,
    reference: number,
  ): IslandSymbolic {
    const signature = this.signature;
    const count = island.branches.length;
    for (let i = 0; i < count; i++) signature[i] = values.stamps[island.branches[i]];
    const ends = endsChecksum(netlist, island);
    const cached = this.cache.find(netlist.topologyHash, island.index, signature, count);
    if (cached !== undefined) {
      if (cached.unknowns !== n) {
        throw new Error(
          `DcSolver: island ${island.index} has ${n} unknowns but its cached symbolic factorisation ${cached.unknowns}: two netlists share topologyHash ${netlist.topologyHash}`,
        );
      }
      if (cached.ends !== ends) {
        throw new Error(
          `DcSolver: island ${island.index}'s branch ends differ from its cached symbolic factorisation: a stale or mismatched topologyHash ${netlist.topologyHash}`,
        );
      }
      // The conductive components are a function of the topology and the stamp modes: restore them.
      const comp = this.comp;
      const nodes = island.nodes;
      for (let i = 0; i < nodes.length; i++) comp[nodes[i]] = cached.comp[i];
      this.referenceRoot = comp[reference];
      return cached;
    }
    this.conductiveComponents(netlist, island, values);
    this.referenceRoot = this.comp[reference];
    this.mode = MODE_RECORD;
    this.calls = 0;
    this.rhsCalls = 0;
    this.stamp(netlist, island, values);
    const comp = Int32Array.from(island.nodes, (node) => this.comp[node]);
    const built = buildSymbolic(n, this.program(), signature.slice(0, count), comp, ends, new SparseFactors());
    this.cache.store(netlist.topologyHash, island.index, built);
    return built;
  }

  /** The stamp program recorded in record mode, copied out of the growable buffers. */
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

  /** Fills the sparse values and the right-hand side from `symbolic`'s stamp program. */
  private assemble(symbolic: IslandSymbolic, values: DcBranchValues, rhs: Float64Array): void {
    const nnz = symbolic.pattern.colPtr[symbolic.unknowns];
    if (this.sparseValues.length < nnz) this.sparseValues = new Float64Array(nnz);
    const out = this.sparseValues;
    out.fill(0, 0, nnz);
    rhs.fill(0, 0, symbolic.unknowns);
    const { slots, codes, branches } = symbolic;
    const ohms = values.ohms;
    const gmin = GMIN_S.value;
    for (let c = 0; c < slots.length; c++) {
      const code = codes[c];
      let v: number;
      if (code === VALUE_GMIN) v = gmin;
      else if (code === VALUE_ONE) v = 1;
      else if (code === VALUE_MINUS_ONE) v = -1;
      else if (code === VALUE_OHMS) v = ohms[branches[c]];
      else if (code === VALUE_G) v = 1 / ohms[branches[c]];
      else v = -(1 / ohms[branches[c]]);
      out[slots[c]] += v;
    }
    const { rhsTargets, rhsCodes, rhsBranches } = symbolic;
    for (let r = 0; r < rhsTargets.length; r++) {
      const code = rhsCodes[r];
      const b = rhsBranches[r];
      const t = rhsTargets[r];
      if (code === RHS_SET_EMF) rhs[t] = values.emfV[b];
      else if (code === RHS_SET_AMPS) rhs[t] = values.amps[b];
      else if (code === RHS_ADD_AMPS) rhs[t] += values.amps[b];
      else rhs[t] += -values.amps[b];
    }
  }

  /**
   * Adds `value` to entry (row, col) of the current island's matrix: into the dense matrix, or, in
   * record mode, as a step of the stamp program (`code` and `branch` say how to recompute `value`
   * from the branch values, exactly as computed here).
   */
  private add(row: number, col: number, value: number, code: number, branch: number): void {
    if (this.mode === MODE_DENSE) {
      this.a[row * this.n + col] += value;
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

  /** Sets or adds a right-hand-side entry, recording it in record mode (as `add`). */
  private rhsOp(target: number, value: number, code: number, branch: number): void {
    if (code === RHS_SET_EMF || code === RHS_SET_AMPS) this.rhs[target] = value;
    else this.rhs[target] += value;
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
    this.rhsCode[r] = code;
    this.rhsBranch[r] = branch;
  }

  /**
   * Stamps the current island's matrix (through `add`, in a fixed order that depends only on the
   * topology and the stamp modes) and right-hand side.
   */
  private stamp(netlist: Netlist, island: NetlistIsland, values: DcBranchValues): void {
    const nodeUnknown = this.nodeUnknown;
    const branchUnknown = this.branchUnknown;
    const comp = this.comp;
    const gmin = GMIN_S.value;
    for (const node of island.nodes) {
      const i = nodeUnknown[node];
      if (i < 0) continue;
      const root = comp[node];
      if (root === this.referenceRoot) {
        this.add(i, i, gmin, VALUE_GMIN, -1);
      } else {
        // Floating: V = c + u with c in the representative's column, so gmin · V puts gmin on c and
        // on u (u_rep ≡ 0), in the member's own row and in the component's sum row.
        const r = nodeUnknown[root];
        if (node !== root) {
          this.add(i, r, gmin, VALUE_GMIN, -1);
          this.add(i, i, gmin, VALUE_GMIN, -1);
          this.add(r, i, gmin, VALUE_GMIN, -1);
        }
        this.add(r, r, gmin, VALUE_GMIN, -1);
      }
    }
    for (const index of island.branches) {
      const branch = netlist.branches[index];
      const stamp = values.stamps[index];
      const k = branchUnknown[index];
      if (k >= 0) {
        // KCL: the source's current I leaves `a` and enters `b`.
        if (branch.a !== branch.b) {
          this.kclEntry(branch.a, branch.b, k, 1, VALUE_ONE, index);
          this.kclEntry(branch.b, branch.a, k, -1, VALUE_MINUS_ONE, index);
        }
        if (stamp === DC_STAMP_VSOURCE) {
          // Vb − Va + R·I = E (a difference, so a floating component's common mode cancels).
          if (branch.a !== branch.b) {
            const cb = this.diffColumn(branch.b);
            const ca = this.diffColumn(branch.a);
            if (cb >= 0) this.add(k, cb, 1, VALUE_ONE, index);
            if (ca >= 0) this.add(k, ca, -1, VALUE_MINUS_ONE, index);
          }
          this.add(k, k, values.ohms[index], VALUE_OHMS, index);
          this.rhsOp(k, values.emfV[index], RHS_SET_EMF, index);
        } else {
          // Current limit: I = amps.
          this.add(k, k, 1, VALUE_ONE, index);
          this.rhsOp(k, values.amps[index], RHS_SET_AMPS, index);
        }
      } else if (branch.a !== branch.b) {
        if (stamp === DC_STAMP_RESISTOR) {
          const g = 1 / values.ohms[index];
          const ca = this.diffColumn(branch.a);
          const cb = this.diffColumn(branch.b);
          this.kclEntry(branch.a, branch.b, ca, g, VALUE_G, index);
          this.kclEntry(branch.b, branch.a, cb, g, VALUE_G, index);
          this.kclEntry(branch.a, branch.b, cb, -g, VALUE_MINUS_G, index);
          this.kclEntry(branch.b, branch.a, ca, -g, VALUE_MINUS_G, index);
        } else {
          // A current source on a resistor element: amps leave `a` and enter `b`.
          const amps = values.amps[index];
          this.kclRhs(branch.a, branch.b, -amps, RHS_ADD_MINUS_AMPS, index);
          this.kclRhs(branch.b, branch.a, amps, RHS_ADD_AMPS, index);
        }
      }
    }
  }

  /** Whether the island's zero-ohm voltage sources close a loop (a self-loop included). */
  private hasIdealSourceLoop(netlist: Netlist, island: NetlistIsland, values: DcBranchValues): boolean {
    const parent = this.parent;
    for (const node of island.nodes) parent[node] = node;
    for (const index of island.branches) {
      if (values.stamps[index] !== DC_STAMP_VSOURCE || values.ohms[index] !== 0) continue;
      const branch = netlist.branches[index];
      const ra = find(parent, branch.a);
      const rb = find(parent, branch.b);
      if (ra === rb) return true;
      // Union by the smaller root, so the structure is a pure function of the branch order.
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
    return false;
  }

  /**
   * Fills `comp` with each island node's conductive component, as its smallest node: nodes joined by
   * resistors and voltage-mode sources. Current sources (either element kind) conduct nothing.
   */
  private conductiveComponents(netlist: Netlist, island: NetlistIsland, values: DcBranchValues): void {
    const comp = this.comp;
    for (const node of island.nodes) comp[node] = node;
    for (const index of island.branches) {
      const stamp = values.stamps[index];
      if (stamp !== DC_STAMP_RESISTOR && stamp !== DC_STAMP_VSOURCE) continue;
      const branch = netlist.branches[index];
      const ra = find(comp, branch.a);
      const rb = find(comp, branch.b);
      if (ra < rb) comp[rb] = ra;
      else if (rb < ra) comp[ra] = rb;
    }
    // Union by the smaller root keeps every root its component's smallest node.
    for (const node of island.nodes) comp[node] = find(comp, node);
  }

  /**
   * Adds `value` to column `col` of node `x`'s KCL row, for a branch whose other end is `other`.
   * In a floating component, the representative's row is the sum of all the members' KCL rows, so a
   * contribution also goes there when its branch leaves the component, and not at all when it stays
   * inside (where it cancels exactly in the sum). The reference's row and column don't exist.
   */
  private kclEntry(x: number, other: number, col: number, value: number, code: number, branch: number): void {
    const ix = this.nodeUnknown[x];
    if (col < 0 || ix < 0) return;
    const root = this.comp[x];
    if (root === this.referenceRoot) {
      this.add(ix, col, value, code, branch);
      return;
    }
    if (x !== root) this.add(ix, col, value, code, branch);
    if (this.comp[other] !== root) this.add(this.nodeUnknown[root], col, value, code, branch);
  }

  /**
   * The column of V(x) in a voltage difference inside x's conductive component, or −1. The
   * reference has no column; in a floating component a difference involves only u = V − c, and the
   * representative's u is 0 (its column holds c, which cancels in a difference).
   */
  private diffColumn(x: number): number {
    const root = this.comp[x];
    if (root !== this.referenceRoot && x === root) return -1;
    return this.nodeUnknown[x];
  }

  /** A floating member's solved u = V − c (0 for the representative). */
  private relative(x: number): number {
    return x === this.comp[x] ? 0 : this.rhs[this.nodeUnknown[x]];
  }

  /** As `kclEntry`, for a current injected into the right-hand side. */
  private kclRhs(x: number, other: number, value: number, code: number, branch: number): void {
    const ix = this.nodeUnknown[x];
    if (ix < 0) return;
    const root = this.comp[x];
    if (root === this.referenceRoot) {
      this.rhsOp(ix, value, code, branch);
      return;
    }
    if (x !== root) this.rhsOp(ix, value, code, branch);
    if (this.comp[other] !== root) this.rhsOp(this.nodeUnknown[root], value, code, branch);
  }

  private singular(netlist: Netlist, island: NetlistIsland, solution: DcSolution, result: DcIslandResult): void {
    result.flags |= ISLAND_FLAG_SINGULAR;
    this.zero(netlist, island, solution);
  }

  private zero(netlist: Netlist, island: NetlistIsland, solution: DcSolution): void {
    for (const node of island.nodes) {
      solution.nodes[2 * node] = 0;
      solution.nodes[2 * node + 1] = 0;
    }
    for (const index of island.branches) {
      solution.branches[2 * index] = 0;
      solution.branches[2 * index + 1] = 0;
    }
  }
}

/** Solves `netlist`'s DC islands with a fresh solver: a convenience for scripts and tests. */
export function solveDc(netlist: Netlist, values: DcBranchValues): DcSolution {
  return new DcSolver().solve(netlist, values);
}
