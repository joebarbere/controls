#!/usr/bin/env node
// Fails (exit 1) if any version source disagrees with the root package.json.
// Part of `pnpm verify` and CI. Fix drift with `pnpm version:sync`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const { version } = JSON.parse(read('package.json'));
const problems = [];

const desktop = JSON.parse(read('apps/desktop/package.json')).version;
if (desktop !== version) problems.push(`apps/desktop/package.json is ${desktop}`);

const ts = read('libs/domain/units/src/lib/version.ts').match(/APP_VERSION = '([^']+)'/)?.[1];
if (ts !== version) problems.push(`libs/domain/units/src/lib/version.ts is ${ts}`);

// A released version must have its own CHANGELOG section; 0.0.0 means "never released".
if (version !== '0.0.0') {
  const changelog = read('CHANGELOG.md');
  if (!changelog.includes(`## [${version}]`)) problems.push(`CHANGELOG.md has no "## [${version}]" section`);
}

if (problems.length) {
  console.error(`version drift (root package.json is ${version}):\n  - ${problems.join('\n  - ')}`);
  console.error('run `pnpm version:sync` (and roll the CHANGELOG) to fix.');
  process.exit(1);
}
console.log(`version sources in sync at ${version}`);
