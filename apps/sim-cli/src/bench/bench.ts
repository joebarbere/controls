/*
 * `sim bench` (plan P2 kickoff step 6, F2.7): the performance gate. The Nx `bench` target runs it
 * from the built bundle, in `pnpm verify`, never under coverage instrumentation (which distorts
 * timings). Each case warms up, then reports the median of N timed runs; a case with a budget fails
 * when its median exceeds it, and any case whose runs disagree on their checksum fails too (a
 * workload that isn't deterministic can't be compared run to run). `ok` is false if any case
 * failed, and the CLI then exits 1.
 *
 * A calibrated case (F2.2 part 3b) scales its budget to the machine. Each timed run i of the case
 * (tᵢ) is followed at once by a timed run of a fixed calibration workload (cᵢ), in the same process,
 * and the gate is
 *
 *   median over i of  tᵢ × referenceMs / cᵢ  ≤  budgetMs,
 *
 * where `referenceMs` is the calibration's median on the reference machine: each run is put in the
 * reference machine's milliseconds by the calibration run beside it, and the median of those is held
 * to the spec's budget. Equivalently, every run's budget is `budgetMs × cᵢ / referenceMs`. A slower
 * runner slows both; so does load, and because the two runs of a pair are adjacent, a burst of load
 * hits both. That pairing is what keeps the gate stable under `pnpm verify`'s parallel tasks: the
 * plain `median(t) ≤ budgetMs × median(c) / referenceMs` (which this reports as `scale`) spread 3.2×
 * over 32 loaded runs, the paired median 1.7× (docs/caveats/simulation.md). A regression in the case
 * moves every tᵢ and no cᵢ, so it still fails the gate on any machine, and nothing is skipped per OS.
 */

/** A fixed workload and its median on the reference machine, for scaling a case's budget. */
export interface BenchCalibration {
  /** Stable id, printed in the report. */
  readonly name: string;
  /** The workload's median on the reference machine, in ms (a sourced constant). */
  readonly referenceMs: number;
  /** The workload. Returns a checksum, which must be the same on every run. Never shares code with the case. */
  run(): string;
}

export interface BenchCase {
  /** Stable id, printed in the report; kebab-case. */
  readonly name: string;
  /** Untimed runs first, so JIT warm-up doesn't count. */
  readonly warmup: number;
  /** Timed runs; the median is reported. At least 1. */
  readonly runs: number;
  /**
   * The median wall time allowed, in ms (spec §4.5 / §4.9 budgets), or null to report only. With a
   * `calibration`, the budget on the reference machine, scaled to this one.
   */
  readonly budgetMs: number | null;
  /** Scales `budgetMs` to this machine (see the file comment). Needs a budget. */
  readonly calibration?: BenchCalibration;
  /** Untimed set-up before every run, warm-up included (putting a compiler back in a known state). */
  prepare?(): void;
  /** The workload. Returns a checksum of its result, which must be the same on every run. */
  run(): string;
  /**
   * Untimed, right after each run: more of the result's checksum, joined to `run`'s (a digest of
   * state that would cost time to form inside the timed run, so idle work can't pass as real work).
   */
  checksum?(): string;
}

/** How a calibrated case was put in the reference machine's terms. */
export interface BenchCalibrationResult {
  readonly name: string;
  /** The calibration's median here, timed run for run beside the case. */
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly referenceMs: number;
  /** medianMs / referenceMs: how much slower than the reference machine this one was. Reported, not gated. */
  readonly scale: number;
  /** The calibration's checksum, or null if its runs disagreed. */
  readonly checksum: string | null;
}

export interface BenchCaseResult {
  readonly name: string;
  readonly runs: number;
  readonly medianMs: number;
  /** The 90th percentile of the timed runs (nearest rank): how wide the spread is. Never gated. */
  readonly p90Ms: number;
  readonly budgetMs: number | null;
  /** The calibration, or null for a case gated (or reported) in raw ms. */
  readonly calibration: BenchCalibrationResult | null;
  /**
   * What is held to `budgetMs`: `medianMs`, or for a calibrated case the median of each run in the
   * reference machine's ms (tᵢ × referenceMs / cᵢ).
   */
  readonly gatedMs: number;
  /** budgetMs − gatedMs: how much headroom is left (negative = over budget); null without a budget. */
  readonly marginMs: number | null;
  /** gatedMs / budgetMs: the gated ratio (≤ 1 passes); null without a budget. */
  readonly ratio: number | null;
  /** The checksum every run returned, or null if they disagreed. */
  readonly checksum: string | null;
  /** The case's runs agreed on their checksum, and so did its calibration's. */
  readonly deterministic: boolean;
  readonly ok: boolean;
}

