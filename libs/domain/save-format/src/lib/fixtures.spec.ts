import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  CURRENT_SETTINGS_VERSION,
  Manifest,
  manifestMigrator,
  ReplayLog,
  replayLogMigrator,
  Settings,
  settingsMigrator,
  World,
  worldMigrator,
} from './documents';
import { readCtrl, writeCtrl } from './container/ctrl';
import type { Migrator } from './migrate';
import type { z } from 'zod';

/*
 * Every fixture of every version must load forever (ADR 0004). Layout:
 *   fixtures/v<schemaVersion>/<kind>/*.json      kind = world | manifest | replay-log
 *   fixtures/v<schemaVersion>/ctrl/*.ctrl        whole .ctrl containers (F1.8b)
 *   fixtures/v<schemaVersion>/refused/<kind>/    documents the loaders must refuse (v2 on)
 *   fixtures/v<schemaVersion>/start-failed/<kind>/ valid documents the sim engine refuses at start (v2 on)
 *   fixtures/settings/v<settingsVersion>/*.json
 * Fixtures of a published version are never edited; a new version adds a new directory.
 */

const fixturesRoot = join(import.meta.dirname, '../../fixtures');

interface Kind {
  dir: (version: number) => string;
  migrator: Migrator<unknown>;
  current: z.ZodType;
  currentVersion: number;
}

const kinds: Record<string, Kind> = {
  world: { dir: (v) => `v${v}/world`, migrator: worldMigrator, current: World, currentVersion: CURRENT_SCHEMA_VERSION },
  manifest: {
    dir: (v) => `v${v}/manifest`,
    migrator: manifestMigrator,
    current: Manifest,
    currentVersion: CURRENT_SCHEMA_VERSION,
  },
  'replay-log': {
    dir: (v) => `v${v}/replay-log`,
    migrator: replayLogMigrator,
    current: ReplayLog,
    currentVersion: CURRENT_SCHEMA_VERSION,
  },
  settings: {
    dir: (v) => `settings/v${v}`,
    migrator: settingsMigrator,
    current: Settings,
    currentVersion: CURRENT_SETTINGS_VERSION,
  },
};

function versionDirs(): number[] {
  return readdirSync(fixturesRoot)
    .map((name) => /^v(\d+)$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function settingsVersionDirs(): number[] {
  return readdirSync(join(fixturesRoot, 'settings'))
    .map((name) => /^v(\d+)$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function fixturesOf(kind: Kind, version: number): { file: string; json: unknown }[] {
  const dir = join(fixturesRoot, kind.dir(version));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ file: `${kind.dir(version)}/${name}`, json: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

const cases = Object.entries(kinds).flatMap(([name, kind]) => {
  const versions = name === 'settings' ? settingsVersionDirs() : versionDirs();
  return versions.flatMap((version) => fixturesOf(kind, version).map((f) => ({ name, kind, version, ...f })));
});

/** `.ctrl` containers: `fixtures/v<N>/ctrl/*.ctrl`. Binary and frozen like the JSON fixtures. */
function ctrlFixturesOf(version: number): { file: string; bytes: Uint8Array }[] {
  const dir = join(fixturesRoot, `v${version}/ctrl`);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ctrl'))
    .sort()
    .map((name) => ({ file: `v${version}/ctrl/${name}`, bytes: new Uint8Array(readFileSync(join(dir, name))) }));
}

const ctrlCases = versionDirs().flatMap((version) => ctrlFixturesOf(version).map((f) => ({ version, ...f })));

describe('fixtures', () => {
  it('there is a fixture directory for every version up to the current one, and none beyond', () => {
    expect(versionDirs()).toStrictEqual(Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1));
    expect(settingsVersionDirs()).toStrictEqual(Array.from({ length: CURRENT_SETTINGS_VERSION }, (_, i) => i + 1));
  });

  it('every version has at least one fixture of every kind', () => {
    for (const [name, kind] of Object.entries(kinds)) {
      for (let version = 1; version <= kind.currentVersion; version++) {
        expect(fixturesOf(kind, version).length, `${name} v${version}`).toBeGreaterThan(0);
      }
    }
  });

  it.each(cases.map((c) => [c.file, c] as const))('%s migrates to the current version and validates', (_file, c) => {
    const versionKey = c.kind.migrator.versionKey;
    expect((c.json as Record<string, unknown>)[versionKey], 'fixture is in the wrong version directory').toBe(
      c.version,
    );

    const result = c.kind.migrator.migrate(c.json);
    if (!result.ok) throw new Error(`${c.file}: ${JSON.stringify(result.error)}`);
    expect(result.fromVersion).toBe(c.version);
    expect((result.value as Record<string, unknown>)[versionKey]).toBe(c.kind.currentVersion);
    expect(c.kind.current.parse(result.value)).toStrictEqual(result.value);

    // Lossless: the loaded document survives a JSON round trip unchanged.
    expect(c.kind.migrator.migrate(JSON.parse(JSON.stringify(result.value)))).toStrictEqual({
      ok: true,
      value: result.value,
      fromVersion: c.kind.currentVersion,
    });
  });

  it('every version has at least one .ctrl container fixture', () => {
    for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version++) {
      expect(ctrlFixturesOf(version).length, `ctrl v${version}`).toBeGreaterThan(0);
    }
  });

  it.each(ctrlCases.map((c) => [c.file, c] as const))('%s reads, migrates and validates', (_file, c) => {
    const result = readCtrl(c.bytes);
    if (!result.ok) throw new Error(`${c.file}: ${JSON.stringify(result.error)}`);
    expect(result.value.fromVersion).toBe(c.version);
    expect(result.value.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(World.parse(result.value.world)).toStrictEqual(result.value.world);
    // Lossless: re-writing what was read reads back to the same contents.
    const rewritten = readCtrl(writeCtrl(result.value));
    expect(rewritten.ok && rewritten.value).toStrictEqual({ ...result.value, fromVersion: CURRENT_SCHEMA_VERSION });
  });

  it('a fixture at the current version loads unchanged (fixtures are canonical)', () => {
    for (const c of cases.filter((x) => x.version === x.kind.currentVersion)) {
      const result = c.kind.migrator.migrate(c.json);
      expect(result.ok && result.value, c.file).toStrictEqual(c.json);
    }
  });
});

describe('v2 fixtures that must not load as they are', () => {
  const read = (path: string): unknown => JSON.parse(readFileSync(join(fixturesRoot, path), 'utf8'));

  it('refused/replay-log/end-tick-below-last-entry.json: an endTick before the last entry is refused', () => {
    const result = replayLogMigrator.migrate(read('v2/refused/replay-log/end-tick-below-last-entry.json'));
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid',
        version: 2,
        issues: [{ path: 'endTick', message: 'endTick must not be before the last entry (or the initial world)' }],
      },
    });
  });

  it('start-failed/world/solution-length-mismatch.json: valid schema; the engine refuses it at start (F2.3a)', () => {
    // The schema can't know the netlist: lengths are checked against it when the engine starts, as
    // `start-failed` (ADR 0011 §9.6). F2.3a's start check must refuse this fixture.
    const result = worldMigrator.migrate(read('v2/start-failed/world/solution-length-mismatch.json'));
    expect(result.ok && result.value.sim?.nodes).toHaveLength(6);
  });
});
