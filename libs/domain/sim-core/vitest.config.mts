import { configDefaults } from 'vitest/config';
import { defineDomainVitestConfig } from '../vitest.domain.mjs';

/**
 * The per-tick allocation gates (F2.4's and F2.5's files), which run alone and uncovered (`vitest.allocation.mts`, the second
 * half of this project's `test` target, so they stay in `pnpm verify`). Coverage instrumentation
 * changes what V8 optimizes and made them 4–5× slower (a gate took 6–10 s on CI's runners, past
 * Vitest's 5 s timeout); they measure the uninstrumented engine the game runs (simulation caveats,
 * "Measuring allocation in a spec").
 */
export const ALLOCATION_SPECS = ['src/lib/engine/allocation.spec.ts', 'src/lib/engine/allocation-loads.spec.ts'];

const config = defineDomainVitestConfig(import.meta.dirname, 'sim-core');
config.test = { ...config.test, exclude: [...configDefaults.exclude, ...ALLOCATION_SPECS] };

export default config;
