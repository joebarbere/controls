import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { CommandRegistry, ContextKeys, ContextValue, ExecResult, ExecutedEvent } from '@controls/commands';
import { createWorld, type ReplayEntry, type ReplayLog } from '@controls/save-format';
import { createGame, type Game } from '@controls/scripting-api';
import { createWorldRegistry, hashWorldDocument, type World, worldHash } from '@controls/world-model';

export type CommandHandler = (event: ExecutedEvent<World>) => void;

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
 * - **Context keys** for `when` are the game's own (`history.canUndo`, `history.canRedo`) plus
 *   whatever the UI sets with {@link setContext} (`mode`, `selection.kind`, … from F1.4/F1.7).
 */
@Injectable({ providedIn: 'root' })
export class Session {
  readonly registry: CommandRegistry<World> = createWorldRegistry();
  private game!: Game;
  private unsubscribe: () => void = () => undefined;
  private readonly handlers = new Map<string, Set<CommandHandler>>();
  private readonly worldState = signal<World>(createWorld({ seed: 0 }));
  private readonly history = signal({ 'history.canUndo': false, 'history.canRedo': false });
  private readonly uiContext = signal<Readonly<Record<string, ContextValue>>>({});
  private readonly log = signal<readonly ReplayEntry[]>([]);

  /** The current world document. Read-only: change it with {@link exec}. */
  readonly world = this.worldState.asReadonly();
  /** `world.hash` of the current world (computed on demand). */
  readonly hash = computed(() => worldHash(this.world()));
  /** The replay entries of this session. */
  readonly entries = this.log.asReadonly();
  readonly canUndo = computed(() => this.history()['history.canUndo']);
  readonly canRedo = computed(() => this.history()['history.canRedo']);
  /** Every context key, for evaluating `when`. */
  readonly contextKeys = computed<ContextKeys>(() => ({ ...this.uiContext(), ...this.history() }));

  constructor() {
    // A new session starts from an empty world with seed 0 until the workshop level and the new-game
    // seed arrive (F1.9).
    this.start(this.worldState());
    this.exposeTestHook();
  }

  /**
   * Starts a new session from `world`: fresh history and an empty replay log starting there. The
   * world is validated and frozen (`createGame`), so treat it as owned by the session.
   */
  start(world: World): void {
    this.unsubscribe();
    this.game = createGame({ world, registry: this.registry });
    this.unsubscribe = this.game.on('executed', (event) => this.executed(event));
    this.worldState.set(world);
    this.history.set(this.game.contextKeys());
    this.log.set([]);
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
   * Calls `handler` each time command `id` succeeds, after the world signal is updated. This is how
   * view commands take effect. Returns an unsubscribe function.
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

  private executed(event: ExecutedEvent<World>): void {
    this.worldState.set(event.state);
    this.history.set(this.game.contextKeys());
    this.log.set([...this.game.entries()]);
    for (const handler of [...(this.handlers.get(event.entry.id) ?? [])]) handler(event);
  }

  /**
   * `?e2e=1` only: exposes exec, the hash and a pure hash-of-JSON function on `window`, so
   * Playwright can drive commands and prove the hash matches the Node golden values in Chromium.
   */
  private exposeTestHook(): void {
    const view = inject(DOCUMENT).defaultView;
    if (!view || new URLSearchParams(view.location.search).get('e2e') !== '1') return;
    const target = view as unknown as Record<string, unknown>;
    target[TEST_HOOK] = {
      exec: (id: string, args?: unknown) => this.exec(id, args),
      hash: () => this.hash(),
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
