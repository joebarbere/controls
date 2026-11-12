import { defineDomainVitestConfig } from '../vitest.domain.mjs';

const config = defineDomainVitestConfig(import.meta.dirname, 'world-model');
// Heavy property tests run in parallel with coverage on slow CI runners (macOS above all), past
// Vitest's 5 s default: give every test room, as apps/sim-cli does (workspace caveats). Per-test
// timeouts that are already set stay as they are.
config.test = { ...config.test, testTimeout: 30_000 };

export default config;
