import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('is a SemVer string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('matches the root package.json (run `pnpm version:sync` if this fails)', () => {
    const root = join(import.meta.dirname, '../../../../..');
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(APP_VERSION).toBe(version);
  });
});
