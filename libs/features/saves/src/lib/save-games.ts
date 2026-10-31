import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { Session, type SessionSaver } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { APP_LIFECYCLE, NotificationService, ShellState } from '@controls/feature-shell';
import { type SaveAsTarget, type SaveEntry, SaveIoError, type SaveName } from '@controls/platform-api';
import { LastPlayedSave } from '@controls/save-format';
import { type LoadedGame, loadGame } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { loadErrorReason, saveIoCodeOf, saveIoReason } from './messages';
import { REPLAY_MISMATCH_POLICY, SAVE_DIALOGS, SAVE_FILES, SaveThumbnails } from './save-io';

/**
 * Restart reasons that mean the log wasn't checked, not that it failed: never refused, an info toast
 * with the scripting API's own message (`ENGINE_CHANGED_MESSAGE`, `TOO_LONG_TO_VERIFY_MESSAGE`).
 */
const UNVERIFIED: ReadonlySet<string> = new Set(['engine-changed', 'too-long-to-verify']);

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

/**
 * The settings pointer for a save-directory entry (ADR 0009, "Continue and the last-played save"):
 * a manual save by name, an autosave by slot. `null` for a file outside the directory, or anything
 * the settings schema wouldn't accept (a writer must never put an invalid document in settings).
 */
export function lastPlayedOf(entry: SaveEntry): LastPlayedSave | null {
  const pointer =
    entry.kind === 'manual'
      ? { kind: 'manual', name: entry.name }
      : entry.kind === 'autosave'
        ? { kind: 'autosave', slot: entry.slot }
        : null;
  const parsed = LastPlayedSave.safeParse(pointer);
  return parsed.success ? parsed.data : null;
}

/** The listing's entry for `pointer`: exact name first, then ignoring case (case-insensitive file systems). */
export function findLastPlayed(entries: readonly SaveEntry[], pointer: LastPlayedSave): SaveEntry | undefined {
  if (pointer.kind === 'autosave') return entries.find((e) => e.kind === 'autosave' && e.slot === pointer.slot);
  const manual = entries.filter((e) => e.kind === 'manual');
  const folded = pointer.name.toLowerCase();
  return manual.find((e) => e.name === pointer.name) ?? manual.find((e) => e.name.toLowerCase() === folded);
}

const pointerName = (pointer: LastPlayedSave) =>
  pointer.kind === 'manual' ? pointer.name : `Autosave ${pointer.slot}`;

