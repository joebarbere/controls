import {
  type CommandBus,
  type CommandRegistry,
  type ContextKeys,
  type ExecError,
  type ExecResult,
  type ExecutedEvent,
  type ReplayError,
  SIM_STEP_COMMAND,
} from '@controls/commands';
import { CATALOG_VERSION } from '@controls/catalog';
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
  TerminalId,
  type ValidationIssue,
  World as WorldSchema,
  writeCtrl,
} from '@controls/save-format';
import {
  type ProbeReading,
  SIM_ENGINE_VERSION,
  type SourcedConstant,
  SimEngine,
  type SimEngineOptions,
  type SimIslandInfo,
  SimProbeError,
  SimStartError,
  type SimStartFailure,
} from '@controls/sim-core';
import { materialiseWorld, type SimEvent } from '@controls/sim-protocol';
import {
  checkWorldDevices,
  createWorldBus,
  createWorldRegistry,
  replayLog as replayWorldLog,
  toReplayLog,
  type World,
  worldHash,
} from '@controls/world-model';
import { engineCompatible } from './engine-compat';

/*
 * The scripting API (plan §4.6 surface 4, F1.6; the sim in F2.3a): a typed facade over one world
 * command bus and the sim engine that follows it. The Angular `Session` (feature-session), `sim-cli`
 * and scenario tests all drive a `Game`, so the UI and scripts run identical code. Every change goes
 * through `exec` and the one registry; nothing here mutates a world.
 *
 * **The engine is the game's time host (ADR 0011 §3, §11).** Headless, an in-process `SimEngine`
 * follows the bus: each logged command reaches it at its tick, `advance` moves both, and `sim.step`
 * advances right after it is logged, so the next command is stamped at the new tick. `hash()` and
 * `save()` materialise the engine's sim-owned state into the world (ADR 0011 §1). In the game, F2.3b
 * moves the engine to the sim worker behind a `SimHost`; until then the session runs it in-process.
 */

/** A deeply read-only view of a value: what {@link Game.world} returns (it is also frozen at run time). */
export type DeepReadonly<T> = T extends (infer E)[]
  ? readonly DeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

interface CommonOptions {
  /**
   * The registry to run against. Defaults to `createWorldRegistry()` (world, edit, view and sim time
   * commands). A host that registers extra commands passes its own; it must still hold every command
   * its logs use.
   */
  readonly registry?: CommandRegistry<World>;
  /**
   * The sim engine: its options (default the built-in catalogue and models, which must match the
   * registry's catalogue), or `false` for none. Without an engine time still passes (on the bus), the
   * world's `sim` bags and solution record stay as they started, and the sim queries (`probe`,
   * `snapshot`, `islands`) throw {@link NotAvailableError}: the commanded world only (ADR 0011 §10's
   * cheap replay).
   */
  readonly engine?: SimEngineOptions | false;
}

/**
 * `createGame({ seed })` starts from an empty world with that seed; `createGame({ world })` starts
 * from a given (valid, current-version) world. If both are given, `seed` must equal `world.seed`.
 */
export type GameOptions =
  | (CommonOptions & { readonly seed: number; readonly world?: undefined })
  | (CommonOptions & { readonly world: World; readonly seed?: number });

