import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import {
  type CommandRegistry,
  type ContextKeys,
  type ContextValue,
  type ExecResult,
  type ExecutedEvent,
  fileCommands,
  SESSION_ACTIVE_KEY,
  SIM_PAUSED_KEY,
  SIM_RESTART_COMMAND,
  SIM_SPEED_KEY,
  SIM_STATUS_KEY,
  simHostCommands,
} from '@controls/commands';
import { createWorld, type ReplayEntry, type ReplayLog } from '@controls/save-format';
import { createGame, type Game, type SaveGameOptions, writeSave } from '@controls/scripting-api';
import { type PrepareLoadResult, type PreparedLoad, prepareLoad } from './load';
import { SimHost } from './sim-host';
import {
  createWorldRegistry,
  hashWorldDocument,
  loadLevel,
  newGameWorld,
  type NewGameOptions,
  type World,
  worldHash,
} from '@controls/world-model';

export type CommandHandler = (event: ExecutedEvent<World>) => void;

/** A save bound to one session's game at one tick ({@link Session.saver}). */
export interface SessionSaver {
  /** The session it belongs to (`Session.generation` when it was taken). */
  readonly generation: number;
  /** The tick it was taken at: the moment Save was pressed (ADR 0011 §9.5). */
  readonly tick: number;
  /**
   * Whether **this session** (since its start or adopt) had logged a world command when it was taken
   * (the dirty model, ADR 0011 §9.5): entries carried over in a continued log don't count, so a
   * continued and a restarted load of the same save behave the same.
   */
  readonly changedWorld: boolean;
  /** The game's own `world.hash` at its start or adopt, captured with the saver (the dirty baseline). */
  readonly baseline: Promise<string>;
  /**
   * That game at that tick as `.ctrl` bytes, with the `world.hash` they hold, once the sim worker has
   * answered. Rejects with `SimQueryRejection` (`crashed`, `timeout`, …) and `CtrlWriteError` like
   * `Game.save` (over a cap, or a thumbnail that isn't a PNG). Can be called more than once.
   */
  save(options?: SaveGameOptions): Promise<{ readonly bytes: Uint8Array; readonly hash: string }>;
  /** The `world.hash` of the save, without writing it. */
  hash(): Promise<string>;
}

/**
 * The level New sandbox starts from (F1.9): an untrusted, `JSON.parse`d world document, validated
 * through the normal loader when the session starts. The game app provides
 * `content/levels/workshop.json`; without a provider (unit tests) sandboxes start from an empty world.
 */
export const SANDBOX_LEVEL = new InjectionToken<unknown>('controls.sandboxLevel', {
  providedIn: 'root',
  factory: () => null,
});

/** Window property for the E2E test hook (`?e2e=1` only). */
const TEST_HOOK = '__controlsSession';

