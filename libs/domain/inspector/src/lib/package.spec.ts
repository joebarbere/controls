import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSPECTOR_PACKAGE, INSPECTOR_READS } from './package';

// Placeholder test (P4 kickoff boundary PR): pins the scaffolding the boundary rules rely on. The lint
// probes proving the boundary itself live in apps/sim-cli/src/lint-boundary.spec.ts and
// lint-determinism.spec.ts.
const root = join(import.meta.dirname, '../../../../..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('inspector scaffolding', () => {
  it('is reachable through its path alias', () => {
    const { paths } = readJson('tsconfig.base.json').compilerOptions;
    expect(paths[INSPECTOR_PACKAGE]).toEqual(['./libs/domain/inspector/src/index.ts']);
  });

  it('is tagged type:domain only, so the module boundary rules place it', () => {
    expect(readJson('libs/domain/inspector/project.json').tags).toEqual(['type:domain']);
  });

  it('typechecks without the DOM or ambient Node types (tsconfig.domain.json, not overridden)', () => {
    expect(readJson('libs/domain/inspector/tsconfig.json').extends).toBe('../tsconfig.domain.json');
    const { compilerOptions } = readJson('libs/domain/inspector/tsconfig.lib.json');
    expect(compilerOptions.types).toBeUndefined();
    expect(compilerOptions.lib).toBeUndefined();
  });

  it('reads only type:domain libs', () => {
    const { paths } = readJson('tsconfig.base.json').compilerOptions;
    for (const alias of INSPECTOR_READS) {
      expect(paths[alias]).toEqual([expect.stringMatching(/^\.\/libs\/domain\//)]);
    }
  });
});
