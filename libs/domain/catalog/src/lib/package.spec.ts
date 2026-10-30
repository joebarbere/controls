import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_PACKAGE } from './package';

// Placeholder test (P2 kickoff boundary PR): pins the scaffolding the boundary rules rely on.
const root = join(import.meta.dirname, '../../../../..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('catalog scaffolding', () => {
  it('is reachable through its path alias', () => {
    const { paths } = readJson('tsconfig.base.json').compilerOptions;
    expect(paths[CATALOG_PACKAGE]).toEqual(['./libs/domain/catalog/src/index.ts']);
  });

  it('is tagged type:domain so the module boundary rules place it', () => {
    expect(readJson('libs/domain/catalog/project.json').tags).toContain('type:domain');
  });
});
