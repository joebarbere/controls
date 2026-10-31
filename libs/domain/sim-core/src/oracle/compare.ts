import type { OracleCircuitResult } from './results';

/*
 * How a sim-core solution is compared with the corpus (ADR 0012, Proposed). Each node voltage and
 * branch current is a phasor `x` (a real `x` in DC has `im = 0`), checked against ngspice's `x_ref`:
 *
 *   |x − x_ref| ≤ relative · |x_ref| + floor
 *   floor = max(absolute floor, scale · max over the circuit of |x_ref| of the same quantity)
 *
 * The reference is itself noisy: ngspice's own results, against exact rational solutions of the
 * same decks, are off by up to about 3e-9 of the circuit's largest value of the same quantity
 * (test-engineer review of F2.7, 2026-10-30). So the floor is set by that noise, `scale` = 1e-7: about
 * 30 times it. A float64 MNA solver emulated on the corpus stays at 0.03 of the allowance or less. This
 * floor bounds disagreement with a noisy reference; it is not the floor policy that bounds sim-core's
 * own KCL residuals in its property tests (F2.2 part 1, #46), which plays a different role.
 * `relative` and `scale` are to be confirmed by measurement when F2.2 part 1 lands; whatever is
 * chosen stays far inside the 0.5 % golden bound.
 */

export interface OracleTolerance {
  /** Relative tolerance on each value. */
  readonly relative: number;
  /** Absolute floor for node voltages (V). */
  readonly voltageFloorV: number;
  /** Absolute floor for branch currents (A). */
  readonly currentFloorA: number;
  /** The floor as a fraction of the circuit's largest value of the same quantity. */
  readonly scale: number;
}

/**
 * ADR 0012's proposed tolerance: `|x − x_ref| ≤ 1e-6·|x_ref| + max(1e-12, 1e-7·max|x_ref|)`, the same
 * for volts and amps. Numerical test choices; to be confirmed by measurement (F2.2 part 1).
 */
export const ORACLE_TOLERANCE: OracleTolerance = {
  relative: 1e-6,
  voltageFloorV: 1e-12,
  currentFloorA: 1e-12,
  scale: 1e-7,
};

/** The golden-fixture bound (plan F2.2): the oracle tolerance must never be looser than this. */
export const GOLDEN_RELATIVE_BOUND = 5e-3;

/** A solution to compare: `re, im` pairs, node 0 first, as in {@link OracleCircuitResult}. */
export interface OracleSolution {
  readonly nodes: ArrayLike<number>;
  readonly branches: ArrayLike<number>;
}

export interface OracleMismatch {
  readonly quantity: 'node' | 'branch';
  readonly index: number;
  readonly expected: readonly [number, number];
  readonly actual: readonly [number, number];
  /** |x − x_ref| and the allowance it exceeded. */
  readonly error: number;
  readonly allowed: number;
}

/** |re + j·im|, by `Math.sqrt` (IEEE-exact, D6). */
function modulus(re: number, im: number): number {
  return Math.sqrt(re * re + im * im);
}

function compareQuantity(
  quantity: 'node' | 'branch',
  expected: readonly number[],
  actual: ArrayLike<number>,
  absoluteFloor: number,
  tolerance: OracleTolerance,
  mismatches: OracleMismatch[],
): OracleWorst {
  if (actual.length !== expected.length) {
    throw new RangeError(`${quantity} values: expected ${expected.length} numbers, got ${actual.length}`);
  }
  let largest = 0;
  for (let i = 0; i < expected.length; i += 2) largest = Math.max(largest, modulus(expected[i], expected[i + 1]));
  const floor = Math.max(absoluteFloor, tolerance.scale * largest);
  const worst = { index: -1, ratio: 0 };
  for (let i = 0; i < expected.length; i += 2) {
    const error = modulus(actual[i] - expected[i], actual[i + 1] - expected[i + 1]);
    const allowed = tolerance.relative * modulus(expected[i], expected[i + 1]) + floor;
    const ratio = error / allowed;
    if (!(ratio <= worst.ratio)) {
      worst.index = i / 2;
      worst.ratio = ratio;
    }
    // `!(error <= allowed)` also catches NaN.
    if (!(error <= allowed)) {
      mismatches.push({
        quantity,
        index: i / 2,
        expected: [expected[i], expected[i + 1]],
        actual: [actual[i], actual[i + 1]],
        error,
        allowed,
      });
    }
  }
  return worst;
}

/** The value that used the largest share of its allowance: its index and |x − x_ref| / allowed (−1, 0 if none). */
export interface OracleWorst {
  index: number;
  ratio: number;
}

/** How `actual` compares with `expected`: every value outside the tolerance, and the worst of each quantity. */
export interface OracleComparison {
  readonly mismatches: readonly OracleMismatch[];
  readonly worstNode: OracleWorst;
  readonly worstBranch: OracleWorst;
}

/** Compares every node voltage and branch current of `actual` with `expected` (ADR 0012). */
export function compareOracle(
  expected: OracleCircuitResult,
  actual: OracleSolution,
  tolerance: OracleTolerance = ORACLE_TOLERANCE,
): OracleComparison {
  const mismatches: OracleMismatch[] = [];
  const worstNode = compareQuantity(
    'node',
    expected.nodes,
    actual.nodes,
    tolerance.voltageFloorV,
    tolerance,
    mismatches,
  );
  const worstBranch = compareQuantity(
    'branch',
    expected.branches,
    actual.branches,
    tolerance.currentFloorA,
    tolerance,
    mismatches,
  );
  return { mismatches, worstNode, worstBranch };
}

/** Every node voltage and branch current of `actual` outside the tolerance of `expected`; empty if it agrees. */
export function compareOracleSolution(
  expected: OracleCircuitResult,
  actual: OracleSolution,
  tolerance: OracleTolerance = ORACLE_TOLERANCE,
): OracleMismatch[] {
  return [...compareOracle(expected, actual, tolerance).mismatches];
}
