import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { type CliIo, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from '../cli';
import { WORKSPACE_ROOT } from '../script-loader';
import { type BenchCase, type BenchReport, median, runBench, runBenchCase } from './bench';
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

describe('runBenchCase', () => {
  it('reports the median of the timed runs, not the warm-up', () => {
    let calls = 0;
    const run = () => {
      calls++;
      return 'same';
    };
    const result = runBenchCase(fixedCase({ warmup: 2, runs: 3, run }), steppingClock([5, 1, 9]));
    expect(calls).toBe(5);
    expect(result).toMatchObject({ runs: 3, medianMs: 5, budgetMs: null, marginMs: null, ok: true });
    expect(result.checksum).toBe('same');
  });

  it('passes at the budget and fails one step over it, reporting the margin', () => {
    expect(runBenchCase(fixedCase({ budgetMs: 5 }), steppingClock([5, 5, 5]))).toMatchObject({
      marginMs: 0,
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
          budgetMs: null,
          marginMs: null,
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

  it('exits 1 when a case is not deterministic', async () => {
    let i = 0;
    const flaky = fixedCase({ name: 'flaky', run: () => String(i++) });
    const run = await sim({ benchCases: [flaky], now: steppingClock([1, 1, 1]) }, 'bench');
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.stderr).toEqual(['sim: bench case "flaky" returned different checksums across runs']);
  });

  it('takes no arguments', async () => {
    expect((await sim({}, 'bench', 'x')).code).toBe(EXIT_USAGE);
    expect((await sim({}, 'bench', '--seed', '1')).code).toBe(EXIT_USAGE);
  });

  it('runs from the built bundle (as the Nx bench target does) with the real cases and clock', () => {
    const result = spawnSync(process.execPath, [join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs'), 'bench'], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(EXIT_OK);
    const report = JSON.parse(result.stdout) as BenchReport;
    expect(report.ok).toBe(true);
    expect(report.cases.map((c) => c.name)).toEqual(BENCH_CASES.map((c) => c.name));
    for (const c of report.cases) expect(c.medianMs).toBeGreaterThanOrEqual(0);
    // The plant compiles to exactly 2,000 nodes in the bundle too.
    expect(report.cases[0].checksum).toMatch(/^2000:/);
    // The spec §4.5 budgets that wait for the solver and the engine stay visible.
    expect(report.pending).toStrictEqual(PENDING_BENCH_CASES);
  });
});
