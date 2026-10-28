import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { Session, type SessionSaver } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { APP_LIFECYCLE, NotificationService, ShellState } from '@controls/feature-shell';
import type { SaveAsTarget, SaveEntry, SaveName } from '@controls/platform-api';
import { type LoadedGame, loadGame } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { loadErrorReason, saveIoCodeOf, saveIoReason } from './messages';
import { REPLAY_MISMATCH_POLICY, SAVE_DIALOGS, SAVE_FILES, SaveThumbnails } from './save-io';

/** The name offered for a game that hasn't been saved under one yet (always a valid `SaveName`). */
export function suggestedSaveName(seed: number): SaveName {
  return `Sandbox ${seed >>> 0}`;
}

/** Shown when a save loaded but its replay log had to be restarted (ADR 0007: the world wins). */
export const REPLAY_RESTARTED_MESSAGE =
  'The save’s replay log didn’t match its world, so a new log started from the loaded game. The game itself loaded normally.';

/** `Game.save` refused to write the game (over a `CTRL_LIMITS` cap even without a thumbnail). */
const TOO_LARGE_TO_SAVE = 'The game is too large to save.';

export type SaveOutcome = 'saved' | 'exists' | 'failed';

interface Snapshot {
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly generation: number;
}

type Checked = { readonly ok: true; readonly loaded: LoadedGame } | { readonly ok: false; readonly reason: string };

const quoted = (name: string) => `“${name}”`;

/**
 * Saving and loading games (F1.8b part 3): the `file.*` commands, autosave and Continue, on top of
 * `Session` (the game), `loadGame` (bytes → game) and the platform's save I/O (ADR 0009).
 *
 * - **Commands.** `file.save`, `file.saveAs`, `file.open` and `file.load` are unlogged UI commands
 *   in the session's registry (ADR 0006); this service performs them when the session reports them,
 *   so the palette, keybindings, console and menu all reach the same code.
 * - **Loading** reads the bytes, then `loadGame` migrates and validates them before anything changes;
 *   only a save that loads replaces the session (`Session.adopt`). The undo history is cleared and
 *   the replay log continues, or restarts with a notification (see {@link REPLAY_MISMATCH_POLICY}).
 * - **Autosave** writes the next of `settings.autosave.slotCount` slots (rotation is the platform's)
 *   every `intervalSeconds` while a game is in progress, when the player returns to the menu, before
 *   another game replaces this one, and before the app quits. Only a game with unsaved changes is
 *   autosaved: a world back at its last saved (or starting) hash is not, so an untouched new sandbox
 *   never takes a slot from a real game.
 * - **Errors** become notifications written from the error's code or kind (`messages.ts`), never its
 *   message, so nothing from a file or a host path is echoed.
 *
 * Writes run one at a time, in order. UI-only state: nothing here is a world change.
 */
@Injectable({ providedIn: 'root' })
export class SaveGames {
  private readonly session = inject(Session);
  private readonly settings = inject(SettingsStore);
  private readonly shell = inject(ShellState);
  private readonly notifications = inject(NotificationService);
  private readonly files = inject(SAVE_FILES);
  private readonly dialogs = inject(SAVE_DIALOGS);
  private readonly thumbnails = inject(SaveThumbnails);
  private readonly replayPolicy = inject(REPLAY_MISMATCH_POLICY);

  private readonly entries = signal<readonly SaveEntry[]>([]);
  private readonly named = signal<{ readonly generation: number; readonly name: SaveName } | null>(null);
  private readonly loadingState = signal(false);
  /** The world hash that counts as saved, per session generation (`Session.generation`). */
  private clean: { readonly generation: number; readonly hash: string } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private listing = 0;
  private readonly loadedListeners = new Set<() => void>();

  /** Manual saves and autosave slots in the save directory, newest first (refreshed after each write). */
  readonly saves = this.entries.asReadonly();
  /** There is at least one save to continue from. */
  readonly canContinue = computed(() => this.entries().length > 0);
  /** The manual save this game was last saved as or loaded from; `null` for a new or autosaved game. */
  readonly saveName = computed(() => {
    const named = this.named();
    return named !== null && named.generation === this.session.generation() ? named.name : null;
  });
  /** A load (Continue, Load, Open) is in progress. */
  readonly loading = this.loadingState.asReadonly();
  /** Resolves once the save directory has been listed at start-up. */
  readonly ready: Promise<void>;

