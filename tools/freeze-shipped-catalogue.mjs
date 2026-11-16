#!/usr/bin/env node
// Freeze the catalogue a release ships (ADR 0016): write libs/domain/catalog/fixtures/shipped/<version>.json,
// which libs/domain/catalog/src/lib/shipped.spec.ts then holds every later catalogue to.
//
//   pnpm catalog:freeze [version|vX.Y.Z]            → writes the file (version defaults to package.json's)
//   pnpm catalog:freeze [version|vX.Y.Z] --stdout   → prints it instead (a preview; writes nothing)
//
// Run it in the release commit, after version-keeper has rolled CHANGELOG.md's [Unreleased] into the
// dated `## [x.y.z] - YYYY-MM-DD` section (from then on shipped.spec.ts requires the file) and before the
// tag, so the list is the catalogue at the tag. The list is every `content/` family (devices, tables,
// tools, cables, accessories), each family's `*.json` files in name order (as the built-in mirrors are),
// and the `CATALOG_VERSION` of libs/domain/catalog/src/lib/builtin.ts. It refuses a version with no dated
// CHANGELOG section and a version that already has a list: a shipped list is never regenerated.
// Formatted with the repo's Prettier config, so `prettier --check` in `pnpm verify` passes.
// Tested by freeze-shipped-catalogue.test.mjs (part of `pnpm verify`).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normaliseVersion } from './release-notes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHIPPED_DIR = join(ROOT, 'libs/domain/catalog/fixtures/shipped');
/** The `content/` directories a frozen list holds, in the list's key order. */
export const FAMILIES = ['devices', 'tables', 'tools', 'cables', 'accessories'];

/** `CATALOG_VERSION` from builtin.ts's source. */
export function catalogVersionOf(builtinSource) {
  const match = /^export const CATALOG_VERSION = (\d+);$/m.exec(builtinSource);
  if (!match) throw new Error('builtin.ts has no "export const CATALOG_VERSION = <n>;" line');
  return Number(match[1]);
}

/** The versions CHANGELOG.md lists as released (its dated `## [x.y.z] - YYYY-MM-DD` headings). */
export function releasedVersions(changelog) {
  return [...changelog.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}/gm)].map((match) => match[1]);
}

/** One `content/` family: its `*.json` documents, sorted by file name. */
export function readFamily(root, family) {
  const dir = join(root, 'content', family);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

/** The frozen list for `release`: what the repository at `root` ships. */
export function freezeRelease(root, release) {
  const catalogVersion = catalogVersionOf(readFileSync(join(root, 'libs/domain/catalog/src/lib/builtin.ts'), 'utf8'));
  const list = { release, tag: `v${release}`, catalogVersion };
  for (const family of FAMILIES) list[family] = readFamily(root, family);
  return list;
}

/** Checks that `release` may be frozen now; throws why not. */
export function checkFreezable(root, release, shippedDir = SHIPPED_DIR) {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (!releasedVersions(changelog).includes(release)) {
    throw new Error(
      `CHANGELOG.md has no dated "## [${release}] - YYYY-MM-DD" section: roll [Unreleased] first (version-keeper)`,
    );
  }
  const file = join(shippedDir, `${release}.json`);
  if (existsSync(file)) throw new Error(`${file} exists: a shipped list is frozen and never regenerated`);
  return file;
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const stdout = argv.includes('--stdout');
  const version = normaliseVersion(args[0] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  const file = checkFreezable(ROOT, version);
  const { format, resolveConfig } = await import('prettier');
  const options = { ...(await resolveConfig(file)), filepath: file };
  const text = await format(JSON.stringify(freezeRelease(ROOT, version)), options);
  if (stdout) {
    process.stdout.write(text);
  } else {
    writeFileSync(file, text);
    process.stderr.write(`wrote ${file}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`freeze-shipped-catalogue: ${error.message}\n`);
    process.exit(1);
  });
}
