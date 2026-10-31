/*
 * `sim bench` (plan P2 kickoff step 6, F2.7): the performance gate. The Nx `bench` target runs it
 * from the built bundle, in `pnpm verify`, never under coverage instrumentation (which distorts
 * timings). Each case warms up, then reports the median of N timed runs; a case with a budget fails
 * when its median exceeds it, and any case whose runs disagree on their checksum fails too (a
 * workload that isn't deterministic can't be compared run to run). `ok` is false if any case
 * failed, and the CLI then exits 1.
 */

export interface BenchCase {
  /** Stable id, printed in the report; kebab-case. */
  readonly name: string;
  /** Untimed runs first, so JIT warm-up doesn't count. */
  readonly warmup: number;
  /** Timed runs; the median is reported. At least 1. */
  readonly runs: number;
  /** The median wall time allowed, in ms (spec §4.5 / §4.9 budgets), or null to report only. */
  readonly budgetMs: number | null;
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

export interface BenchCaseResult {
  readonly name: string;
  readonly runs: number;
  readonly medianMs: number;
  /** The 90th percentile of the timed runs (nearest rank): how wide the spread is. Never gated. */
  readonly p90Ms: number;
  readonly budgetMs: number | null;
  /** budgetMs − medianMs: how much headroom is left (negative = over budget); null without a budget. */
  readonly marginMs: number | null;
  /** The checksum every run returned, or null if they disagreed. */
  readonly checksum: string | null;
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
  const checksums = new Set<string>();
  const full = (checksum: string) => (benchCase.checksum ? `${checksum}|${benchCase.checksum()}` : checksum);
  for (let i = 0; i < benchCase.warmup; i++) {
    benchCase.prepare?.();
    checksums.add(full(benchCase.run()));
  }
  const durations: number[] = [];
  for (let i = 0; i < benchCase.runs; i++) {
    benchCase.prepare?.();
    const start = now();
    const checksum = benchCase.run();
    durations.push(now() - start);
    checksums.add(full(checksum));
  }
  const medianMs = median(durations);
  const deterministic = checksums.size === 1;
  const { budgetMs } = benchCase;
  const marginMs = budgetMs === null ? null : budgetMs - medianMs;
  return {
    name: benchCase.name,
    runs: benchCase.runs,
    medianMs,
    p90Ms: percentile(durations, 90),
    budgetMs,
    marginMs,
    checksum: deterministic ? [...checksums][0] : null,
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
