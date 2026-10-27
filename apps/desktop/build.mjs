#!/usr/bin/env node
// Bundles Electron main + preload with esbuild and assembles the self-contained app directory
// dist/apps/desktop/ (main.cjs, preload.cjs, renderer/, package.json) that electron-builder packages.
// All runtime dependencies are bundled, so the packaged app ships no node_modules.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(root, 'dist/apps/desktop');
const rendererBuild = join(root, 'dist/apps/game/browser');
const production = process.argv.includes('--production');

if (!existsSync(join(rendererBuild, 'index.html'))) {
  console.error(`missing renderer build at ${rendererBuild} — run \`nx build game\` first`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  tsconfig: join(here, 'tsconfig.app.json'),
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(out, 'main.cjs') });
await build({ ...common, entryPoints: [join(here, 'src/preload.ts')], outfile: join(out, 'preload.cjs') });

cpSync(rendererBuild, join(out, 'renderer'), { recursive: true });
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log(`desktop app assembled at ${out} (v${pkg.version}${production ? ', production' : ''})`);