/**
 * The Angular adapter over the scripting API's `Game` (`@controls/scripting-api`, F1.6), the same
 * object `sim-cli` scripts drive, so the UI and scripts run identical code. It holds the session's
 * world as a signal and is the UI's only way to change it: every change is `exec(id, args)` through
 * the one registry (ADR 0006). Kept thin on purpose: no command logic lives here.
 *
 * - **View commands** (`view.resetLayout`, …) don't change the world. The feature that owns the
 *   view state reacts with {@link onCommand}, so the command is logged like any other and replays
 *   headless as a no-op.
 * - **Context keys** for `when` are the game's own (`history.canUndo`, `history.canRedo`), the
 *   session's `session.active`, plus whatever the UI sets with {@link setContext} (`mode`,
 *   `selection.kind`, … from F1.4/F1.7).
 * - **Saving and loading** (F1.8b): {@link save} writes the game as `.ctrl` bytes; {@link adopt}
 *   replaces the game with one `loadGame` built. The registry also holds the unlogged `file.*`
 *   commands, which the saves feature performs through {@link onCommand}.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  /**
   * World, edit, view and sim time commands (`createWorldRegistry`) plus the host's unlogged `file.*`
   * commands and `sim.restart`.
   */
  readonly registry: CommandRegistry<World> = createWorldRegistry()
    .registerAll(fileCommands<World>())
    .registerAll(simHostCommands<World>());
  /** The sim worker's host: the game's time host, the snapshot source and the asynchronous queries. */
  readonly sim = inject(SimHost);
  private game!: Game;
  private readonly activeState = signal(false);
  private unsubscribe: () => void = () => undefined;
  private readonly handlers = new Map<string, Set<CommandHandler>>();
  private readonly worldState = signal<World>(createWorld({ seed: 0 }));
  private readonly history = signal({ 'history.canUndo': false, 'history.canRedo': false });
  private readonly uiContext = signal<Readonly<Record<string, ContextValue>>>({});
  private readonly log = signal<readonly ReplayEntry[]>([]);
  private readonly started = signal(0);
  /** The first `seq` this session logs: entries below it were carried over from a loaded log. */
  private sessionSeq = 0;
  /** The game's own `world.hash` when it started or was adopted (the dirty model's baseline). */
  private baseline: { readonly generation: number; readonly hash: Promise<string> } = {
    generation: 0,
    hash: Promise.resolve(''),
  };
  /** The sandbox level (validated), or an empty world without one. */
  readonly level: World = sandboxLevel(inject(SANDBOX_LEVEL));

  /**
   * The current commanded world, after the last command. Read-only: change it with {@link exec}. Its
   * `tick` and `sim` bags are never shown (ADR 0011 §9.3): read the time from `SimHost.simTick` and sim
   * values from snapshots. The hash is asynchronous: {@link hashAt}.
   */
  readonly world = this.worldState.asReadonly();
  /** The replay entries of this session. */
  readonly entries = this.log.asReadonly();
  readonly canUndo = computed(() => this.history()['history.canUndo']);
  readonly canRedo = computed(() => this.history()['history.canRedo']);
  /**
   * A game is in progress (New sandbox or a loaded save). False at start-up, while the session shows
   * the level behind the main menu. Published as the `session.active` context key.
   */
  readonly active = this.activeState.asReadonly();
  /** Every context key, for evaluating `when`. */
  readonly contextKeys = computed<ContextKeys>(() => ({
    ...this.uiContext(),
    ...this.history(),
    [SESSION_ACTIVE_KEY]: this.activeState(),
    [SIM_STATUS_KEY]: this.sim.status(),
    [SIM_PAUSED_KEY]: this.sim.speed() === 0,
    [SIM_SPEED_KEY]: this.sim.speed(),
  }));
  /** Counts {@link start}s: views that keep per-session state (the camera) reset when it changes. */
  readonly generation = this.started.asReadonly();

  constructor() {
    // Behind the main menu the level is shown as it is (its own seed), with no worker; New sandbox starts a game on it.
    this.start(this.level);
    // A crashed worker restarts from the session's log, to the current tick (ADR 0011 §10).
    this.onCommand(SIM_RESTART_COMMAND, () => this.sim.restart(this.game.replayLog()));
    this.exposeTestHook();
  }

  /**
   * New sandbox (F1.9): a new game on the sandbox level with the given seed (the new-game dialog's
   * fresh or typed one) and difficulty. Fresh history and an empty replay log. Throws for a seed
   * outside the unsigned 32-bit range; the dialog validates first.
   */
  newSandbox(options: NewGameOptions): void {
    const world = newGameWorld(this.level, options);
    this.attach(createGame({ world, registry: this.registry, time: this.sim.time }));
    this.sim.startWorld(world, 0); // one worker per game, started paused (ADR 0011 §10)
    this.setBaseline(this.sim.hashAt().then((r) => r.hash));
    this.activeState.set(true);
  }

  /**
   * Starts a new session from `world` with no sim worker (the menu backdrop): fresh history and an
   * empty replay log starting there. The world is validated and frozen (`createGame`), so treat it
   * as owned by the session.
   */
  start(world: World): void {
    this.attach(createGame({ world, registry: this.registry, time: this.sim.time }));
    this.sim.stop();
    this.setBaseline(Promise.resolve(worldHash(world)));
  }

  /**
   * Checks a save's bytes and starts its sim worker, without touching the session (ADR 0011 §10):
   * the parse and device check, then the log's verification in the worker. Adopt the result to load it.
   */
  prepareLoad(bytes: Uint8Array): Promise<PrepareLoadResult> {
    return prepareLoad(bytes, { registry: this.registry, host: this.sim });
  }

  /**
   * Replaces the session with a checked save (F1.8b, F2.3b): its game (migrated and validated, the
   * undo history cleared, the replay log continued or restarted) and the worker that checked it,
   * which carries on. The game must run on this session's registry, so the palette, keybindings and
   * console keep resolving the same commands. Marks the session active.
   */
  adopt(prepared: PreparedLoad): void {
    if (prepared.game.registry !== this.registry)
      throw new Error("Session.adopt needs a game on the session's registry");
    this.attach(prepared.game);
    this.sim.promote(prepared.candidate);
    this.setBaseline(Promise.resolve(prepared.hash));
    this.activeState.set(true);
  }

  /**
   * The game's own `world.hash` when generation `generation` started or was adopted: the baseline
   * "unsaved changes" compares with until the game is stored (plan F2.3b: never the level's hash,
   * which differs once a level has a circuit). Rejects for another generation.
   */
  baselineHash(generation: number): Promise<string> {
    if (generation !== this.baseline.generation) return Promise.reject(new Error('That session has been replaced'));
    return this.baseline.hash;
  }

  private setBaseline(hash: Promise<string>): void {
    hash.catch(() => undefined);
    this.baseline = { generation: this.started(), hash };
  }

  /** `world.hash` at the current tick, from the sim worker (`SimHost.hashAt`, ADR 0011 §9.4). */
  async hashAt(): Promise<string> {
    return (await this.sim.hashAt()).hash;
  }

  /**
   * Binds a save to the game running now, at its current tick (ADR 0011 §9.5): the bus world, the
   * log and `endTick` are captured in this call, and the worker's `state` query is posted in it, so
   * the save is of the moment it was taken even if a new sandbox or a load replaces the session while
   * it is written. `generation` says which session it belongs to. `timeoutMs` shortens the query's
   * deadline (the quit flush).
   */
  saver(timeoutMs?: number): SessionSaver {
    const log = this.game.replayLog();
    const captured = this.sim.capture(timeoutMs);
    captured.world.catch(() => undefined); // observed by save() / hash(); never an unhandled rejection
    return {
      generation: this.started(),
      tick: captured.tick,
      changedWorld: log.entries.some((entry) => entry.seq >= this.sessionSeq && this.changesWorld(entry.id)),
      baseline: this.baseline.hash,
      save: async (options = {}) => {
        const world = await captured.world;
        return { bytes: writeSave(world, log, options), hash: worldHash(world) };
      },
      hash: async () => worldHash(await captured.world),
    };
  }

  /** Whether a logged command can change the world (world commands and undo/redo; not view or `sim.*`). */
  private changesWorld(id: string): boolean {
    const command = this.registry.get(id);
    return command !== undefined && (command.undoable === true || id === 'edit.undo' || id === 'edit.redo');
  }

  /** Runs a command. Invalid args or a refused command return a typed error and change nothing. */
  exec(id: string, args: unknown = {}): ExecResult {
    return this.game.exec(id, args);
  }

  /** Whether the palette and keybindings should offer the command in the current context. */
  isEnabled(id: string): boolean {
    return this.registry.isEnabled(id, this.contextKeys());
  }

  /** Sets a UI context key for `when` (`null` clears it: a missing key reads as `null`). */
  setContext(key: string, value: ContextValue): void {
    this.uiContext.update((context) => {
      const next = { ...context };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  /**
   * Calls `handler` each time command `id` succeeds, after the world signal is updated, whether or
   * not it is logged (`palette.open` isn't). This is how view commands take effect. Returns an unsubscribe function.
   */
  onCommand(id: string, handler: CommandHandler): () => void {
    let set = this.handlers.get(id);
    if (!set) this.handlers.set(id, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** The replay log of this session (for `replay.log` in a save, F1.8b). */
  replayLog(): ReplayLog {
    return this.game.replayLog();
  }

  private attach(game: Game): void {
    this.unsubscribe();
    this.game = game;
    const log = game.replayLog();
    this.sessionSeq = log.firstSeq + log.entries.length;
    this.sim.bind({
      tick: () => game.tick(),
      advanceTo: (tick) => game.advanceTo(tick),
      world: () => game.world() as World,
    });
    this.unsubscribe = game.on('executed', (event) => this.executed(event));
    this.worldState.set(game.world() as World);
    this.history.set(game.contextKeys());
    this.log.set([...game.entries()]); // a loaded game continues its log
    this.started.update((n) => n + 1);
  }

  private executed(event: ExecutedEvent<World>): void {
    this.worldState.set(event.state);
    this.history.set(this.game.contextKeys());
    if (event.logged) this.log.set([...this.game.entries()]); // UI chrome (palette.open) isn't logged
    for (const handler of [...(this.handlers.get(event.command.id) ?? [])]) handler(event);
  }

  /**
   * `?e2e=1` only (ADR 0011 §9.4): exposes exec, the asynchronous world and snapshot hashes (from the
   * sim worker), the bus world, the sim's tick and status, and a pure hash-of-JSON function on
   * `window`, so Playwright can drive commands and prove the hashes match the Node golden values in
   * Chromium (the world hash since F1.2; the worker's snapshot, D6, since F2.3b).
   */
  private exposeTestHook(): void {
    const view = inject(DOCUMENT).defaultView;
    if (!view || new URLSearchParams(view.location.search).get('e2e') !== '1') return;
    const target = view as unknown as Record<string, unknown>;
    target[TEST_HOOK] = {
      exec: (id: string, args?: unknown) => this.exec(id, args),
      hash: () => this.hashAt(),
      snapshotHash: () => this.sim.snapshotHash(),
      busWorld: () => this.game.world(),
      simTick: () => this.sim.simTick(),
      waitForTick: (tick: number) => this.sim.waitForTick(tick),
      simStatus: () => this.sim.status(),
      simStats: () => this.sim.stats(),
      entries: () => this.entries(),
      hashWorld: (json: unknown) => {
        const result = hashWorldDocument(json);
        return result.ok ? result.hash : null;
      },
    };
    inject(DestroyRef).onDestroy(() => delete target[TEST_HOOK]);
  }
}

/** Validates the provided level; an empty world without one, or (logged) when it doesn't load. */
function sandboxLevel(json: unknown): World {
  if (json === null) return createWorld({ seed: 0 });
  const loaded = loadLevel(json);
  if (loaded.ok) return loaded.level;
  console.error('The sandbox level failed to load; starting from an empty world.', loaded.error);
  return createWorld({ seed: 0 });
}
