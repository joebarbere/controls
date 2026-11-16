// node --test tools/freeze-shipped-catalogue.test.mjs (part of `pnpm verify`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAMILIES,
  catalogVersionOf,
  checkFreezable,
  freezeRelease,
  releasedVersions,
} from './freeze-shipped-catalogue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools/freeze-shipped-catalogue.mjs');

test('catalogVersionOf reads the exported constant', () => {
  assert.equal(catalogVersionOf('/** doc */\nexport const CATALOG_VERSION = 7;\n'), 7);
  assert.throws(() => catalogVersionOf('const CATALOG_VERSION = 7;'), /CATALOG_VERSION/);
});

test('releasedVersions reads dated headings, never [Unreleased] or link definitions', () => {
  const changelog =
    '## [Unreleased]\n\n## [0.4.0] - 2026-12-01\n\n## [0.3.0] - 2026-11-11\n\n[0.4.0]: https://x/compare';
  assert.deepEqual(releasedVersions(changelog), ['0.4.0', '0.3.0']);
});

test("freezeRelease holds every content family, files in name order, and builtin.ts's catalogue version", () => {
  const list = freezeRelease(ROOT, '9.9.9');
  assert.deepEqual(Object.keys(list), ['release', 'tag', 'catalogVersion', ...FAMILIES]);
  assert.equal(list.tag, 'v9.9.9');
  const builtin = readFileSync(join(ROOT, 'libs/domain/catalog/src/lib/builtin.ts'), 'utf8');
  assert.equal(list.catalogVersion, catalogVersionOf(builtin));
  for (const family of FAMILIES) {
    const names = readdirSync(join(ROOT, 'content', family))
      .filter((n) => n.endsWith('.json'))
      .sort();
    assert.equal(list[family].length, names.length, family);
    assert.ok(list[family].length > 0, family);
    names.forEach((name, i) =>
      assert.deepEqual(list[family][i], JSON.parse(readFileSync(join(ROOT, 'content', family, name), 'utf8'))),
    );
  }
});

test('checkFreezable refuses an unreleased version and an existing list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freeze-'));
  try {
    assert.throws(() => checkFreezable(ROOT, '9.9.9', dir), /no dated "## \[9\.9\.9\]/);
    writeFileSync(join(dir, '0.3.0.json'), '{}');
    assert.throws(() => checkFreezable(ROOT, '0.3.0', dir), /never regenerated/);
    rmSync(join(dir, '0.3.0.json'));
    assert.equal(checkFreezable(ROOT, '0.3.0', dir), join(dir, '0.3.0.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI refuses the shipped 0.3.0 and an unreleased version, writing nothing', () => {
  for (const version of ['0.3.0', 'v9.9.9']) {
    const run = spawnSync(process.execPath, [SCRIPT, version, '--stdout'], { encoding: 'utf8' });
    assert.equal(run.status, 1, version);
    assert.equal(run.stdout, '', version);
    assert.match(run.stderr, /freeze-shipped-catalogue: /, version);
  }
});
