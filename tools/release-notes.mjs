#!/usr/bin/env node
// Draft release notes and title from CHANGELOG.md, for release.yml's `draft` job.
//
//   node tools/release-notes.mjs [version|vX.Y.Z]           → the section's body on stdout
//   node tools/release-notes.mjs [version|vX.Y.Z] --title   → the release title on stdout
//
// The version defaults to the root package.json's. The body is the `## [x.y.z]` section without
// its heading and without link-reference definitions; repo-relative links are made absolute at
// the tag (a release page resolves them against /releases/tag/…, where they 404). The title is
// "vX.Y.Z — Phase N: Name" when the section opens with `Phase N, "Name": …` (each phase's minor
// release), otherwise just "vX.Y.Z" (patches: set the title by hand on the draft if wanted).
// Exits 1 if the section is missing, empty or over GitHub's body limit. Dependency-free; tested by
// release-notes.test.mjs (part of `pnpm verify`).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// `[label]: url` on its own line (Keep a Changelog's compare links at the bottom of the file).
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/;
// `](target)` whose target has no scheme (http:, mailto:, …) and isn't an anchor or root-relative.
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:|#|\/)(?:\.\/)?([^)\s]+)\)/gi;
const PHASE_LINE = /^Phase (\d+), "([^"]+)"/;
/** GitHub rejects a release body over 125,000 characters. */
export const MAX_BODY = 125_000;

/** `v0.3.0` or `0.3.0` → `0.3.0`; throws on anything else. */
export function normaliseVersion(input) {
  const version = String(input).replace(/^v/, '');
  if (!VERSION.test(version)) throw new Error(`not a version: ${JSON.stringify(input)}`);
  return version;
}

/** The lines of the `## [version]` section, heading excluded, up to the next `## ` heading. */
function sectionLines(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The release body for `version`: its CHANGELOG section without the heading or link-reference
 * definitions, with repo-relative links pointing at `<repoUrl>/blob/v<version>/…`.
 */
export function releaseNotes(changelog, version, repoUrl) {
  const body = sectionLines(changelog, version)
    .filter((line) => !LINK_DEFINITION.test(line))
    .join('\n')
    .trim();
  if (body === '') throw new Error(`CHANGELOG.md's "## [${version}]" section is empty`);
  const notes = `${body.replace(RELATIVE_LINK, (_, path) => `](${repoUrl}/blob/v${version}/${path})`)}\n`;
  if (notes.length > MAX_BODY) {
    throw new Error(`notes for ${version} are ${notes.length} characters; GitHub's limit is ${MAX_BODY}`);
  }
  return notes;
}

/** "vX.Y.Z — Phase N: Name" if the section opens with `Phase N, "Name"`, else "vX.Y.Z". */
export function releaseTitle(changelog, version) {
  const first = sectionLines(changelog, version).find((line) => line.trim() !== '') ?? '';
  const phase = PHASE_LINE.exec(first.trim());
  return phase ? `v${version} — Phase ${phase[1]}: ${phase[2]}` : `v${version}`;
}

/** `https://github.com/o/r` from package.json `repository` (string or `{ url }`, `git+…`, `.git`). */
export function repoUrlOf(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) throw new Error('package.json has no repository url');
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--title');
  const positional = args.filter((a) => !a.startsWith('-'));
  try {
    if (unknown.length || positional.length > 1) throw new Error('usage: release-notes.mjs [version] [--title]');
    const pkg = JSON.parse(read('package.json'));
    const version = normaliseVersion(positional[0] ?? pkg.version);
    const changelog = read('CHANGELOG.md');
    process.stdout.write(
      args.includes('--title')
        ? `${releaseTitle(changelog, version)}\n`
        : releaseNotes(changelog, version, repoUrlOf(pkg)),
    );
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exit(1);
  }
}
