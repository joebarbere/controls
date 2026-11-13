import { defineDomainVitestConfig } from '../domain/vitest.domain.mjs';

// The worker is held to the domain bar: Node environment (no DOM) and the 90 % coverage gate.
const config = defineDomainVitestConfig(import.meta.dirname, 'sim-worker');
// Heavy property tests run in parallel with coverage on slow CI runners (macOS above all), past
// Vitest's 5 s default: give every test room, as apps/sim-cli does (workspace caveats). Per-test
// timeouts that are already set stay as they are.
config.test = { ...config.test, testTimeout: 30_000 };

export default config;
