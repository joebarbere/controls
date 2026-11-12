import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';

/*
 * `content/` (tag `type:content`) is authoritative, but domain code can't import it, so the catalogue
 * bundles generated mirrors of its data directories (plan P2 decision D4). One test per mirror fails
 * when it is stale: regenerate with `pnpm nx test catalog -u` and commit both (in CI a missing file
 * fails too). A mirror is a pure function of its directory: the `*.json` files, sorted by name, as an
 * array of documents. What the documents mean (their schema, their loader) is the catalogue's business,
 * not this test's.
 *
 * Adding a mirrored directory (catalogue v2 adds `content/tables/` and `content/tools/`, P3) is one row
 * in MIRRORS, then `pnpm nx test catalog -u`, then the generated file's path in `.prettierignore`.
 * A new `content/` directory with no row here, mirrored or not, fails the coverage test below.
 */

interface ContentMirror {
  /** The directory under `content/`. */
  readonly dir: string;
  /** The generated module, in this directory. */
  readonly generated: string;
  /** Its one export. */
  readonly exportName: string;
  /** That export, imported: it must equal the files as parsed. */
  readonly documents: readonly unknown[];
}

const MIRRORS: readonly ContentMirror[] = [
  {
    dir: 'devices',
    generated: 'builtin-devices.generated.ts',
    exportName: 'BUILTIN_DEVICE_DOCUMENTS',
    documents: BUILTIN_DEVICE_DOCUMENTS,
  },
];

/** `content/` directories that are not mirrored, and why. */
const UNMIRRORED: Readonly<Record<string, string>> = {
  levels: 'apps bundle `@controls/content/levels/*.json` and sim-cli reads the files; no domain lib reads them (F1.9)',
};

const workspaceRoot = join(import.meta.dirname, '../../../../..');
const contentDir = join(workspaceRoot, 'content');

/** The sorted `*.json` files directly in `content/<dir>`, parsed. */
function readDocuments(dir: string): unknown[] {
  return readdirSync(join(contentDir, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(contentDir, dir, name), 'utf8')) as unknown);
}

/** The text of a generated module: a pure function of the sorted files. */
function generatedModule(mirror: ContentMirror): string {
  const body = readDocuments(mirror.dir)
    .map((document) => JSON.stringify(document, null, 2))
    .join(',\n');
  return [
    '/*',
    ` * GENERATED from content/${mirror.dir}/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON`,
    ' * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).',
    ' */',
    `export const ${mirror.exportName}: readonly unknown[] = [`,
    body,
    '];',
    '',
  ].join('\n');
}

describe('the generated mirrors of content/', () => {
  const cases = MIRRORS.map((mirror) => [mirror.dir, mirror] as const);

  it.each(cases)('content/%s is mirrored by an up-to-date generated module', async (_dir, mirror) => {
    await expect(generatedModule(mirror)).toMatchFileSnapshot(join(import.meta.dirname, mirror.generated));
    expect(mirror.documents).toStrictEqual(readDocuments(mirror.dir));
  });

  it.each(cases)('content/%s holds JSON files only, no subdirectory the mirror would skip', (_dir, mirror) => {
    const entries = readdirSync(join(contentDir, mirror.dir), { withFileTypes: true });
    expect(entries.filter((e) => !e.isFile() || !e.name.endsWith('.json')).map((e) => e.name)).toStrictEqual([]);
  });

  it.each(cases)('the mirror of content/%s is in .prettierignore (Prettier would make it stale)', (_dir, mirror) => {
    const ignored = readFileSync(join(workspaceRoot, '.prettierignore'), 'utf8').split(/\r?\n/);
    expect(ignored).toContain(`libs/domain/catalog/src/lib/${mirror.generated}`);
  });

  it('every content/ directory is either mirrored or listed as unmirrored with a reason', () => {
    const dirs = readdirSync(contentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const known = [...MIRRORS.map((m) => m.dir), ...Object.keys(UNMIRRORED)].sort();
    expect(dirs).toStrictEqual(known);
  });
});