/** Events a script can subscribe to with {@link Game.on}. More arrive with PLCs (P10). */
export interface GameEvents {
  /**
   * After every successful command (view commands included), once the world, the log and the time
   * host are updated: after a `sim.step`, `state` is the world after the step.
   */
  readonly executed: ExecutedEvent<World>;
  /**
   * A sim event (ADR 0011 §4): a device's (`blown`, `tripped`, …) or an island's (`singular`,
   * `nonConverged`, on the rising edge). Delivered after the `exec` or `advance` that produced it, in
   * order (tick, entity, kind). Deterministic: the same list headless and in a replay.
   */
  readonly sim: SimEvent;
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
 * Thrown by a query that isn't available: one reserved for a later phase ({@link Game.tag}, P10), or
 * a sim query on a game without an engine. `code` is always `not-available`.
 */
export class NotAvailableError extends Error {
  readonly code = 'not-available';
  constructor(
    readonly query: string,
    readonly phase: string,
  ) {
    super(
      phase === 'engine'
        ? `game.${query}() needs the sim engine`
        : `game.${query}() is reserved and not available until ${phase}`,
    );
    this.name = 'NotAvailableError';
  }
}

/** Thrown by {@link Game.probe} for an end that isn't `"<entityId>:<terminalId>"` of a netlisted device. */
export class ProbeError extends Error {
  constructor(
    readonly code: 'invalid-terminal' | 'unknown-terminal',
    readonly end: 'a' | 'b',
  ) {
    super(
      code === 'invalid-terminal'
        ? `Probe end ${end} must be "<entityId>:<terminalId>"`
        : `Probe end ${end} is not a terminal of a netlisted device`,
    );
    this.name = 'ProbeError';
  }
}

/** The scripting API's view of one running game. */
export interface Game {
  /** The registry behind every surface. Read it for ids, titles, `args` schemas and `when`. */
  readonly registry: CommandRegistry<World>;
  /**
   * Runs a command through the one registry. Invalid args, unknown ids and refusals return a typed
   * error and change nothing; only successful commands reach the replay log. `sim.step` also
   * advances time by its ticks once it is logged.
   */
  exec(id: string, args?: unknown): ExecResult;
  /**
   * {@link exec}, but throws {@link CommandFailedError} on failure and returns the logged entry, or
   * `null` for a command that isn't logged (`logged: false`, UI chrome such as `palette.open`).
   */
  execOrThrow(id: string, args?: unknown): ReplayEntry | null;
  /**
   * The current commanded world: a frozen snapshot that later commands never change. Its `sim` bags
   * and `sim` solution record are inert (as the session started): read sim values with
   * {@link probe}, {@link snapshot} and {@link islands}, or the whole materialised world with
   * {@link materialisedWorld}.
   */
  world(): DeepReadonly<World>;
  /** The world as a save writes it and `world.hash` hashes it: the commanded world with the sim state materialised. */
  materialisedWorld(): DeepReadonly<World>;
  /** `world.hash` of the materialised world (SHA-256 of its canonical JSON, ADR 0007, ADR 0013). */
  hash(): string;
  /** The current sim tick (1 tick = 1 ms). */
  tick(): number;
  /**
   * Lets `ticks` of sim time pass (an integer ≥ 0). Time passing is not a command: nothing is logged
   * and undo and redo are untouched (ADR 0011 §3). The next command is stamped at the new tick.
   */
  advance(ticks: number): void;
  /** Lets sim time pass up to `tick` (a safe integer, not before the current tick). */
  advanceTo(tick: number): void;
  /**
   * An **ideal, non-loading** probe between two terminals, `"<entityId>:<terminalId>"` (`'1:pos'`):
   * what an ideal voltmeter would read, red on `a`, black on `b`, without being part of the circuit.
   * A script and test query, not a player instrument (meters are P5). Only a `dc` reading is a reading:
   * terminals on different islands read `floating`, and a singular, non-converged (`unsettled`) or
   * unsolved island is reported as such, never as a number. AC islands are `unsolved` (`acPending`)
   * until F2.2 part 2 adds RMS volts and phase. Throws {@link ProbeError} for an end that names no
   * netlisted terminal, and {@link NotAvailableError} without an engine.
   */
  probe(a: string, b: string): ProbeReading;
  /** The islands of the current netlist and whether each one's values are a reading. */
  islands(): SimIslandInfo[];
  /** The snapshot at this tick: the hashed bytes of its slot (ADR 0011 §5, §11), a fresh copy. */
  snapshot(): Uint8Array;
  /** SHA-256 of {@link snapshot}'s bytes, lower-case hex (`snapshotHash`, ADR 0011 §5.2). */
  snapshotHash(): string;
  /** The replay entries logged so far. */
  entries(): readonly ReplayEntry[];
  /** The replay log of this game: its initial world plus every entry, ending at the current tick. */
  replayLog(): ReplayLog;
  /**
   * The game as a `.ctrl` save (F1.8b): a manifest for this build, the materialised world, the replay
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

/** This build's engine and catalogue versions (what a save it writes records). */
export const BUILD_ENGINE_VERSIONS = Object.freeze({
  simEngineVersion: SIM_ENGINE_VERSION,
  catalogVersion: CATALOG_VERSION,
});

/**
 * A manifest for a save this build writes: its `APP_VERSION`, the built-in catalogue's
 * `CATALOG_VERSION` and the engine's `SIM_ENGINE_VERSION` (what {@link Game.save} writes).
 */
export function createSaveManifest(): Manifest {
  return createManifest(BUILD_ENGINE_VERSIONS);
}

const PROBE_END = /^([1-9][0-9]{0,15}):(.+)$/;

function parseProbeEnd(text: string, end: 'a' | 'b'): { entity: number; terminal: string } {
  const match = typeof text === 'string' ? PROBE_END.exec(text) : null;
  const entity = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isSafeInteger(entity) || !TerminalId.safeParse(match[2]).success) {
    throw new ProbeError('invalid-terminal', end);
  }
  return { entity, terminal: match[2] };
}

/** Starts the engine for `world`, or returns `null` for `engine: false`. Throws `SimStartError`. */
function startEngine(world: World, options: CommonOptions): SimEngine | null {
  return options.engine === false ? null : SimEngine.start(world, options.engine ?? {});
}

/**
 * Wraps an existing world bus and the engine following it (at the bus's tick). Neither may be driven
 * from anywhere else afterwards. Events the engine raised before (a replay's) are dropped.
 */
function wrap(bus: CommandBus<World>, initialWorld: World, engine: SimEngine | null): Game {
  deepFreeze(initialWorld);
  deepFreeze(bus.state);
  const executedListeners = new Set<(event: ExecutedEvent<World>) => void>();
  const simListeners = new Set<(event: SimEvent) => void>();
  // The bus's `executed` event for the command `exec` is running, delivered once the time host has it.
  const pending: { event: ExecutedEvent<World> | null } = { event: null };
  bus.subscribe((event) => {
    pending.event = event;
  });
  const takePending = (): ExecutedEvent<World> | null => {
    const event = pending.event;
    pending.event = null;
    return event;
  };
  let hashed: { world: World; revision: number; hash: string } | null = null;
  let materialised: { world: World; revision: number; result: World } | null = null;

  const needEngine = (query: string): SimEngine => {
    if (engine === null) throw new NotAvailableError(query, 'engine');
    return engine;
  };
  const deliverSimEvents = () => {
    if (engine === null) return;
    for (const event of engine.takeEvents()) for (const listener of [...simListeners]) listener(event);
  };
  const moveTo = (tick: number) => {
    if (!Number.isSafeInteger(tick)) throw new RangeError(`advanceTo needs a safe integer tick, got ${tick}`);
    if (tick < bus.currentTick())
      throw new RangeError(`advanceTo(${tick}) is before the current tick ${bus.currentTick()}`);
    engine?.advanceTo(tick);
    bus.advanceTo(tick);
    deepFreeze(bus.state);
  };
  const revision = () => engine?.revision ?? 0;
  const materialisedWorld = (): World => {
    if (engine === null) return bus.state;
    if (materialised?.world !== bus.state || materialised.revision !== engine.revision) {
      materialised = {
        world: bus.state,
        revision: engine.revision,
        result: deepFreeze(materialiseWorld(bus.state, engine.exportState())),
      };
    }
    return materialised.result;
  };

  const game: Game = {
    registry: bus.registry,
    exec(id, args = {}) {
      takePending();
      const result = bus.exec(id, args);
      const event = takePending();
      if (result.ok && result.logged) {
        engine?.applied(result.entry, bus.state);
        // `sim.step` is carried out by the time host, right after it is logged (ADR 0011 §3, §11).
        if (result.entry.id === SIM_STEP_COMMAND) moveTo(bus.currentTick() + (result.entry.args['ticks'] as number));
      }
      if (event !== null) {
        deepFreeze(bus.state);
        const delivered: ExecutedEvent<World> = { ...event, state: bus.state };
        for (const listener of [...executedListeners]) listener(delivered);
      }
      deliverSimEvents();
      return result;
    },
    execOrThrow(id, args = {}) {
      const result = game.exec(id, args);
      if (!result.ok) throw new CommandFailedError(result.error);
      return result.entry;
    },
    world: () => bus.state,
    materialisedWorld,
    hash() {
      if (hashed?.world !== bus.state || hashed.revision !== revision()) {
        hashed = { world: bus.state, revision: revision(), hash: worldHash(materialisedWorld()) };
      }
      return hashed.hash;
    },
    tick: () => bus.currentTick(),
    advance(ticks) {
      if (!Number.isSafeInteger(ticks) || ticks < 0)
        throw new RangeError(`advance needs a whole number of ticks ≥ 0, got ${ticks}`);
      moveTo(bus.currentTick() + ticks);
      deliverSimEvents();
    },
    advanceTo(tick) {
      moveTo(tick);
      deliverSimEvents();
    },
    probe(a, b) {
      const sim = needEngine('probe');
      try {
        return sim.probe(parseProbeEnd(a, 'a'), parseProbeEnd(b, 'b'));
      } catch (error) {
        if (error instanceof SimProbeError) throw new ProbeError('unknown-terminal', error.end);
        throw error;
      }
    },
    islands: () => needEngine('islands').islands(),
    snapshot: () => needEngine('snapshot').snapshot(),
    snapshotHash: () => needEngine('snapshotHash').snapshotHash(),
    entries: () => bus.entries,
    replayLog: () => toReplayLog(initialWorld, bus),
    save: (options = {}) =>
      writeCtrl({
        manifest: createSaveManifest(),
        world: materialisedWorld(),
        replayLog: toReplayLog(initialWorld, bus),
        thumbnail: options.thumbnail ?? null,
      }),
    canUndo: () => bus.canUndo,
    canRedo: () => bus.canRedo,
    contextKeys: () => bus.contextKeys(),
    isEnabled: (id, context = {}) => bus.registry.isEnabled(id, { ...context, ...bus.contextKeys() }),
    on(event, listener) {
      if (event === 'executed') {
        const typed = listener as (event: ExecutedEvent<World>) => void;
        executedListeners.add(typed);
        return () => {
          executedListeners.delete(typed);
        };
      }
      if (event === 'sim') {
        const typed = listener as (event: SimEvent) => void;
        simListeners.add(typed);
        return () => {
          simListeners.delete(typed);
        };
      }
      throw new TypeError(`Unknown game event "${String(event)}"`);
    },
    tag() {
      throw new NotAvailableError('tag', 'P10');
    },
  };
  return Object.freeze(game);
}

function startFailedIssues(error: SimStartError): ValidationIssue[] {
  return [{ path: 'sim', message: `start-failed: ${error.reason}` }];
}

/**
 * Starts a game: an empty world from `seed`, or the given `world`, with a fresh history and an
 * empty replay log, and the sim engine on it. The world is validated, its device state and
 * connections included (`checkWorldDevices`), and frozen; treat it as owned by the game. Throws
 * {@link GameOptionsError} for an invalid world, an out-of-range seed, a seed that contradicts the
 * world's, or sim state the engine refuses at start (a solution record that doesn't fit the netlist,
 * `start-failed`).
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
    const catalog = options.engine === false ? undefined : options.engine?.catalog;
    const devices = checkWorldDevices(options.world, catalog);
    if (devices.length > 0) {
      throw new GameOptionsError("The world's device state doesn't match the device catalogue", devices);
    }
    world = options.world;
  } else {
    const seed = options.seed;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new GameOptionsError('seed must be an unsigned 32-bit integer');
    }
    world = createWorld({ seed });
  }
  let engine: SimEngine | null;
  try {
    engine = startEngine(world, options);
  } catch (error) {
    if (error instanceof SimStartError) {
      throw new GameOptionsError("The world's sim state doesn't fit its circuit", startFailedIssues(error));
    }
    throw error;
  }
  return wrap(createWorldBus(world, options.registry ?? createWorldRegistry()), world, engine);
}

export type ReplayGameError =
  | { readonly kind: 'load'; readonly message: string; readonly error: LoadError }
  | { readonly kind: 'replay'; readonly message: string; readonly error: ReplayError }
  | { readonly kind: 'start-failed'; readonly message: string; readonly reason: SimStartFailure };

export type ReplayGameResult =
  { readonly ok: true; readonly game: Game } | { readonly ok: false; readonly error: ReplayGameError };

/**
 * Loads a replay log from untrusted JSON (already `JSON.parse`d; validated and migrated through
 * `@controls/save-format`) and replays it from its initial world with the sim engine, advancing to
 * each entry's tick and then to the log's `endTick`. The returned game is at the end of the log, with
 * the history the log rebuilt, and continues the same log. Never throws.
 */
export function replayGame(input: unknown, options: CommonOptions = {}): ReplayGameResult {
  const loaded = migrateReplayLog(input);
  if (!loaded.ok) return { ok: false, error: { kind: 'load', message: loaded.error.message, error: loaded.error } };
  return replayLogGame(loaded.value, options);
}

type Replayed =
  | { readonly ok: true; readonly bus: CommandBus<World>; readonly engine: SimEngine | null; readonly hash: string }
  | { readonly ok: false; readonly error: ReplayGameError };

/** Replays a validated log from its initial world, the engine (if any) as its time host. Never throws. */
function replayWithEngine(log: ReplayLog, options: CommonOptions): Replayed {
  let engine: SimEngine | null;
  try {
    engine = startEngine(log.initialWorld, options);
  } catch (error) {
    if (!(error instanceof SimStartError)) throw error;
    return { ok: false, error: { kind: 'start-failed', message: error.message, reason: error.reason } };
  }
  const replayed = replayWorldLog(log, options.registry ?? createWorldRegistry(), { time: engine ?? undefined });
  if (!replayed.ok)
    return { ok: false, error: { kind: 'replay', message: replayed.error.message, error: replayed.error } };
  engine?.takeEvents(); // the replay's events are history, not news
  const hash = engine === null ? replayed.hash : worldHash(materialiseWorld(replayed.bus.state, engine.exportState()));
  return { ok: true, bus: replayed.bus, engine, hash };
}

/** {@link replayGame} for an already validated, current-version replay log. */
export function replayLogGame(log: ReplayLog, options: CommonOptions = {}): ReplayGameResult {
  const replayed = replayWithEngine(log, options);
  if (!replayed.ok) return replayed;
  return { ok: true, game: wrap(replayed.bus, log.initialWorld, replayed.engine) };
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
   * The log was dropped and a new log starts from the loaded world. `hash-mismatch` and
   * `replay-failed`: it didn't reproduce the world (the UI should say so; `message` names the first
   * failing entry, if any). `engine-changed` (D8): the save is from another sim engine or catalogue,
   * so its log wasn't (or, for a migrated P1 save, couldn't be) verified; never refused.
   * `too-long-to-verify`: the log spans more than {@link MAX_VERIFY_TICKS}, so verifying it would block
   * the load; never refused.
   */
  | {
      readonly status: 'restarted';
      readonly reason: 'replay-failed' | 'hash-mismatch' | 'engine-changed' | 'too-long-to-verify';
      readonly message: string;
    };

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

