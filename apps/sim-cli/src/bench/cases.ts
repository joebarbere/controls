import { createWorld } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import type { BenchCase } from './bench';

/*
 * The cases `sim bench` runs. P2 kickoff ships one placeholder so the gate runs end to end; F2.7 adds
 * the 2,000-node plant, and the per-tick (F2.3a) and re-solve (F2.2 part 3) cases with their spec
 * §4.5 budgets. Add a case here with a `budgetMs` and the gate enforces it.
 */
export const BENCH_CASES: readonly BenchCase[] = [
  {
    // Placeholder (P2 kickoff): hash the empty seed-0 world, a small deterministic workload. No
    // budget: it only proves the bench runs from the built bundle and reports.
    name: 'placeholder-world-hash',
    warmup: 5,
    runs: 21,
    budgetMs: null,
    run: () => worldHash(createWorld({ seed: 0 })),
  },
];