/** A spec budget whose case can't run yet: listed in the report so the gap stays visible. */
export interface PendingBenchCase {
  readonly name: string;
  /** The spec's budget for it (ms). */
  readonly budgetMs: number;
  /** The feature that switches it on (`F2.2 part 3`). */
  readonly enabledBy: string;
}

export interface BenchReport {
  readonly cases: readonly BenchCaseResult[];
  /** Cases waiting for the code they measure; they never affect `ok`. */
  readonly pending: readonly PendingBenchCase[];
  readonly ok: boolean;
}

/** The nearest-rank percentile `p` (0–100) of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('percentile of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** The median of a non-empty list (the mean of the two middle values for an even count). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function runBenchCase(benchCase: BenchCase, now: () => number): BenchCaseResult {
  if (!Number.isInteger(benchCase.runs) || benchCase.runs < 1) {
    throw new RangeError(`bench case "${benchCase.name}": runs must be a positive integer`);
  }
  const { calibration, budgetMs } = benchCase;
  if (calibration !== undefined) {
    if (budgetMs === null) throw new RangeError(`bench case "${benchCase.name}": a calibration needs a budget`);
    if (!(calibration.referenceMs > 0)) {
      throw new RangeError(`bench case "${benchCase.name}": calibration referenceMs must be positive`);
    }
  }
  const checksums = new Set<string>();
  const calibrationChecksums = new Set<string>();
  const full = (checksum: string) => (benchCase.checksum ? `${checksum}|${benchCase.checksum()}` : checksum);
  for (let i = 0; i < benchCase.warmup; i++) {
    benchCase.prepare?.();
    checksums.add(full(benchCase.run()));
    if (calibration) calibrationChecksums.add(calibration.run());
  }
  const durations: number[] = [];
  const calibrationDurations: number[] = [];
  for (let i = 0; i < benchCase.runs; i++) {
    benchCase.prepare?.();
    const start = now();
    const checksum = benchCase.run();
    durations.push(now() - start);
    checksums.add(full(checksum));
    if (calibration) {
      // Right after the case, so both see the same machine state (load, clocks, thermals).
      const calibrationStart = now();
      calibrationChecksums.add(calibration.run());
      calibrationDurations.push(now() - calibrationStart);
    }
  }
  const medianMs = median(durations);
  let calibrationResult: BenchCalibrationResult | null = null;
  let gatedMs = medianMs;
  if (calibration) {
    const calibrationMedianMs = median(calibrationDurations);
    calibrationResult = {
      name: calibration.name,
      medianMs: calibrationMedianMs,
      p90Ms: percentile(calibrationDurations, 90),
      referenceMs: calibration.referenceMs,
      scale: calibrationMedianMs / calibration.referenceMs,
      checksum: calibrationChecksums.size === 1 ? [...calibrationChecksums][0] : null,
    };
    // A calibration run that took no measurable time gives Infinity: over budget, never a pass.
    gatedMs = median(durations.map((t, i) => (t * calibration.referenceMs) / calibrationDurations[i]));
  }
  const deterministic = checksums.size === 1 && (calibration === undefined || calibrationChecksums.size === 1);
  const marginMs = budgetMs === null ? null : budgetMs - gatedMs;
  return {
    name: benchCase.name,
    runs: benchCase.runs,
    medianMs,
    p90Ms: percentile(durations, 90),
    budgetMs,
    calibration: calibrationResult,
    gatedMs,
    marginMs,
    ratio: budgetMs === null ? null : gatedMs / budgetMs,
    checksum: checksums.size === 1 ? [...checksums][0] : null,
    deterministic,
    ok: deterministic && (marginMs === null || marginMs >= 0),
  };
}

export function runBench(
  cases: readonly BenchCase[],
  now: () => number,
  pending: readonly PendingBenchCase[] = [],
): BenchReport {
  const results = cases.map((benchCase) => runBenchCase(benchCase, now));
  return { cases: results, pending, ok: results.every((result) => result.ok) };
}
