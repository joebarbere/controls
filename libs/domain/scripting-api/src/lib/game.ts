import type {
  CommandBus,
  CommandRegistry,
  ContextKeys,
  ExecError,
  ExecResult,
  ExecutedEvent,
  ReplayError,
} from '@controls/commands';
import {
  createManifest,
  createWorld,
  type CtrlContents,
  type CtrlError,
  type LoadError,
  type Manifest,
  migrateReplayLog,
  readCtrl,
  type ReadCtrlOptions,
  type ReplayEntry,
  type ReplayLog,
  type ValidationIssue,
  World as WorldSchema,
  writeCtrl,
} from '@controls/save-format';
import {
  createWorldBus,
  createWorldRegistry,
  replayLog as replayWorldLog,
  toReplayLog,
  type World,
  worldHash,
} from '@controls/world-model';

/*
 * The scripting API v0 (plan §4.6 surface 4, F1.6): a typed facade over one world command bus. The
 * Angular `Session` (feature-session), `sim-cli` and scenario tests all drive a `Game`, so the UI and
 * scripts run identical code. Every change goes through `exec` and the one registry; nothing here
 * mutates a world.
 */

/** A deeply read-only view of a value: what {@link Game.world} returns (it is also frozen at run time). */
export type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

interface CommonOptions {
  /**
   * The registry to run against. Defaults to `createWorldRegistry()` (world, edit and view commands).
   * A host that registers extra commands passes its own; it must still hold every command its logs use.
   */
  readonly registry?: CommandRegistry<World>;
}

/**
 * `createGame({ seed })` starts from an empty world with that seed; `createGame({ world })` starts
 * from a given (valid, current-version) world. If both are given, `seed` must equal `world.seed`.
 */
export type GameOptions =
  | (CommonOptions & { readonly seed: number; readonly world?: undefined })
  | (CommonOptions & { readonly world: World; readonly seed?: number });

/** Events a script can subscribe to with {@link Game.on}. More arrive with the sim (P2) and PLCs (P10). */
export interface GameEvents {
  /** After every successful command, once the world and the log are updated (view commands included). */
  readonly executed: ExecutedEvent<World>;
}
export type GameEventName = keyof GameEvents;

/** Options for {@link Game.save}. */
export interface SaveGameOptions {
  /** PNG bytes for `thumbnail.png` (the renderer's capture), or `null` for none. */
  readonly thumbnail?: Uint8Array | null;
}

/** Thrown by {@link createGame} for options that can't start a game. Never echoes the input. */
export class GameOptionsError extends Error {
  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'GameOptionsError';
  }
}

/** Thrown by {@link Game.execOrThrow} when a command fails. `error` is the typed `ExecError`. */
export class CommandFailedError extends Error {
  constructor(readonly error: ExecError) {
    super(error.message);
    this.name = 'CommandFailedError';
  }
}

/**
 * Thrown by the reserved sim queries ({@link Game.probe}, {@link Game.tag}) until the phase that
 * implements them. `code` is always `not-available`.
 */
export class NotAvailableError extends Error {
  readonly code = 'not-available';
  constructor(
    readonly query: string,
    readonly phase: string,
  ) {
    super(`game.${query}() is reserved and not available until ${phase}`);
    this.name = 'NotAvailableError';
  }
}

