import { defineDomainVitestConfig } from '../domain/vitest.domain.mjs';

// The worker is held to the domain bar: Node environment (no DOM) and the 90 % coverage gate.
export default defineDomainVitestConfig(import.meta.dirname, 'sim-worker');
