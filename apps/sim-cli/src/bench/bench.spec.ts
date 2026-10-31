import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../cli';
import { WORKSPACE_ROOT } from '../script-loader';
import { readFileSync as readSource } from 'node:fs';
import {
  type BenchCalibration,
  type BenchCase,
  type BenchReport,
  median,
  percentile,
  runBench,
  runBenchCase,
} from './bench';
import { CALIBRATION_REFERENCE_MS, runCalibration } from './calibration';
import { BENCH_CASES, PENDING_BENCH_CASES } from './cases';

/** A fake clock: each run of a case takes the next duration from the list (ms). */
function steppingClock(durations: readonly number[]): () => number {
  let t = 1000;
  let reads = 0;
  return () => {
    // Reads come in start/end pairs; advance by the run's duration on the end read.
    if (reads % 2 === 1) t += durations[(reads - 1) / 2];
    reads++;
    return t;
  };
}

function fixedCase(overrides: Partial<BenchCase> = {}): BenchCase {
  return { name: 'fixed', warmup: 0, runs: 3, budgetMs: null, run: () => 'same', ...overrides };
}

describe('median', () => {
  it('takes the middle value, or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it('refuses an empty list', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});

describe('percentile', () => {
  it('takes the nearest rank', () => {
    expect(percentile([5, 1, 9, 3, 7, 2, 8, 4, 6, 10], 90)).toBe(9);
    expect(percentile([3, 1, 2], 90)).toBe(3);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([4, 2], 0)).toBe(2);
  });

  it('refuses an empty list', () => {
    expect(() => percentile([], 90)).toThrow(RangeError);
  });
});

describe('runBenchCase', () => {
  it('runs an invariant once after the timed runs: its failure fails the case, its value is reported', () => {
    let checks = 0;
    const holds = runBenchCase(
      fixedCase({ invariant: () => (checks++, { value: 0, failure: null }) }),
      steppingClock([1, 1, 1]),
    );
    expect(checks).toBe(1);
    expect(holds).toMatchObject({ ok: true, invariant: { value: 0, failure: null } });
    const fails = runBenchCase(
      fixedCase({ invariant: () => ({ value: 16, failure: 'allocated 16 B' }) }),
      steppingClock([1, 1, 1]),
    );
    expect(fails).toMatchObject({
      ok: false,
      deterministic: true,
      invariant: { value: 16, failure: 'allocated 16 B' },
    });
    expect(runBenchCase(fixedCase(), steppingClock([1, 1, 1])).invariant).toBeNull();
  });

  it('reports the median of the timed runs, not the warm-up', () => {
    let calls = 0;
    const run = () => {
      calls++;
      return 'same';
    };
    const result = runBenchCase(fixedCase({ warmup: 2, runs: 3, run }), steppingClock([5, 1, 9]));
    expect(calls).toBe(5);
    expect(result).toMatchObject({
      runs: 3,
      medianMs: 5,
      budgetMs: null,
      calibration: null,
      gatedMs: 5,
      marginMs: null,
      ratio: null,
      ok: true,
    });
    expect(result.checksum).toBe('same');
  });

  it('passes at the budget and fails one step over it, reporting the margin', () => {
    expect(runBenchCase(fixedCase({ budgetMs: 5 }), steppingClock([5, 5, 5]))).toMatchObject({
      gatedMs: 5,
      marginMs: 0,
      ratio: 1,
      ok: true,
    });
    expect(runBenchCase(fixedCase({ budgetMs: 5 }), steppingClock([6, 6, 1]))).toMatchObject({
      medianMs: 6,
      marginMs: -1,
      ok: false,
    });
  });

  it('fails a case whose runs disagree, even without a budget', () => {
    let i = 0;
    const result = runBenchCase(fixedCase({ run: () => `run-${i++}` }), steppingClock([1, 1, 1]));
    expect(result).toMatchObject({ deterministic: false, checksum: null, ok: false });
  });

  it('runs prepare before every run, outside the timing', () => {
    const order: string[] = [];
    const reads: number[] = [];
    let t = 0;
    const clock = () => {
      reads.push(order.length);
      return (t += 1);
    };
    const benchCase = fixedCase({
      warmup: 1,
      runs: 2,
      prepare: () => order.push('prepare'),
      run: () => (order.push('run'), 'same'),
    });
    expect(runBenchCase(benchCase, clock).medianMs).toBe(1);
    expect(order).toEqual(['prepare', 'run', 'prepare', 'run', 'prepare', 'run']);
    // The clock is read after each prepare and before the next: prepare is never inside a timing.
    expect(reads).toEqual([3, 4, 5, 6]);
  });

  it('counts warm-up checksums too', () => {
    let i = 0;
    const result = runBenchCase(
      fixedCase({ warmup: 1, runs: 1, run: () => (i++ === 0 ? 'warm' : 'timed') }),
      steppingClock([1]),
    );
    expect(result.deterministic).toBe(false);
  });

  it.each([0, -1, 1.5])('refuses runs = %s', (runs) => {
    expect(() => runBenchCase(fixedCase({ runs }), steppingClock([]))).toThrow(RangeError);
  });
});

describe('runBenchCase with a calibration (F2.2 part 3b)', () => {
  const calibration = (overrides: Partial<BenchCalibration> = {}): BenchCalibration => ({
    name: 'cal',
    referenceMs: 2,
    run: () => 'cal',
    ...overrides,
  });
  /** Durations for interleaved runs: case i, then calibration i. */
  const interleaved = (cases: number[], cals: number[]) => cases.flatMap((c, i) => [c, cals[i]]);

  it('holds the median of each run in reference-machine ms (tᵢ × reference / cᵢ) to the budget', () => {
    // Pairs (case, calibration): (9, 4), (10, 3), (7, 6) against a 2 ms reference give 4.5, 6.67 and
    // 2.33 reference ms: median 4.5 against the 5 ms budget. The calibration's own median (4 ms, scale
    // 2) is reported, not gated.
    const benchCase = fixedCase({ budgetMs: 5, calibration: calibration() });
    const result = runBenchCase(benchCase, steppingClock(interleaved([9, 10, 7], [4, 3, 6])));
    expect(result).toMatchObject({
      medianMs: 9,
      budgetMs: 5,
      calibration: { name: 'cal', medianMs: 4, p90Ms: 6, referenceMs: 2, scale: 2, checksum: 'cal' },
      gatedMs: 4.5,
      marginMs: 0.5,
      ratio: 0.9,
      ok: true,
    });
  });

  it('pairs each run with the calibration beside it, so a burst of load on one pair cancels', () => {
    // The middle pair ran 3× slower (both halves): it still normalises to 4 reference ms.
    const benchCase = fixedCase({ budgetMs: 5, calibration: calibration() });
    const result = runBenchCase(benchCase, steppingClock(interleaved([8, 24, 8], [4, 12, 4])));
    expect(result).toMatchObject({ gatedMs: 4, ok: true });
    // A burst that hits two case runs but only one calibration run: the plain medians (24 ms against a
    // budget of 5 × 4 / 2 = 10 ms) would fail; two of the three pairs are still clean.
    const skewed = runBenchCase(benchCase, steppingClock(interleaved([8, 24, 24], [4, 12, 4])));
    expect(skewed).toMatchObject({ medianMs: 24, calibration: { scale: 2 }, gatedMs: 4, ok: true });
  });

  it('passes at the budget and fails one step over it; a faster machine tightens it', () => {
    const benchCase = fixedCase({ budgetMs: 5, calibration: calibration() });
    expect(runBenchCase(benchCase, steppingClock(interleaved([10, 10, 10], [4, 4, 4]))).ok).toBe(true);
    expect(runBenchCase(benchCase, steppingClock(interleaved([11, 11, 11], [4, 4, 4]))).ok).toBe(false);
    // Calibration at 1 ms against the 2 ms reference: 3 ms here is 6 reference ms, over 5.
    expect(runBenchCase(benchCase, steppingClock(interleaved([3, 3, 3], [1, 1, 1])))).toMatchObject({
      gatedMs: 6,
      ok: false,
    });
  });

  it('a 1.5× slower case fails a gate it passed, whatever the machine speed', () => {
    const benchCase = fixedCase({ budgetMs: 5, calibration: calibration() });
    for (const speed of [0.5, 1, 3]) {
      const cal = [2, 2, 2].map((c) => c * speed);
      const t = [4, 4, 4].map((c) => c * speed);
      expect(runBenchCase(benchCase, steppingClock(interleaved(t, cal))).ok).toBe(true);
      expect(
        runBenchCase(
          benchCase,
          steppingClock(
            interleaved(
              t.map((x) => x * 1.5),
              cal,
            ),
          ),
        ).ok,
      ).toBe(false);
    }
  });

  it('fails when a calibration run takes no measurable time, never passes', () => {
    const benchCase = fixedCase({ budgetMs: 5, calibration: calibration() });
    expect(runBenchCase(benchCase, steppingClock(interleaved([1, 1, 1], [0, 0, 0])))).toMatchObject({
      gatedMs: Number.POSITIVE_INFINITY,
      ok: false,
    });
  });

  it('times the calibration right after each timed run of the case, and runs it untimed in the warm-up', () => {
    const order: string[] = [];
    let t = 0;
    const clock = () => {
      order.push('clock');
      return (t += 1);
    };
    const benchCase = fixedCase({
      warmup: 1,
      runs: 2,
      budgetMs: 100,
      prepare: () => order.push('prepare'),
      run: () => (order.push('case'), 'same'),
      calibration: calibration({ run: () => (order.push('cal'), 'cal') }),
    });
    runBenchCase(benchCase, clock);
    const timedRun = ['prepare', 'clock', 'case', 'clock', 'clock', 'cal', 'clock'];
    expect(order).toEqual(['prepare', 'case', 'cal', ...timedRun, ...timedRun]);
  });

  it('fails when the calibration is not deterministic, whatever the timing', () => {
    let i = 0;
    const benchCase = fixedCase({ budgetMs: 100, calibration: calibration({ run: () => `cal-${i++}` }) });
    const result = runBenchCase(benchCase, steppingClock(interleaved([1, 1, 1], [2, 2, 2])));
    expect(result).toMatchObject({ checksum: 'same', deterministic: false, ok: false });
    expect(result.calibration?.checksum).toBeNull();
  });

  it('refuses a calibration without a budget, or with a reference that is not positive', () => {
    expect(() => runBenchCase(fixedCase({ calibration: calibration() }), steppingClock([]))).toThrow(RangeError);
    for (const referenceMs of [0, -1, Number.NaN]) {
      const benchCase = fixedCase({ budgetMs: 1, calibration: calibration({ referenceMs }) });
      expect(() => runBenchCase(benchCase, steppingClock([]))).toThrow(RangeError);
    }
  });
});

describe('the calibration loop', () => {
  it('returns the same checksum on every run', () => {
    const first = runCalibration();
    for (let i = 0; i < 3; i++) expect(runCalibration()).toBe(first);
  });

  it('shares no code with what it calibrates: it imports nothing but a type', () => {
    // A regression in sim-core (or anything it uses) must not slow the calibration too, or the gate
    // would absorb it.
    const source = readSource(join(WORKSPACE_ROOT, 'apps/sim-cli/src/bench/calibration.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export .* from)\b/.test(line));
    expect(imports).toStrictEqual(["import type { SourcedConstant } from '@controls/sim-core';"]);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it('has a sourced reference that names its machine', () => {
    expect(CALIBRATION_REFERENCE_MS.value).toBeGreaterThan(0);
    expect(CALIBRATION_REFERENCE_MS).toMatchObject({ unit: 'ms', kind: 'numerical' });
    expect(CALIBRATION_REFERENCE_MS.source).toMatch(/Ryzen 5 5600X/);
  });
});

describe('runBench', () => {
  it('lists pending cases without running them or letting them fail the report', () => {
    const pending = [{ name: 'later', budgetMs: 1, enabledBy: 'F9.9' }];
    expect(runBench([fixedCase()], steppingClock([1, 1, 1]), pending)).toMatchObject({ pending, ok: true });
  });

  it('is ok only if every case is', () => {
    const over = fixedCase({ name: 'over', budgetMs: 1 });
    expect(runBench([fixedCase()], steppingClock([2, 2, 2])).ok).toBe(true);
    const report = runBench([fixedCase(), over], steppingClock([2, 2, 2, 2, 2, 2]));
    expect(report.cases.map((c) => [c.name, c.ok])).toEqual([
      ['fixed', true],
      ['over', false],
    ]);
    expect(report.ok).toBe(false);
  });
});

describe('the shipped bench cases', () => {
  it('have unique kebab-case names and at least one timed run', () => {
    const names = BENCH_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of BENCH_CASES) {
      expect(c.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.runs).toBeGreaterThanOrEqual(1);
    }
  });

  it('gate the re-solve at spec §4.5’s 2 ms, scaled by the calibration loop; nothing else is calibrated', () => {
    const calibrated = BENCH_CASES.filter((c) => c.calibration !== undefined);
    expect(calibrated.map((c) => [c.name, c.budgetMs])).toStrictEqual([['plant-resolve-topology-change', 2]]);
    expect(calibrated[0].calibration).toMatchObject({
      run: runCalibration,
      referenceMs: CALIBRATION_REFERENCE_MS.value,
    });
    expect(PENDING_BENCH_CASES.map((c) => c.name)).not.toContain('plant-resolve-topology-change');
  });
});

describe('sim bench', () => {
  async function sim(io: Partial<CliIo>, ...argv: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(argv, {
      cwd: WORKSPACE_ROOT,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      ...io,
    });
    return { code, stdout, stderr };
  }

  it('prints a JSON report and exits 0 when every case passes', async () => {
    const run = await sim({ benchCases: [fixedCase()], now: steppingClock([1, 1, 1]) }, 'bench');
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toEqual([]);
    const report = JSON.parse(run.stdout.join('\n')) as BenchReport;
    expect(report).toEqual({
      cases: [
        {
          name: 'fixed',
          runs: 3,
          medianMs: 1,
          p90Ms: 1,
          p99Ms: 1,
          budgetMs: null,
          invariant: null,
          calibration: null,
          gatedMs: 1,
          marginMs: null,
          ratio: null,
          checksum: 'same',
          deterministic: true,
          ok: true,
        },
      ],
      pending: [],
      ok: true,
    });
  });

  it('exits 1 and names the case when one is over budget', async () => {
    const over = fixedCase({ name: 'over', budgetMs: 2 });
    const run = await sim({ benchCases: [over], now: steppingClock([3, 3, 3]) }, 'bench');
    expect(run.code).toBe(EXIT_FAILURE);
    expect(JSON.parse(run.stdout.join('\n')).ok).toBe(false);
    expect(run.stderr).toEqual(['sim: bench case "over" over budget: median 3 ms > 2 ms']);
  });

  it('names the reference-machine time and the calibration when a calibrated case is over budget', async () => {
    const over = fixedCase({
      name: 'over',
      budgetMs: 2,
      calibration: { name: 'cal', referenceMs: 1, run: () => 'cal' },
    });
    const run = await sim({ benchCases: [over], now: steppingClock([5, 2, 5, 2, 5, 2]) }, 'bench');
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr).toEqual([
      'sim: bench case "over" over budget: 2.5 ms on the reference machine > 2 ms (median 5 ms here, beside the cal at 2 ms against its reference 1 ms)',
    ]);
  });

  it('exits 1 when a case is not deterministic', async () => {
    let i = 0;
    const flaky = fixedCase({ name: 'flaky', run: () => String(i++) });
    const run = await sim({ benchCases: [flaky], now: steppingClock([1, 1, 1]) }, 'bench');
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr).toEqual(['sim: bench case "flaky" returned different checksums across runs']);
  });

  it('writes the report to --report too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-bench-'));
    try {
      const file = join(dir, 'report.json');
      const run = await sim({ benchCases: [fixedCase()], now: steppingClock([1, 1, 1]) }, 'bench', '--report', file);
      expect(run.code).toBe(EXIT_OK);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(run.stdout.join('\n')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes no arguments', async () => {
    expect((await sim({}, 'bench', 'x')).code).toBe(EXIT_USAGE);
    expect((await sim({}, 'bench', '--seed', '1')).code).toBe(EXIT_USAGE);
  });

  it('runs from the built bundle (as the Nx bench target does) with the real cases and clock', () => {
    // Shape and determinism only, never timing: this runs beside the suite's other workers, so only
    // the Nx `bench` target (run on its own, after everything else in `pnpm verify`) gates (#53).
    const result = spawnSync(process.execPath, [join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs'), 'bench'], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect([EXIT_OK, EXIT_FAILURE]).toContain(result.status);
    // The only thing it may say on stderr is that a case is over budget.
    for (const line of result.stderr.split('\n').filter((l) => l !== '')) expect(line).toMatch(/ over budget: /);
    const report = JSON.parse(result.stdout) as BenchReport;
    expect(report.cases.map((c) => c.name)).toEqual(BENCH_CASES.map((c) => c.name));
    for (const c of report.cases) {
      expect(c.deterministic).toBe(true);
      expect(c.checksum).not.toBeNull();
      expect(c.medianMs).toBeGreaterThanOrEqual(0);
      expect(c.p90Ms).toBeGreaterThanOrEqual(c.medianMs);
    }
    // The plant compiles to exactly 2,000 nodes in the bundle too.
    expect(report.cases[0].checksum).toMatch(/^2000:/);
    // The re-solve case ran calibrated, beside its calibration loop, and reported its ratio.
    const resolve = report.cases.find((c) => c.name === 'plant-resolve-topology-change');
    expect(resolve).toMatchObject({ budgetMs: 2, calibration: { name: 'calibration-loop' } });
    expect(resolve?.calibration?.checksum).not.toBeNull();
    expect(resolve?.ratio).toBeGreaterThan(0);
    // The spec §4.5 budgets that wait for the solver and the engine stay visible.
    expect(report.pending).toStrictEqual(PENDING_BENCH_CASES);
    // The per-frame snapshot read: reported with p50 and p99, gated on allocating nothing.
    const read = report.cases.find((c) => c.name === 'snapshot-read-500-devices');
    expect(read).toMatchObject({ budgetMs: null, ok: true, invariant: { failure: null } });
    expect(read?.p99Ms).toBeGreaterThanOrEqual(read?.medianMs ?? Infinity);
  });
});
