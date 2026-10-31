import { defineDomainVitestConfig } from '../vitest.domain.mjs';
import { ALLOCATION_SPEC } from './vitest.config.mjs';

/**
 * The per-tick allocation gates alone, without coverage (see `vitest.config.mts`): the second run of
 * this project's `test` target, `vitest run -c vitest.allocation.mts`.
 */
const config = defineDomainVitestConfig(import.meta.dirname, 'sim-core');
config.test = {
  ...config.test,
  name: 'sim-core:allocation',
  include: [ALLOCATION_SPEC],
  coverage: { ...config.test?.coverage, enabled: false },
};

export default config;
