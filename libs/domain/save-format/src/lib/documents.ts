import { APP_VERSION } from '@controls/units';
import { type LoadError, type LoadResult, migrationChain } from './migrate';
import type { Difficulty, RegionId } from './primitives';
import { SettingsV1 } from './settings/v1';
import { defaultSettingsV2, SettingsV2, settingsV1ToV2 } from './settings/v2';
import { CTRL_FORMAT, ManifestV1 } from './v1/manifest';
import { ReplayLogV1 } from './v1/replay-log';
import { WorldV1 } from './v1/world';
import { manifestV1ToV2, replayLogV1ToV2, worldV1ToV2 } from './v2/from-v1';
import { ManifestV2 } from './v2/manifest';
import { ReplayEntryV2, ReplayLogV2 } from './v2/replay-log';
import { WorldV2 } from './v2/world';

/*
 * The current version of each document, and the migration chains that reach it. When a version is
 * added: freeze the old file, add `vN/…`, append `.then(VN, (previous) => …)` to each chain, point the
 * aliases below at the new schema and bump the constants. See docs/caveats/save-format.md.
 */

/** The save format's `schemaVersion` (shared by `manifest.json`, `world.json` and `replay.log`). */
export const CURRENT_SCHEMA_VERSION = 2;

/** The settings document's `settingsVersion` (independent of `schemaVersion`). */
export const CURRENT_SETTINGS_VERSION = 2;

/** The current world document schema. `world-model` infers its types from this. */
export const World = WorldV2;
export type World = WorldV2;
export const Manifest = ManifestV2;
export type Manifest = ManifestV2;
export const ReplayLog = ReplayLogV2;
export type ReplayLog = ReplayLogV2;
/** One replay-log entry at the current version. `@controls/commands` validates every logged entry with it. */
export const ReplayEntry = ReplayEntryV2;
export type ReplayEntry = ReplayEntryV2;
export const Settings = SettingsV2;
export type Settings = SettingsV2;

export const worldMigrator = migrationChain('world document', 'schemaVersion', WorldV1)
  .then(WorldV2, worldV1ToV2)
  .build();
export const manifestMigrator = migrationChain('save manifest', 'schemaVersion', ManifestV1)
  .then(ManifestV2, manifestV1ToV2)
  .build();
export const replayLogMigrator = migrationChain('replay log', 'schemaVersion', ReplayLogV1)
  .then(ReplayLogV2, replayLogV1ToV2)
  .build();
export const settingsMigrator = migrationChain('settings', 'settingsVersion', SettingsV1)
  .then(SettingsV2, settingsV1ToV2)
  .build();

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
  return defaultSettingsV2();
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
 * An empty world (no fixtures, entities or connections, never solved) at the current schema version.
 * Validated, so an out-of-range seed throws. A level such as the workshop is a world document with
 * fixtures.
 */
export function createWorld(options: NewWorldOptions): World {
  return World.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seed: options.seed,
    tick: 0,
    nextEntityId: 1,
    nextConnectionId: 1,
    regionId: options.regionId ?? 'nec',
    difficulty: options.difficulty ?? 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [],
    connections: [],
    sim: null,
    extensions: {},
  });
}

export interface NewManifestOptions {
  /** `CATALOG_VERSION` of the catalogue the save's refs resolve against (`@controls/catalog`). */
  readonly catalogVersion: number;
  /** `SIM_ENGINE_VERSION` of the engine that produced the save's sim state (`@controls/sim-core`, decision D8). */
  readonly simEngineVersion: number;
}

/**
 * A manifest for a save written by this build. The caller passes the catalogue and engine versions:
 * this lib depends on neither (the catalogue and the engine depend on it).
 */
export function createManifest(options: NewManifestOptions): Manifest {
  return Manifest.parse({
    format: CTRL_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    catalogVersion: options.catalogVersion,
    simEngineVersion: options.simEngineVersion,
    extensions: {},
  });
}

export interface NewReplayLogOptions {
  /** The `seq` of the first entry (default 0; a rebased or restarted log keeps its numbering). */
  readonly firstSeq?: number;
  /** The tick the log runs to (default: the last entry's tick, or the initial world's). */
  readonly endTick?: number;
}

/**
 * A replay log starting from `initialWorld`, empty unless `entries` are given. Validated, so bad
 * entries, a `firstSeq` that doesn't match them, or an `endTick` before the last entry throw.
 */
export function createReplayLog(
  initialWorld: World,
  entries: readonly ReplayEntry[] = [],
  options: NewReplayLogOptions = {},
): ReplayLog {
  return ReplayLog.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    initialWorld,
    firstSeq: options.firstSeq ?? 0,
    entries,
    endTick: options.endTick ?? entries.at(-1)?.tick ?? initialWorld.tick,
  });
}