  constructor() {
    const offs = [
      this.session.onCommand('file.save', () => void this.save()),
      this.session.onCommand('file.saveAs', () => void this.saveToFile()),
      this.session.onCommand('file.open', () => void this.openFile()),
      this.session.onCommand('file.load', () => void this.showLoad()),
      inject(APP_LIFECYCLE).onBeforeQuit(() => this.flush()),
    ];
    // The autosave timer is a side effect of two signals (the settings and whether a game runs).
    effect((onCleanup) => {
      const { enabled, intervalSeconds } = this.settings.settings().autosave;
      if (!enabled || !this.session.active()) return;
      const timer = setInterval(() => void this.autosave(), intervalSeconds * 1000);
      onCleanup(() => clearInterval(timer));
    });
    inject(DestroyRef).onDestroy(() => offs.forEach((off) => off()));
    this.ready = this.refresh();
  }

  /** Calls `listener` after a save has replaced the session (to enter the workspace). Returns an unsubscribe. */
  onLoaded(listener: () => void): () => void {
    this.loadedListeners.add(listener);
    return () => this.loadedListeners.delete(listener);
  }

  /** Whether the game has changes no save holds: its world differs from the last saved, loaded or starting one. */
  isDirty(): boolean {
    if (!this.session.active()) return false;
    const generation = this.session.generation();
    const cleanHash =
      this.clean?.generation === generation ? this.clean.hash : worldHash(this.session.replayLog().initialWorld);
    return this.session.hash() !== cleanHash;
  }

  /** Lists the save directory again. A failure leaves an empty list (and says so, unless there is no storage). */
  async refresh(): Promise<void> {
    const listing = ++this.listing;
    try {
      const list = await this.files.list();
      if (listing === this.listing) this.entries.set(list.filter((entry) => entry.kind !== 'external'));
    } catch (error) {
      if (listing !== this.listing) return;
      this.entries.set([]);
      if (saveIoCodeOf(error) !== 'unavailable') {
        this.notifications.notify(`Saved games couldn’t be listed. ${saveIoReason(error, 'list')}`, {
          level: 'warning',
        });
      }
    }
  }

  /** `file.save`: saves under the game's save name, or opens the Save game dialog to name it. */
  save(): Promise<SaveOutcome | null> {
    if (!this.requireGame()) return Promise.resolve(null);
    const name = this.saveName();
    if (name === null) {
      this.shell.openDialog('save');
      return Promise.resolve(null);
    }
    return this.saveNamed(name, true);
  }

  /**
   * Writes the game as manual save `name`. Without `overwrite`, an existing save of that name is
   * left alone and the outcome is `exists`. On success the game takes that name.
   */
  saveNamed(name: SaveName, overwrite: boolean): Promise<SaveOutcome> {
    const saver = this.session.saver();
    return this.serial(async () => {
      const snapshot = await this.snapshot(saver, true);
      if (!snapshot) {
        this.error(`Couldn’t save ${quoted(name)}. ${TOO_LARGE_TO_SAVE}`);
        return 'failed';
      }
      try {
        await this.files.write({ kind: 'manual', name, overwrite }, snapshot.bytes);
      } catch (error) {
        this.error(`Couldn’t save ${quoted(name)}. ${saveIoReason(error, 'save')}`);
        return saveIoCodeOf(error) === 'exists' ? 'exists' : 'failed';
      }
      this.markClean(snapshot);
      this.named.set({ generation: snapshot.generation, name });
      this.notifications.notify(`Saved ${quoted(name)}.`, { level: 'success' });
      void this.refresh();
      return 'saved';
    });
  }

