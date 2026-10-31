import type { OracleCircuitResult } from './results';

/*
 * How a sim-core solution is compared with the corpus (ADR 0012, Proposed). Each node voltage and
 * branch current is a phasor `x` (a real `x` in DC has `im = 0`), checked against ngspice's `x_ref`:
 *
 *   |x − x_ref| ≤ relative · |x_ref| + floor
 *   floor = max(absolute floor, scale · max over the circuit of |x_ref| of the same quantity)
 *
 * The scale-aware floor keeps a value near zero (a node that cancels, a branch carrying only gmin
 * current) from failing on rounding at the circuit's own magnitude; the absolute floors bound it for
 * circuits whose quantities are all tiny. Every number here is to be confirmed by measurement when
 * F2.2 part 1 lands; whatever is chosen stays far inside the 0.5 % golden bound.
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

/** ADR 0012's proposed tolerance. Numerical test choices; to be confirmed by measurement (F2.2 part 1). */
export const ORACLE_TOLERANCE: OracleTolerance = {
  relative: 1e-6,
  voltageFloorV: 1e-9,
  // Not 1e-12 A: a branch current in doubles is only good to about ε · V_max · G_max, about 2e-11 A
  // with the generator's 10 mΩ and 820 V extremes (F2.2 part 1 found 1.4e-11 A for 1 mΩ at 120 V).
  currentFloorA: 1e-9,
  scale: 1e-9,
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
): void {
  if (actual.length !== expected.length) {
    throw new RangeError(`${quantity} values: expected ${expected.length} numbers, got ${actual.length}`);
  }
  let largest = 0;
  for (let i = 0; i < expected.length; i += 2) largest = Math.max(largest, modulus(expected[i], expected[i + 1]));
  const floor = Math.max(absoluteFloor, tolerance.scale * largest);
  for (let i = 0; i < expected.length; i += 2) {
    const error = modulus(actual[i] - expected[i], actual[i + 1] - expected[i + 1]);
    const allowed = tolerance.relative * modulus(expected[i], expected[i + 1]) + floor;
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
}

/** Every node voltage and branch current of `actual` outside the tolerance of `expected`; empty if it agrees. */
export function compareOracleSolution(
  expected: OracleCircuitResult,
  actual: OracleSolution,
  tolerance: OracleTolerance = ORACLE_TOLERANCE,
): OracleMismatch[] {
  const mismatches: OracleMismatch[] = [];
  compareQuantity('node', expected.nodes, actual.nodes, tolerance.voltageFloorV, tolerance, mismatches);
  compareQuantity('branch', expected.branches, actual.branches, tolerance.currentFloorA, tolerance, mismatches);
  return mismatches;
}
