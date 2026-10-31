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
} from '@controls/commands';
import { createWorld, type ReplayEntry, type ReplayLog } from '@controls/save-format';
import { createGame, type Game, type SaveGameOptions } from '@controls/scripting-api';
import {
  createWorldRegistry,
  hashWorldDocument,
  loadLevel,
  newGameWorld,
  type NewGameOptions,
  type World,
} from '@controls/world-model';

export type CommandHandler = (event: ExecutedEvent<World>) => void;

/** A save bound to one session's game ({@link Session.saver}). */
export interface SessionSaver {
  /** The session it belongs to (`Session.generation` when it was taken). */
  readonly generation: number;
  /** That game as `.ctrl` bytes now, with the `world.hash` they hold. Throws `CtrlWriteError` like `Game.save`. */
  save(options?: SaveGameOptions): { readonly bytes: Uint8Array; readonly hash: string };
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
  /** World, edit and view commands (`createWorldRegistry`) plus the host's unlogged `file.*` commands. */
  readonly registry: CommandRegistry<World> = createWorldRegistry().registerAll(fileCommands<World>());
  private game!: Game;
  private readonly activeState = signal(false);
  private unsubscribe: () => void = () => undefined;
  private readonly handlers = new Map<string, Set<CommandHandler>>();
  private readonly worldState = signal<World>(createWorld({ seed: 0 }));
  private readonly history = signal({ 'history.canUndo': false, 'history.canRedo': false });
  private readonly uiContext = signal<Readonly<Record<string, ContextValue>>>({});
  private readonly log = signal<readonly ReplayEntry[]>([]);
  private readonly started = signal(0);
  /** The sandbox level (validated), or an empty world without one. */
  readonly level: World = sandboxLevel(inject(SANDBOX_LEVEL));

  /** The current world document. Read-only: change it with {@link exec}. */
  readonly world = this.worldState.asReadonly();
  /**
   * `world.hash` of the current world, with the sim state materialised (`Game.hash`, ADR 0011 §1),
   * computed on demand. Until F2.3b moves the engine to the sim worker, the game's engine runs
   * in-process, so this stays synchronous; time moves only with commands (`sim.step`) until then.
   */
  readonly hash = computed(() => {
    this.world();
    return this.game.hash();
  });
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
  }));
  /** Counts {@link start}s: views that keep per-session state (the camera) reset when it changes. */
  readonly generation = this.started.asReadonly();

  constructor() {
    // Behind the main menu the level is shown as it is (its own seed); New sandbox starts a game on it.
    this.start(this.level);
    this.exposeTestHook();
  }

  /**
   * New sandbox (F1.9): a new game on the sandbox level with the given seed (the new-game dialog's
   * fresh or typed one) and difficulty. Fresh history and an empty replay log. Throws for a seed
   * outside the unsigned 32-bit range; the dialog validates first.
   */
  newSandbox(options: NewGameOptions): void {
    this.start(newGameWorld(this.level, options));
    this.activeState.set(true);
  }

  /**
   * Starts a new session from `world`: fresh history and an empty replay log starting there. The
   * world is validated and frozen (`createGame`), so treat it as owned by the session.
   */
  start(world: World): void {
    this.attach(createGame({ world, registry: this.registry }));
  }

  /**
   * Replaces the session with a loaded game (F1.8b): the result of `loadGame(bytes, { registry:
   * session.registry })`, which has already migrated and validated the save, cleared the undo
   * history and continued (or restarted) the replay log. The game must run on this session's
   * registry, so the palette, keybindings and console keep resolving the same commands. Marks the
   * session active.
   */
  adopt(game: Game): void {
    if (game.registry !== this.registry) throw new Error("Session.adopt needs a game on the session's registry");
    this.attach(game);
    this.activeState.set(true);
  }

  /**
   * The game as `.ctrl` bytes (`Game.save`): manifest, world, replay log and an optional PNG
   * thumbnail. Throws `CtrlWriteError` if the save would be over a cap or the thumbnail isn't a PNG.
   */
  save(options: SaveGameOptions = {}): Uint8Array {
    return this.game.save(options);
  }

  /**
   * Binds a save to the game running now, for writers that save later (after an `await`): the
   * returned `save` writes this game, with its state at that time, even if a new sandbox or a load
   * has replaced the session since. `generation` says which session it belongs to.
   */
  saver(): SessionSaver {
    const game = this.game;
    return {
      generation: this.started(),
      save: (options = {}) => ({ bytes: game.save(options), hash: game.hash() }),
    };
  }

  /** Runs a command. Invalid args or a refused command return a typed error and change nothing. */
  exec(id: string, args: unknown = {}): ExecResult {
    return this.game.exec(id, args);
  }

  /** The sim snapshot's hash at the current tick (`Game.snapshotHash`, ADR 0011 §5.2). */
  snapshotHash(): string {
    return this.game.snapshotHash();
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
   * `?e2e=1` only: exposes exec, the world and snapshot hashes and a pure hash-of-JSON function on
   * `window`, so Playwright can drive commands and prove the hashes match the Node golden values in
   * Chromium (the world hash since F1.2; the engine's snapshot, D6, since F2.3a).
   */
  private exposeTestHook(): void {
    const view = inject(DOCUMENT).defaultView;
    if (!view || new URLSearchParams(view.location.search).get('e2e') !== '1') return;
    const target = view as unknown as Record<string, unknown>;
    target[TEST_HOOK] = {
      exec: (id: string, args?: unknown) => this.exec(id, args),
      hash: () => this.hash(),
      snapshotHash: () => this.snapshotHash(),
      world: () => this.world(),
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
