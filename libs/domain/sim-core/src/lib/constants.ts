/*
 * Sourced sim-core constants (realism charter, plan §3). Every electrical or physical constant names
 * where it comes from; values chosen for play say `game-design`, and solver settings `numerical`. Reviewed by
 * `electrical-realism-reviewer` before the PR that adds or changes one merges.
 */

export interface SourcedConstant {
  readonly value: number;
  /** SI unit symbol. */
  readonly unit: string;
  /** `numerical`: a solver setting with no electrical meaning (`gmin`, an iteration cap). */
  readonly kind: 'real-world' | 'game-design' | 'numerical';
  readonly source: string;
}

/**
 * The conductor temperature a test lead's resistance is taken at (F2.1). P2 has no conductor heating
 * (P3 brings it, with world v3 lead state), so every lead sits at this fixed temperature. It lies
 * inside the range where `leadResistanceOhm`'s linear α model holds (about 223 to 423 K), so the
 * compiler needs no clamp; a spec checks the range.
 */
export const LEAD_CONDUCTOR_TEMPERATURE_K: SourcedConstant = {
  value: 293.15,
  unit: 'K',
  kind: 'game-design',
  source:
    'game-design: the workshop bench is taken at 20 °C (293.15 K), a usual indoor ambient and the reference temperature of the International Annealed Copper Standard (IEC 60028), so a copper lead at ambient has exactly its catalogue resistivity. Self-heating is ignored until P3 adds conductor temperature.',
};

/**
 * `gmin`: the conductance the DC solver (F2.2) puts from every node to its island's reference node.
 * Numerical, not electrical: no real device is modelled by it. With it, an MNA matrix is singular
 * only for a loop of ideal (zero-ohm) voltage sources, which the solver flags `singular`; a node that
 * nothing but a current source reaches still gets a defined, finite voltage instead of NaN. Its loss,
 * gmin · V² per node, is part of the power balance.
 */
export const GMIN_S: SourcedConstant = {
  value: 1e-12,
  unit: 'S',
  kind: 'numerical',
  source:
    "numerical: the conventional SPICE minimum conductance, 1e-12 S (1 TΩ), the default GMIN of Berkeley SPICE2 (L. W. Nagel, \"SPICE2: A Computer Program to Simulate Semiconductor Circuits\", UCB/ERL M520, 1975) and of the ngspice user manual. sim-core puts it from every circuit node to the island reference, so F2.7's oracle decks match it with an explicit 1e12 Ω shunt resistor from each circuit node to the reference. Not ngspice's `rshunt` option, which also shunts the decks' 0 V sense-source nodes and each source's internal node, and so moves results. Its effect on a result is a relative error of about gmin × R_th, the Thévenin resistance the node sees: 1e-10 at 100 Ω, 1e-6 at 1 MΩ. That is below a bench meter's resolution, but not below an insulation-resistance tester's range, which must exclude it.",
};

/**
 * The size from which `DcSolver` solves an island by sparse LU (F2.2 part 3) instead of dense LU:
 * islands with at least this many unknowns go sparse. Numerical: it changes speed, and the bits of a
 * result (the two LUs round differently), never its accuracy class.
 */
export const SPARSE_MIN_UNKNOWNS: SourcedConstant = {
  value: 64,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: from the measured dense/sparse crossover (F2.2 part 3, built bundle, Node 24, AMD Ryzen 5 5600X; synthetic plant-like islands of 10–30 % meshing). Plan §4.5 suggested about 300 unknowns, but on these sparse MNA systems a sparse solve with a warm factorisation cache already beats dense LU from about 30 unknowns (1.2× at 36, 2.7× at 73, 16× at 290), and one that must rebuild its symbolic factorisation (a topology never seen) from about 130. 64 sits between the two, and above every circuit of the pinned 300-solve hash (at most 40 unknowns by construction), so small circuits keep their dense bits and the pin holds.',
};

