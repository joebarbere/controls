import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/sim-cli',
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'sim-cli',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    // The four-surface and boundary tests spawn Node and ESLint; give them room on slow CI runners.
    testTimeout: 60_000,
    coverage: {
      reportsDirectory: '../../coverage/apps/sim-cli',
      provider: 'v8' as const,
    },
  },
}));
