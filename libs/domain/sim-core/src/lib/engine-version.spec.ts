import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIM_ENGINE_VERSION } from './engine-version';

const root = join(import.meta.dirname, '../../../../..');
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('sim-core', () => {
  it('SIM_ENGINE_VERSION is a positive integer (0 is reserved for saves written before the engine)', () => {
    expect(Number.isSafeInteger(SIM_ENGINE_VERSION) && SIM_ENGINE_VERSION >= 1).toBe(true);
  });

  it('is reachable through its path alias and tagged type:domain', () => {
    const { paths } = readJson('tsconfig.base.json').compilerOptions;
    expect(paths['@controls/sim-core']).toEqual(['./libs/domain/sim-core/src/index.ts']);
    expect(readJson('libs/domain/sim-core/project.json').tags).toContain('type:domain');
  });
});