/**
 * Threshold partial pivoting's diagonal preference in sparse LU: the diagonal entry is kept as the
 * pivot while |a_kk| ≥ u · max_i |a_ik|. Numerical: it trades fill-in (AMD orders for diagonal
 * pivots) against element growth, which is bounded by a factor (1 + 1/u) per step.
 */
export const PIVOT_THRESHOLD: SourcedConstant = {
  value: 0.1,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: u = 0.1, the threshold I. S. Duff, A. M. Erisman and J. K. Reid recommend for sparse LU ("Direct Methods for Sparse Matrices", Oxford, 1986, §7.8): close to partial pivoting\'s stability while keeping most of the ordering\'s sparsity.',
};

/**
 * How many topologies (`topologyHash`es) the factorisation cache keeps (F2.2 part 3), the least
 * recently used evicted first. Numerical: a cache size, with no effect on any result.
 */
export const FACTORISATION_CACHE_CAPACITY: SourcedConstant = {
  value: 16,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a cache size. Sixteen topologies cover a player toggling four switches or breakers back and forth (2^4 states) without a miss.',
};

/**
 * How many stamp-mode variants the cache keeps per island of a topology. A mode change (a `vsource`
 * element switching to current limit) changes the matrix pattern without changing `topologyHash`.
 */
export const FACTORISATION_CACHE_MODE_VARIANTS: SourcedConstant = {
  value: 4,
  unit: '1',
  kind: 'numerical',
  source: 'numerical: a cache size. Four variants per island cover two supplies crossing between CV and CC.',
};

/** The nonlinear outer loop's iteration cap (F2.2 part 3): past it the island is flagged `nonConverged`. */
export const OUTER_LOOP_MAX_ITERATIONS: SourcedConstant = {
  value: 50,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: SPICE\'s DC operating-point limit ITL1 is 100 Newton iterations (ngspice user manual, ".options"). A damped fixed-point loop needs far fewer: from a cold start on large circuits with self-heating resistors the median measured 16 and the most 32 (F2.2 part 3), and a warm start takes 1–2. So 50 leaves headroom while capping the cost of a solve that does not converge.',
};

/** The outer loop's relative convergence tolerance on every node voltage and branch current. */
export const OUTER_LOOP_RELTOL: SourcedConstant = {
  value: 1e-6,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: SPICE\'s RELTOL is 1e-3 (ngspice user manual, ".options"); 1e-6 keeps six significant digits, beyond any meter the player gets (P5), for a few more warm-started iterations.',
};

/** The outer loop's absolute voltage tolerance. */
export const OUTER_LOOP_VNTOL: SourcedConstant = {
  value: 1e-9,
  unit: 'V',
  kind: 'numerical',
  source:
    'numerical: SPICE\'s VNTOL is 1 µV (ngspice user manual, ".options"); 1 nV here, three decades tighter, in step with the tighter relative tolerance.',
};

/** The outer loop's absolute current tolerance. */
export const OUTER_LOOP_ABSTOL: SourcedConstant = {
  value: 1e-12,
  unit: 'A',
  kind: 'numerical',
  source: 'numerical: SPICE\'s ABSTOL, 1 pA (ngspice user manual, ".options"), the size of gmin leakage at 1 V.',
};

/**
 * The smallest damping factor the outer loop falls to. It starts at 1, halves each time the step
 * reverses or grows (an oscillation) and doubles back when the step shrinks steadily: always one of
 * 1, 1/2, …, 1/16, powers of two, so scaling a step by it is exact.
 */
export const OUTER_LOOP_MIN_DAMPING: SourcedConstant = {
  value: 1 / 16,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a damped fixed-point iteration x ← x + α (f(x) − x) contracts where its local slope f′ satisfies 1 − 2/α < f′ < 1, so α = 1/16 tames slopes down to −31; four halvings from 1 reach it.',
};
