import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION, migrateWorld, World } from './documents';

/*
 * Level documents (`content/levels/*.json`, F1.9) are world documents. They load through the same
 * migrate/validate path as a save, and like current-version fixtures they must be canonical: what is
 * on disk is exactly what the loader returns, and it survives a JSON round trip.
 */

const levelsDir = join(import.meta.dirname, '../../../../../content/levels');
const levels = readdirSync(levelsDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, json: JSON.parse(readFileSync(join(levelsDir, name), 'utf8')) as unknown }));

describe('content/levels', () => {
  it('has the workshop', () => {
    expect(levels.map((l) => l.name)).toContain('workshop.json');
  });

  it.each(levels.map((l) => [l.name, l.json] as const))('%s is a canonical, lossless world document', (_name, json) => {
    const result = migrateWorld(json);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.value).toStrictEqual(json); // canonical: loading changes nothing
    expect(World.parse(JSON.parse(JSON.stringify(result.value)))).toStrictEqual(result.value);
    // A level starts a fresh game: no ticks run, nothing assisted.
    expect(result.value.tick).toBe(0);
    expect(result.value.assisted).toBe(false);
    expect(result.value.fixtures.length).toBeGreaterThan(0);
  });
});