  /**
   * `file.saveAs`: writes the game to a file the player picks (a download in the web harness). The
   * picker opens synchronously, inside the gesture that ran the command.
   */
  async saveToFile(): Promise<SaveOutcome | null> {
    if (!this.requireGame()) return null;
    const saver = this.session.saver();
    let target: SaveAsTarget | null;
    try {
      target = await this.dialogs.saveAs({
        fileType: 'ctrl',
        suggestedName: this.saveName() ?? suggestedSaveName(this.session.world().seed),
      });
    } catch (error) {
      this.error(`Couldn’t save the game. ${saveIoReason(error, 'save')}`);
      return 'failed';
    }
    if (target === null) return null;
    const { handle, name } = target;
    return this.serial(async () => {
      const snapshot = await this.snapshot(saver, true);
      if (!snapshot) {
        this.error(`Couldn’t save the game. ${TOO_LARGE_TO_SAVE}`);
        return 'failed';
      }
      try {
        await this.files.write({ kind: 'handle', handle }, snapshot.bytes);
      } catch (error) {
        this.error(`Couldn’t save the game. ${saveIoReason(error, 'save')}`);
        return 'failed';
      }
      this.markClean(snapshot);
      this.notifications.notify(`Saved to ${quoted(name)}.`, { level: 'success' });
      return 'saved';
    });
  }

  /**
   * Writes the next autosave slot if autosave is on and the game has unsaved changes. Resolves `true`
   * if it wrote one. Failures are reported as warnings and never throw.
   */
  autosave(options: { readonly thumbnail?: boolean } = {}): Promise<boolean> {
    // Decided now, for the game running now: a game that a load replaces before the write runs still gets it.
    const { enabled, slotCount } = this.settings.settings().autosave;
    if (!enabled || !this.isDirty()) return this.serial(async () => false);
    const saver = this.session.saver();
    return this.serial(async () => {
      // A save queued ahead of this one may have saved these changes already.
      if (saver.generation === this.session.generation() && !this.isDirty()) return false;
      const snapshot = await this.snapshot(saver, options.thumbnail ?? true);
      if (!snapshot) {
        this.notifications.notify(`Autosave failed. ${TOO_LARGE_TO_SAVE}`, { level: 'warning' });
        return false;
      }
      try {
        await this.files.write({ kind: 'autosave', slotCount }, snapshot.bytes);
      } catch (error) {
        this.notifications.notify(`Autosave failed. ${saveIoReason(error, 'save')}`, { level: 'warning' });
        return false;
      }
      this.markClean(snapshot);
      void this.refresh();
      return true;
    });
  }

  /**
   * Before quit: autosaves unsaved changes (without a thumbnail, to stay inside the host's flush
   * timeout) and resolves once every write already queued has settled. Never rejects.
   */
  flush(): Promise<void> {
    return this.autosave({ thumbnail: false }).then(
      () => undefined,
      () => undefined,
    );
  }

  /** `file.load`: lists the saves again and shows the Load game dialog. */
  async showLoad(): Promise<void> {
    await this.refresh();
    this.shell.openDialog('load');
  }

  /** `file.open`: the player picks a file (an upload in the web harness), which is then loaded. */
  async openFile(): Promise<boolean> {
    const entry = await this.pickFile();
    return entry ? this.load(entry) : false;
  }

  /** Opens the Open picker (synchronously: call from a gesture). `null` if cancelled or refused. */
  async pickFile(): Promise<SaveEntry | null> {
    try {
      return await this.dialogs.open({ fileType: 'ctrl' });
    } catch (error) {
      this.error(`Couldn’t open a file. ${saveIoReason(error, 'load')}`);
      return null;
    }
  }

  /** Loads `entry`, replacing the session only if it loads. Resolves `true` if it did. */
  async load(entry: SaveEntry): Promise<boolean> {
    if (this.loadingState()) return false;
    this.loadingState.set(true);
    try {
      const checked = await this.check(entry);
      if (!checked.ok) {
        this.error(`Couldn’t load ${quoted(entry.name)}. ${checked.reason}`);
        return false;
      }
      return await this.apply(entry, checked.loaded);
    } finally {
      this.loadingState.set(false);
    }
  }

