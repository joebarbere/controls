import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM_PROTOCOL_PACKAGE } from './package';

// Placeholder test (P2 kickoff boundary PR): pins the scaffolding the boundary rules rely on.
const root = join(import.meta.dirname, '../../../../..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('sim-protocol scaffolding', () => {
  it('is reachable through its path alias', () => {
    const { paths } = readJson('tsconfig.base.json').compilerOptions;
    expect(paths[SIM_PROTOCOL_PACKAGE]).toEqual(['./libs/domain/sim-protocol/src/index.ts']);
  });

  it('is tagged type:domain so the module boundary rules place it', () => {
    expect(readJson('libs/domain/sim-protocol/project.json').tags).toContain('type:domain');
  });
});
