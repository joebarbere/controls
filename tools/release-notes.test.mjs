// node --test tools/release-notes.test.mjs (part of `pnpm verify`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAX_BODY, normaliseVersion, releaseNotes, releaseTitle, repoUrlOf } from './release-notes.mjs';

const REPO = 'https://github.com/o/r';
const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- Something unreleased.

## [1.1.0] - 2026-11-11

Phase 2, "First light": the circuit engine. See [the guide](docs/guides/x.md#a), [ADR](./docs/decisions/0001.md).

### Added

- A [site](https://example.com), an [anchor](#added) and a [root](/abs).

## [1.0.1] - 2026-11-01

### Fixed

- A patch.

## [1.0.0] - 2026-10-01

Phase 1, "Hands on the panel": the shell.

[Unreleased]: https://github.com/o/r/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/o/r/compare/v1.0.1...v1.1.0
[1.0.0]: https://github.com/o/r/releases/tag/v1.0.0
`;

test('the body is the section without its heading, up to the next section', () => {
  const notes = releaseNotes(CHANGELOG, '1.0.1', REPO);
  assert.equal(notes, '### Fixed\n\n- A patch.\n');
});

test('repo-relative links point at the tag; absolute, anchor and root links are untouched', () => {
  const notes = releaseNotes(CHANGELOG, '1.1.0', REPO);
  assert.match(notes, /^Phase 2, "First light"/);
  assert.ok(notes.includes('[the guide](https://github.com/o/r/blob/v1.1.0/docs/guides/x.md#a)'));
  assert.ok(notes.includes('[ADR](https://github.com/o/r/blob/v1.1.0/docs/decisions/0001.md)'));
  assert.ok(notes.includes('[site](https://example.com)'));
  assert.ok(notes.includes('[anchor](#added)'));
  assert.ok(notes.includes('[root](/abs)'));
  assert.ok(!notes.includes('## [1.0.1]'));
});

test('the last section drops the link-reference definitions at the bottom of the file', () => {
  assert.equal(releaseNotes(CHANGELOG, '1.0.0', REPO), 'Phase 1, "Hands on the panel": the shell.\n');
});

test('a missing or empty section is an error', () => {
  assert.throws(() => releaseNotes(CHANGELOG, '9.9.9', REPO), /no "## \[9\.9\.9\]" section/);
  assert.throws(() => releaseNotes('## [2.0.0] - x\n\n[2.0.0]: https://a\n', '2.0.0', REPO), /is empty/);
  // A prefix of another version is not a match.
  assert.throws(() => releaseNotes(CHANGELOG, '1.0', REPO));
  const huge = `## [3.0.0] - x\n\n${'- line\n'.repeat(MAX_BODY / 7 + 1)}`;
  assert.throws(() => releaseNotes(huge, '3.0.0', REPO), /GitHub's limit/);
});

test('the title names the phase when the section opens with one', () => {
  assert.equal(releaseTitle(CHANGELOG, '1.1.0'), 'v1.1.0 — Phase 2: First light');
  assert.equal(releaseTitle(CHANGELOG, '1.0.0'), 'v1.0.0 — Phase 1: Hands on the panel');
  assert.equal(releaseTitle(CHANGELOG, '1.0.1'), 'v1.0.1');
});

test('versions and repository urls are normalised', () => {
  assert.equal(normaliseVersion('v0.3.0'), '0.3.0');
  assert.equal(normaliseVersion('1.2.3-rc.1'), '1.2.3-rc.1');
  assert.throws(() => normaliseVersion('main'));
  assert.equal(repoUrlOf({ repository: { url: 'git+https://github.com/o/r.git' } }), REPO);
  assert.equal(repoUrlOf({ repository: 'https://github.com/o/r' }), REPO);
  assert.throws(() => repoUrlOf({}));
});

test("the repo's CHANGELOG yields notes and a title for every released version", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1]);
  if (pkg.version !== '0.0.0') assert.ok(versions.includes(pkg.version), `no section for ${pkg.version}`);
  for (const version of versions) {
    const notes = releaseNotes(changelog, version, repoUrlOf(pkg));
    assert.ok(!/^\[[^\]]+\]:\s/m.test(notes), `${version}: link definitions leaked into the notes`);
    assert.ok(!/\]\((?:docs|apps|libs|plans)\//.test(notes), `${version}: a repo-relative link survived`);
    assert.match(
      releaseTitle(changelog, version),
      new RegExp(`^v${version.replace(/\./g, '\\.')}( — Phase \\d+: .+)?$`),
    );
  }
  // Every phase minor so far names its phase (the titles v0.1.0–v0.3.0 were given by hand).
  assert.equal(releaseTitle(changelog, '0.1.0'), 'v0.1.0 — Phase 0: Hello, panel');
  assert.equal(releaseTitle(changelog, '0.3.0'), 'v0.3.0 — Phase 2: First light');
});