/** The scripting API's view of one running game. */
export interface Game {
  /** The registry behind every surface. Read it for ids, titles, `args` schemas and `when`. */
  readonly registry: CommandRegistry<World>;
  /**
   * Runs a command through the one registry. Invalid args, unknown ids and refusals return a typed
   * error and change nothing; only successful commands reach the replay log.
   */
  exec(id: string, args?: unknown): ExecResult;
  /**
   * {@link exec}, but throws {@link CommandFailedError} on failure and returns the logged entry, or
   * `null` for a command that isn't logged (`logged: false`, UI chrome such as `palette.open`).
   */
  execOrThrow(id: string, args?: unknown): ReplayEntry | null;
  /** The current world document: a frozen snapshot that later commands never change. */
  world(): DeepReadonly<World>;
  /** `world.hash` of the current world (SHA-256 of its canonical JSON, ADR 0007). */
  hash(): string;
  /** The replay entries logged so far. */
  entries(): readonly ReplayEntry[];
  /** The replay log of this game: its initial world plus every entry (`replay.log` in a save). */
  replayLog(): ReplayLog;
  /**
   * The game as a `.ctrl` save (F1.8b): a manifest for this build, the current world, the replay
   * log and an optional thumbnail. Deterministic: the same game gives the same bytes. Load it with
   * {@link loadGame}. Throws `CtrlWriteError` if the save would be over a size cap or the thumbnail
   * isn't a PNG.
   */
  save(options?: SaveGameOptions): Uint8Array;
  canUndo(): boolean;
  canRedo(): boolean;
  /** The context keys the game owns (`history.canUndo`, `history.canRedo`). */
  contextKeys(): { 'history.canUndo': boolean; 'history.canRedo': boolean };
  /** Whether `when` holds for command `id` given extra UI context keys. Advisory, like `when` itself. */
  isEnabled(id: string, context?: ContextKeys): boolean;
  /** Subscribes to an event. Returns an unsubscribe function. */
  on<E extends GameEventName>(event: E, listener: (event: GameEvents[E]) => void): () => void;
  /**
   * **Reserved (P2), not implemented.** Will measure between two points of the as-built circuit, like
   * a meter's probes (`game.probe('X1:3', 'X1:4')`). Throws {@link NotAvailableError} until then.
   */
  probe(from: string, to: string): never;
  /**
   * **Reserved (P10), not implemented.** Will read a PLC tag (`game.tag('PLC1:Motor.Run')`). Throws
   * {@link NotAvailableError} until then.
   */
  tag(path: string): never;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Wraps an existing world bus. The bus must not be driven from anywhere else afterwards. */
function wrap(bus: CommandBus<World>, initialWorld: World): Game {
  deepFreeze(initialWorld);
  deepFreeze(bus.state);
  const listeners = new Set<(event: ExecutedEvent<World>) => void>();
  bus.subscribe((event) => {
    deepFreeze(event.state);
    for (const listener of [...listeners]) listener(event);
  });
  let hashed: { world: World; hash: string } | null = null;

  const game: Game = {
    registry: bus.registry,
    exec: (id, args = {}) => bus.exec(id, args),
    execOrThrow(id, args = {}) {
      const result = bus.exec(id, args);
      if (!result.ok) throw new CommandFailedError(result.error);
      return result.entry;
    },
    world: () => bus.state,
    hash() {
      if (hashed?.world !== bus.state) hashed = { world: bus.state, hash: worldHash(bus.state) };
      return hashed.hash;
    },
    entries: () => bus.entries,
    replayLog: () => toReplayLog(initialWorld, bus),
    save: (options = {}) =>
      writeCtrl({
        manifest: createManifest(),
        world: bus.state,
        replayLog: toReplayLog(initialWorld, bus),
        thumbnail: options.thumbnail ?? null,
      }),
    canUndo: () => bus.canUndo,
    canRedo: () => bus.canRedo,
    contextKeys: () => bus.contextKeys(),
    isEnabled: (id, context = {}) => bus.registry.isEnabled(id, { ...context, ...bus.contextKeys() }),
    on(event, listener) {
      if (event !== 'executed') throw new TypeError(`Unknown game event "${String(event)}"`);
      const typed = listener as (event: ExecutedEvent<World>) => void;
      listeners.add(typed);
      return () => {
        listeners.delete(typed);
      };
    },
    probe() {
      throw new NotAvailableError('probe', 'P2');
    },
    tag() {
      throw new NotAvailableError('tag', 'P10');
    },
  };
  return Object.freeze(game);
}

/**
 * Starts a game: an empty world from `seed`, or the given `world`, with a fresh history and an
 * empty replay log. The world is validated (and frozen; treat it as owned by the game). Throws
 * {@link GameOptionsError} for an invalid world, an out-of-range seed or a seed that contradicts
 * the world's.
 */
export function createGame(options: GameOptions): Game {
  let world: World;
  if (options.world !== undefined) {
    const checked = WorldSchema.safeParse(options.world);
    if (!checked.success) {
      throw new GameOptionsError(
        'The world is not a valid current-version world document',
        checked.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
    if (options.seed !== undefined && options.seed !== options.world.seed) {
      throw new GameOptionsError(`seed ${options.seed} contradicts the world's seed ${options.world.seed}`);
    }
    world = options.world;
  } else {
    const seed = options.seed;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new GameOptionsError('seed must be an unsigned 32-bit integer');
    }
    world = createWorld({ seed });
  }
  return wrap(createWorldBus(world, options.registry ?? createWorldRegistry()), world);
}

export type ReplayGameError =
  | { readonly kind: 'load'; readonly message: string; readonly error: LoadError }
  | { readonly kind: 'replay'; readonly message: string; readonly error: ReplayError };

export type ReplayGameResult =
  { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly error: ReplayGameError };

/**
 * Loads a replay log from untrusted JSON (already `JSON.parse`d; validated and migrated through
 * `@controls/save-format`) and replays it from its initial world. The returned game is at the end
 * of the log, with the history the log rebuilt, and continues the same log. Never throws.
 */
export function replayGame(input: unknown, options: CommonOptions = {}): ReplayGameResult {
  const loaded = migrateReplayLog(input);
  if (!loaded.ok) return { ok: false, error: { kind: 'load', message: loaded.error.message, error: loaded.error } };
  return replayLogGame(loaded.value, options);
}

/** {@link replayGame} for an already validated, current-version replay log. */
export function replayLogGame(log: ReplayLog, options: CommonOptions = {}): ReplayGameResult {
  const replayed = replayWorldLog(log, options.registry ?? createWorldRegistry());
  if (!replayed.ok) {
    return { ok: false, error: { kind: 'replay', message: replayed.error.message, error: replayed.error } };
  }
  return { ok: true, game: wrap(replayed.bus, log.initialWorld) };
}

/**
 * What happened to a save's `replay.log` when it was loaded. The world (`world.json`) is always
 * what loads; the log is kept only if replaying it from its initial world reproduces that world's
 * `world.hash` exactly (ADR 0007), because continuing a log that doesn't would make every later
 * replay of this session wrong.
 */
export type SaveReplayStatus =
  /** Replayed to `world.json`'s hash: the game continues the same log. */
  | { readonly status: 'continued' }
  /** The save has no `replay.log`: a new log starts from the loaded world. */
  | { readonly status: 'absent' }
  /**
   * The log failed to replay, or replayed to a different hash: it was dropped and a new log starts
   * from the loaded world. The UI should say so; `message` names the first failing entry, if any.
   */
  | { readonly status: 'restarted'; readonly reason: 'replay-failed' | 'hash-mismatch'; readonly message: string };

export interface LoadedGame {
  readonly ok: true;
  /** The loaded game: the saved world, an empty undo/redo history, and the log (see `replay`). */
  readonly game: Game;
  readonly manifest: Manifest;
  readonly thumbnail: Uint8Array | null;
  /** The `schemaVersion` the save was written at, before migration. */
  readonly fromVersion: number;
  readonly replay: SaveReplayStatus;
}

export type LoadGameResult = LoadedGame | { readonly ok: false; readonly error: CtrlError };

export type LoadGameOptions = CommonOptions & ReadCtrlOptions;

/**
 * Loads a `.ctrl` save from untrusted bytes (F1.8b). `readCtrl` reads, migrates and validates it
 * (otherwise a typed `CtrlError`, including `newer-than-build`); then a game is built on its world.
 * **The undo stack is cleared and the replay log continues:** the log is replayed from its initial
 * world and, if it reproduces the saved world's hash, the game continues it (same `seq` numbering,
 * so seeded streams stay put); otherwise a new log starts (see {@link SaveReplayStatus}). Never
 * throws. The host replaces its session with the returned game.
 */
export function loadGame(bytes: Uint8Array, options: LoadGameOptions = {}): LoadGameResult {
  const read = readCtrl(bytes, { limits: options.limits ?? {} });
  if (!read.ok) return { ok: false, error: read.error };
  return gameFromSave(read.value, options);
}

/** {@link loadGame} for contents already read with `readCtrl`. Never throws. */
export function gameFromSave(contents: CtrlContents, options: CommonOptions = {}): LoadedGame {
  const registry = options.registry ?? createWorldRegistry();
  const { world, replayLog: log } = contents;
  let game: Game;
  let replay: SaveReplayStatus;
  const replayed = log === null ? null : replayWorldLog(log, registry);
  if (log !== null && replayed?.ok && replayed.hash === worldHash(world)) {
    replayed.bus.clearHistory();
    game = wrap(replayed.bus, log.initialWorld);
    replay = { status: 'continued' };
  } else {
    game = wrap(createWorldBus(world, registry), world);
    if (replayed === null) {
      replay = { status: 'absent' };
    } else if (replayed.ok) {
      replay = {
        status: 'restarted',
        reason: 'hash-mismatch',
        message: "The save's replay log doesn't reproduce its world, so a new log starts from the loaded world.",
      };
    } else {
      replay = { status: 'restarted', reason: 'replay-failed', message: replayed.error.message };
    }
  }
  return {
    ok: true,
    game,
    manifest: contents.manifest,
    thumbnail: contents.thumbnail,
    fromVersion: contents.fromVersion,
    replay,
  };
}