const samePointer = (a: LastPlayedSave | null, b: LastPlayedSave | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    (a.kind === 'manual' ? b.kind === 'manual' && a.name === b.name : b.kind === 'autosave' && a.slot === b.slot));

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
 *   another game replaces this one, and before the app quits. Only a game the save directory doesn't
 *   hold as it is now is autosaved (see {@link isDirty}): an untouched new sandbox never takes a slot
 *   from a real game, but a game opened from (or saved to) a file outside the directory is copied in.
 * - **Continue** resumes the game the player was last in: `settings.saves.lastPlayed` names the
 *   save-directory entry that holds it (set on every load from, and write to, the directory for the
 *   game running then), and Continue tries that entry before the rest, newest first.
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
  /**
   * The world hash the save directory holds for this session generation (`Session.generation`);
   * `hash: null` when the game came from a file outside the directory, so the directory has none.
   */
  private stored: { readonly generation: number; readonly hash: string | null } | null = null;
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

  /**
   * Whether the save directory lacks the game as it is now, which is what autosave writes: its world
   * differs from the one last saved to or loaded from the directory (or, for a game never saved
   * there, from its starting world), or it came from a file outside the directory. Saving to a file
   * (Save As) doesn't count: Continue can only resume what the directory holds.
   */
  isDirty(): boolean {
    if (!this.session.active()) return false;
    const generation = this.session.generation();
    const storedHash =
      this.stored?.generation === generation ? this.stored.hash : worldHash(this.session.replayLog().initialWorld);
    return this.session.hash() !== storedHash;
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
      let written: SaveEntry;
      try {
        written = await this.files.write({ kind: 'manual', name, overwrite }, snapshot.bytes);
      } catch (error) {
        this.error(`Couldn’t save ${quoted(name)}. ${saveIoReason(error, 'save')}`);
        return saveIoCodeOf(error) === 'exists' ? 'exists' : 'failed';
      }
      this.markStored(snapshot, written);
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
      // Not stored: the save directory still lacks this state, so autosave copies it in later.
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
      let written: SaveEntry;
      try {
        written = await this.files.write({ kind: 'autosave', slotCount }, snapshot.bytes);
      } catch (error) {
        this.notifications.notify(`Autosave failed. ${saveIoReason(error, 'save')}`, { level: 'warning' });
        return false;
      }
      this.markStored(snapshot, written);
      void this.refresh();
      return true;
    });
  }

  /**
   * Before quit: autosaves unsaved changes (without a thumbnail, to stay inside the host's flush
   * timeout), waits for every write already queued, then flushes settings so the last-played
   * pointer that autosave set is written too (the host runs every flush at once, so the settings
   * store's own flush may already have run). Never rejects.
   */
  flush(): Promise<void> {
    return this.autosave({ thumbnail: false })
      .catch(() => undefined)
      .then(() => this.settings.flush())
      .then(
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
   * Continue: loads the save of the game the player was last in (`settings.saves.lastPlayed`), else
   * the newest save (manual or autosave) that loads. Saves that don't load, and a last-played save
   * that has gone, are skipped with one notification. Resolves `true` if a save was loaded.
   */
  async continueLatest(): Promise<boolean> {
    if (this.loadingState()) return false;
    this.loadingState.set(true);
    try {
      await Promise.all([this.refresh(), this.settings.loaded]);
      const skipped: { readonly name: string; readonly reason: string }[] = [];
      const entries = this.entries();
      const pointer = this.settings.settings().saves.lastPlayed;
      const last = pointer === null ? undefined : findLastPlayed(entries, pointer);
      if (pointer !== null && last === undefined) {
        skipped.push({ name: pointerName(pointer), reason: saveIoReason(new SaveIoError('not-found'), 'load') });
      }
      for (const entry of last === undefined ? entries : [last, ...entries.filter((e) => e !== last)]) {
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
    // A save from another engine version, or one too long to verify, is never refused: its log simply
    // isn't verified (D8, `MAX_VERIFY_TICKS`).
    if (
      loaded.replay.status === 'restarted' &&
      !UNVERIFIED.has(loaded.replay.reason) &&
      this.replayPolicy === 'refuse'
    ) {
      return { ok: false, reason: 'Its replay log doesn’t match its world.' };
    }
    return { ok: true, loaded };
  }

  /** Replaces the session with a checked save (after autosaving unsaved changes in the old one). */
  private async apply(entry: SaveEntry, loaded: LoadedGame): Promise<boolean> {
    // Writes the game being left if the directory lacks it (pointing Continue at that autosave), so
    // nothing is lost; then this load points Continue at the save it loaded.
    await this.autosave();
    this.session.adopt(loaded.game);
    const generation = this.session.generation();
    const external = entry.kind === 'external';
    this.stored = { generation, hash: external ? null : loaded.game.hash() };
    this.named.set(entry.kind === 'manual' ? { generation, name: entry.name } : null);
    // A file from outside the directory has no pointer until autosave copies it in.
    this.setLastPlayed(lastPlayedOf(entry));
    this.notifications.notify(`Loaded ${quoted(entry.name)}.`, { level: 'success' });
    if (loaded.replay.status === 'restarted') {
      const unverified = UNVERIFIED.has(loaded.replay.reason);
      this.notifications.notify(unverified ? loaded.replay.message : REPLAY_RESTARTED_MESSAGE, {
        level: unverified ? 'info' : 'warning',
      });
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

  /**
   * After a write to the save directory: if the snapshot is of the game running now, the directory
   * holds it, and Continue should resume from where it was written. A write of a game that has since
   * been replaced (queued before a New sandbox or a load) changes neither.
   */
  private markStored(snapshot: Snapshot, written: SaveEntry): void {
    if (snapshot.generation !== this.session.generation()) return;
    this.stored = { generation: snapshot.generation, hash: snapshot.hash };
    this.setLastPlayed(lastPlayedOf(written));
  }

  /** Updates `settings.saves.lastPlayed`, only if it changed (loading the same save again writes nothing). */
  private setLastPlayed(lastPlayed: LastPlayedSave | null): void {
    if (samePointer(this.settings.settings().saves.lastPlayed, lastPlayed)) return;
    this.settings.update('saves', { lastPlayed });
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