/**
 * A save whose device state or connections don't match the device catalogue (ADR 0011 §10 step 1,
 * ADR 0013): a bag with the wrong keys or an invalid value for its device's model kind, a lead on a
 * terminal its device doesn't have. `issues` are value-free, like a `LoadError`'s.
 */
export interface InvalidDeviceStateError {
  readonly kind: 'invalid-device-state';
  readonly issues: readonly ValidationIssue[];
  readonly message: string;
}

/**
 * A save whose sim state the engine refuses at start (ADR 0011 §9.6): a solution record that doesn't
 * fit its world's netlist (another topology, other sizes, or one on an empty netlist). Value-free.
 */
export interface SimStartFailedError {
  readonly kind: 'start-failed';
  readonly reason: SimStartFailure;
  readonly message: string;
}

/** Why {@link loadGame} refused a save: the container's error, the device check's or the engine's. */
export type LoadGameError = CtrlError | InvalidDeviceStateError | SimStartFailedError;

export type LoadGameResult = LoadedGame | { readonly ok: false; readonly error: LoadGameError };

export type LoadGameOptions = CommonOptions & ReadCtrlOptions;

/**
 * Loads a `.ctrl` save from untrusted bytes (F1.8b). `readCtrl` reads, migrates and validates it
 * (otherwise a typed `CtrlError`, including `newer-than-build`); then its world's device state and
 * connections are checked against the device catalogue (otherwise `invalid-device-state`), and a
 * game is built on its world (otherwise `start-failed`).
 * **The undo stack is cleared and the replay log continues:** the log is replayed from its initial
 * world with the engine and, if it reproduces the saved world's hash, the game continues it (same
 * `seq` numbering, so seeded streams stay put); otherwise a new log starts (see {@link SaveReplayStatus}).
 * A save from another engine or catalogue version isn't verified (D8, `engineCompatible`). Never
 * throws. The host replaces its session with the returned game.
 */
