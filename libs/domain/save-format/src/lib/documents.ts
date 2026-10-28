import { APP_VERSION } from '@controls/units';
import { type LoadError, type LoadResult, migrationChain } from './migrate';
import type { Difficulty, RegionId } from './primitives';
import { defaultSettingsV1, SettingsV1 } from './settings/v1';
import { CTRL_FORMAT, ManifestV1 } from './v1/manifest';
import { ReplayEntryV1, ReplayLogV1 } from './v1/replay-log';
import { WorldV1 } from './v1/world';

/*
 * The current version of each document, and the migration chains that reach it. When a version is
 * added: freeze the old file, add `vN/…`, append `.then(VN, (previous) => …)` to each chain, point the
 * aliases below at the new schema and bump the constants. See docs/caveats/save-format.md.
 */

/** The save format's `schemaVersion` (shared by `manifest.json`, `world.json` and `replay.log`). */
export const CURRENT_SCHEMA_VERSION = 1;

/** The settings document's `settingsVersion` (independent of `schemaVersion`). */
export const CURRENT_SETTINGS_VERSION = 1;

/** The current world document schema. `world-model` infers its types from this. */
export const World = WorldV1;
export type World = WorldV1;
export const Manifest = ManifestV1;
export type Manifest = ManifestV1;
export const ReplayLog = ReplayLogV1;
export type ReplayLog = ReplayLogV1;
/** One replay-log entry at the current version. `@controls/commands` validates every logged entry with it. */
export const ReplayEntry = ReplayEntryV1;
export type ReplayEntry = ReplayEntryV1;
export const Settings = SettingsV1;
export type Settings = SettingsV1;

export const worldMigrator = migrationChain('world document', 'schemaVersion', WorldV1).build();
export const manifestMigrator = migrationChain('save manifest', 'schemaVersion', ManifestV1).build();
export const replayLogMigrator = migrationChain('replay log', 'schemaVersion', ReplayLogV1).build();
export const settingsMigrator = migrationChain('settings', 'settingsVersion', SettingsV1).build();

/** Validates and migrates untrusted world JSON (already `JSON.parse`d) to the current schema. */
export function migrateWorld(input: unknown): LoadResult<World> {
  return worldMigrator.migrate(input);
}

export function migrateManifest(input: unknown): LoadResult<Manifest> {
  return manifestMigrator.migrate(input);
}

export function migrateReplayLog(input: unknown): LoadResult<ReplayLog> {
  return replayLogMigrator.migrate(input);
}

export function migrateSettings(input: unknown): LoadResult<Settings> {
  return settingsMigrator.migrate(input);
}

/** Fresh default settings for the current `settingsVersion`. */
export function defaultSettings(): Settings {
  return defaultSettingsV1();
}

/**
 * Loads a settings document, falling back to {@link defaultSettings} when it is missing, corrupt or
 * from a newer build (plan F1.1). `error` is non-null when the fallback was taken, so the UI can notify.
 */
export function loadSettings(input: unknown): { settings: Settings; error: LoadError | null } {
  const result = migrateSettings(input);
  return result.ok ? { settings: result.value, error: null } : { settings: defaultSettings(), error: result.error };
}

export interface NewWorldOptions {
  /** Unsigned 32-bit seed (the new-game dialog's value, or one drawn by the shell). */
  seed: number;
  difficulty?: Difficulty;
  regionId?: RegionId;
}

/**
 * An empty world (no fixtures, no entities) at the current schema version. Validated, so an
 * out-of-range seed throws. A level such as the workshop is a world document with fixtures.
 */
export function createWorld(options: NewWorldOptions): World {
  return World.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed: options.seed,
    tick: 0,
    nextEntityId: 1,
    regionId: options.regionId ?? 'nec',
    difficulty: options.difficulty ?? 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [],
    extensions: {},
  });
}

/** A manifest for a save written by this build. `catalogVersion` is 0 until the catalogue exists. */
export function createManifest(options: { catalogVersion?: number } = {}): Manifest {
  return Manifest.parse({
    format: CTRL_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    catalogVersion: options.catalogVersion ?? 0,
    extensions: {},
  });
}

/** A replay log starting from `initialWorld`, empty unless `entries` are given. Validated, so bad entries throw. */
export function createReplayLog(initialWorld: World, entries: readonly ReplayEntry[] = []): ReplayLog {
  return ReplayLog.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, initialWorld, entries });
}
