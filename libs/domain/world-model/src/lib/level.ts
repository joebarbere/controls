import { type Difficulty, type LoadError, migrateWorld, type RegionId, World } from '@controls/save-format';

/*
 * Levels (F1.9). A level is a world document (`content/levels/*.json`): fixtures, optionally some
 * starting entities, and default seed, difficulty and region. A new game copies it and replaces the
 * per-game values. Domain code never picks a seed itself (no `Math.random` or `crypto` here): the
 * new-game dialog draws a fresh one, or the player types one.
 */

export interface NewGameOptions {
  /** Unsigned 32-bit world seed. */
  readonly seed: number;
  /** Defaults to the level's own difficulty (settings hold the player's default for new games). */
  readonly difficulty?: Difficulty;
  readonly regionId?: RegionId;
}

export type LevelLoadResult =
  { readonly ok: true; readonly level: World } | { readonly ok: false; readonly error: LoadError };

/** Validates and migrates an untrusted level document (already `JSON.parse`d). Never throws. */
export function loadLevel(json: unknown): LevelLoadResult {
  const result = migrateWorld(json);
  return result.ok ? { ok: true, level: result.value } : { ok: false, error: result.error };
}

/**
 * The initial world of a new game on `level`: the level's fixtures and entities with the game's
 * seed (and difficulty and region, if given), at tick 0 and not assisted. Validated, so an
 * out-of-range seed throws `ZodError`.
 */
export function newGameWorld(level: World, options: NewGameOptions): World {
  return World.parse({
    ...level,
    seed: options.seed,
    tick: 0,
    assisted: false,
    difficulty: options.difficulty ?? level.difficulty,
    regionId: options.regionId ?? level.regionId,
  });
}