export function loadGame(bytes: Uint8Array, options: LoadGameOptions = {}): LoadGameResult {
  const read = readCtrl(bytes, { limits: options.limits ?? {} });
  if (!read.ok) return { ok: false, error: read.error };
  return gameFromSave(read.value, options);
}

/** Why a save's log restarted as `engine-changed` (D8): shown by the game and `sim-cli` alike. */
export const ENGINE_CHANGED_MESSAGE =
  'The save was made with another version of the simulator, so its replay log wasn’t checked and a new log started from the loaded game. The game itself loaded normally.';

/** Why a save's log restarted as `too-long-to-verify`: shown by the game and `sim-cli` alike. */
export const TOO_LONG_TO_VERIFY_MESSAGE =
  'The save’s replay log covers too much sim time to check while loading, so a new log started from the loaded game. The game itself loaded normally.';

/**
 * The most sim time, in ticks, a load verifies by replaying a save's log (`endTick` − the initial
 * world's tick). Deterministic, never the wall clock: a save past it isn't replayed and restarts its
 * log as `too-long-to-verify`, never refused. Without a bound a crafted `endTick` (1e12) would step
 * the engine for hours, synchronously, while the game loads.
 */
export const MAX_VERIFY_TICKS: SourcedConstant = {
  value: 10_000,
  unit: 'tick',
  kind: 'numerical',
  source:
    'numerical: `sim bench` case `plant-advance-1000-ticks` (the 2,000-node plant, 100 cadence solves and 1,000 layer steps) measured 45 ms per 1,000 ticks (0.045 ms per tick) on an AMD Ryzen 5 5600X under Node 24, built bundle. CI runners run the plant re-solve about 1.4× (Ubuntu) to 3.2× (Windows) slower, so about 0.15 ms per tick on the slowest. For load verification under about 2 s on CI-class hardware that allows about 13 800 ticks; 10 000 (10 s of sim time) leaves headroom: about 0.45 s locally and 1.45 s on the slowest runner. Small P2 benches replay far faster. Whether long logs are later rebased or checkpointed, so verification stays bounded, is an open user decision (plan F2.3a).',
};

