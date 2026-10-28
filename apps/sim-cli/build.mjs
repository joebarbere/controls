#!/usr/bin/env node
// Bundles sim-cli into one ESM file for plain Node 24: dist/apps/sim-cli/main.mjs. The domain libs
// and zod are bundled; esbuild stays external because it is only loaded (from the workspace's
// node_modules) when a TypeScript scenario script runs. Imported by bin/sim.mjs (`pnpm sim`) and run
// directly by the Nx `build` target.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
export const SIM_CLI_BUNDLE = join(root, 'dist/apps/sim-cli/main.mjs');

export async function buildSimCli() {
  await build({
    entryPoints: [join(here, 'src/main.ts')],
    outfile: SIM_CLI_BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['esbuild'],
    tsconfig: join(here, 'tsconfig.app.json'),
    sourcemap: 'linked',
    logLevel: 'warning',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSimCli();
  console.log(`sim-cli bundled at ${SIM_CLI_BUNDLE}`);
}
