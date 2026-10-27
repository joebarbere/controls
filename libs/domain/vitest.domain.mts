import { relative, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const workspaceRoot = resolve(import.meta.dirname, '../..');

/** Plan §8: every `type:domain` lib keeps at least this much coverage, enforced by its `test` target. */
export const DOMAIN_COVERAGE_THRESHOLD = 90;

/**
 * Shared Vitest config for `type:domain` libs: Node environment (no DOM), coverage always on and
 * gated at {@link DOMAIN_COVERAGE_THRESHOLD} %, so `pnpm verify` fails when coverage drops.
 * Use from a lib's `vitest.config.mts`: `export default defineDomainVitestConfig(import.meta.dirname, '<name>');`
 */
export function defineDomainVitestConfig(projectRoot: string, name: string) {
  const projectPath = relative(workspaceRoot, projectRoot);
  return defineConfig({
    root: projectRoot,
    cacheDir: resolve(workspaceRoot, 'node_modules/.vite', projectPath),
    resolve: { tsconfigPaths: true },
    test: {
      name,
      watch: false,
      globals: true,
      environment: 'node',
      include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      reporters: ['default'],
      coverage: {
        enabled: true,
        provider: 'v8',
        reportsDirectory: resolve(workspaceRoot, 'coverage', projectPath),
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.{spec,test}.ts', 'src/**/*.d.ts'],
        thresholds: {
          lines: DOMAIN_COVERAGE_THRESHOLD,
          statements: DOMAIN_COVERAGE_THRESHOLD,
          functions: DOMAIN_COVERAGE_THRESHOLD,
          branches: DOMAIN_COVERAGE_THRESHOLD,
        },
      },
    },
  });
}