  /**
   * Continue: loads the newest save (manual or autosave) that loads, skipping any that don't with
   * one notification. Resolves `true` if a save was loaded.
   */
  async continueLatest(): Promise<boolean> {
    if (this.loadingState()) return false;
    this.loadingState.set(true);
    try {
      await this.refresh();
      const skipped: { readonly name: string; readonly reason: string }[] = [];
      for (const entry of this.entries()) {
        const checked = await this.check(entry);
        if (!checked.ok) {
          skipped.push({ name: entry.name, reason: checked.reason });
          continue;
        }
        if (skipped.length > 0) this.notifications.notify(skippedMessage(skipped), { level: 'warning' });
        return await this.apply(entry, checked.loaded);
      }
      if (skipped.length > 0) this.error(`None of your saves could be loaded. ${skippedMessage(skipped)}`);
      else this.notifications.notify('There are no saved games to continue.');
      return false;
    } finally {
      this.loadingState.set(false);
    }
  }

  /** Reads and validates a save without touching the session. */
  private async check(entry: SaveEntry): Promise<Checked> {
    let bytes: Uint8Array;
    try {
      bytes = await this.files.read(entry.handle);
    } catch (error) {
      const code = saveIoCodeOf(error);
      if (code === 'not-found' || code === 'unknown-handle') void this.refresh();
      return { ok: false, reason: saveIoReason(error, 'load') };
    }
    const loaded = loadGame(bytes, { registry: this.session.registry });
    if (!loaded.ok) return { ok: false, reason: loadErrorReason(loaded.error) };
    if (loaded.replay.status === 'restarted' && this.replayPolicy === 'refuse') {
      return { ok: false, reason: 'Its replay log doesn’t match its world.' };
    }
    return { ok: true, loaded };
  }

  /** Replaces the session with a checked save (after autosaving unsaved changes in the old one). */
  private async apply(entry: SaveEntry, loaded: LoadedGame): Promise<boolean> {
    await this.autosave();
    this.session.adopt(loaded.game);
    const generation = this.session.generation();
    this.clean = { generation, hash: loaded.game.hash() };
    this.named.set(entry.kind === 'manual' ? { generation, name: entry.name } : null);
    this.notifications.notify(`Loaded ${quoted(entry.name)}.`, { level: 'success' });
    if (loaded.replay.status === 'restarted') {
      this.notifications.notify(REPLAY_RESTARTED_MESSAGE, { level: 'warning' });
    }
    for (const listener of [...this.loadedListeners]) listener();
    return true;
  }

  /** The game as bytes, with a thumbnail if asked for and one can be captured; `null` if it can't be written. */
  private async snapshot(saver: SessionSaver, withThumbnail: boolean): Promise<Snapshot | null> {
    const captured = withThumbnail ? await this.thumbnails.capture() : null;
    // The viewport shows the current session: no thumbnail is better than one of another game.
    const thumbnail = saver.generation === this.session.generation() ? captured : null;
    for (const png of thumbnail === null ? [null] : [thumbnail, null]) {
      try {
        return { ...saver.save({ thumbnail: png }), generation: saver.generation };
      } catch {
        // Over a cap, or a thumbnail that isn't a PNG: try again without the thumbnail, if there was one.
      }
    }
    return null;
  }

  private markClean(snapshot: Snapshot): void {
    if (snapshot.generation === this.session.generation()) {
      this.clean = { generation: snapshot.generation, hash: snapshot.hash };
    }
  }

  private requireGame(): boolean {
    if (this.session.active()) return true;
    this.notifications.notify('There is no game to save. Start a sandbox or load a game first.');
    return false;
  }

  private error(message: string): void {
    this.notifications.notify(message, { level: 'error' });
  }

  /** Runs writes one at a time, in order; a failed one doesn't stop the next. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function skippedMessage(skipped: readonly { readonly name: string; readonly reason: string }[]): string {
  if (skipped.length === 1) return `Skipped ${quoted(skipped[0].name)}: ${skipped[0].reason}`;
  return `Skipped ${skipped.length} saves that couldn’t be loaded: ${skipped.map((s) => quoted(s.name)).join(', ')}.`;
}