/**
 * {@link loadGame} for contents already read with `readCtrl`. Never throws. A restarted log
 * continues the saved log's numbering (`firstSeq` = its next `seq`, ADR 0011 §10), so seeded
 * streams keyed by `seq` don't repeat.
 */
export function gameFromSave(
  contents: CtrlContents,
  options: CommonOptions = {},
): LoadedGame | { readonly ok: false; readonly error: InvalidDeviceStateError | SimStartFailedError } {
  const { world, replayLog: log, manifest } = contents;
  const catalog = options.engine === false ? undefined : options.engine?.catalog;
  const devices = checkWorldDevices(world, catalog);
  if (devices.length > 0) {
    return {
      ok: false,
      error: {
        kind: 'invalid-device-state',
        issues: devices,
        message: "The save's device state doesn't match the device catalogue.",
      },
    };
  }
  const compatibility = engineCompatible(manifest, BUILD_ENGINE_VERSIONS);
  const done = (game: Game, replay: SaveReplayStatus): LoadedGame => ({
    ok: true,
    game,
    manifest,
    thumbnail: contents.thumbnail,
    fromVersion: contents.fromVersion,
    replay,
  });
  let replay: SaveReplayStatus;
  if (log === null) {
    replay = { status: 'absent' };
  } else if (compatibility === 'engine-changed') {
    replay = { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE };
  } else if (log.endTick - log.initialWorld.tick > MAX_VERIFY_TICKS.value) {
    replay = { status: 'restarted', reason: 'too-long-to-verify', message: TOO_LONG_TO_VERIFY_MESSAGE };
  } else {
    const replayed = replayWithEngine(log, options);
    if (replayed.ok && replayed.hash === worldHash(world)) {
      replayed.bus.clearHistory();
      return done(wrap(replayed.bus, log.initialWorld, replayed.engine), { status: 'continued' });
    }
    if (compatibility === 'verify-v0') {
      replay = { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE };
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
  const registry = options.registry ?? createWorldRegistry();
  const firstSeq = log === null ? 0 : log.firstSeq + log.entries.length;
  let start = world;
  let engine: SimEngine | null;
  try {
    engine = startEngine(start, options);
  } catch (error) {
    if (!(error instanceof SimStartError)) throw error;
    if (compatibility === 'verify') {
      return {
        ok: false,
        error: {
          kind: 'start-failed',
          reason: error.reason,
          message: "The save's simulation state doesn't fit its circuit.",
        },
      };
    }
    // D8: a save from another engine is never refused. Its solution record may not fit this build's
    // netlist (another engine's models), so drop the record: the engine solves at the save's tick.
    start = { ...world, sim: null };
    engine = startEngine(start, options);
    if (replay.status === 'restarted' && replay.reason !== 'engine-changed') {
      replay = { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE };
    }
  }
  return done(wrap(createWorldBus(start, registry, { firstSeq }), start, engine), replay);
}
