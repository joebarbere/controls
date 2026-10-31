import { TestBed } from '@angular/core/testing';
import { Session } from '@controls/feature-session';
import { MemorySettingsService, SETTINGS_SERVICE, SettingsStore } from '@controls/feature-settings';
import { APP_LIFECYCLE, NotificationService, ShellState } from '@controls/feature-shell';
import type { PendingWritesFlush, SaveEntry } from '@controls/platform-api';
import { createWorld, defaultSettings, readCtrl, writeCtrl } from '@controls/save-format';
import { createGame, createSaveManifest, loadGame } from '@controls/scripting-api';
import { MemorySaveIo } from '../testing/memory-save-io';
import { REPLAY_MISMATCH_POLICY, type ReplayMismatchPolicy, SAVE_DIALOGS, SAVE_FILES, SaveThumbnails } from './save-io';
import {
  ENGINE_CHANGED_MESSAGE,
  findLastPlayed,
  lastPlayedOf,
  REPLAY_RESTARTED_MESSAGE,
  SaveGames,
  suggestedSaveName,
} from './save-games';

const crate = { id: 'prop.crate', version: 1 };
const place = (x: number) => ({ ref: crate, positionMm: { x, y: 0, z: -20 } });
/** A 1×1 PNG: the signature is what `writeCtrl` checks. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A save written by another session of this build: seed 5 with two crates. */
function otherSave(): { bytes: Uint8Array; hash: string } {
  const game = createGame({ seed: 5 });
  game.exec('entity.place', place(10));
  game.exec('entity.place', place(40));
  return { bytes: game.save(), hash: game.hash() };
}

function setup(options: { policy?: ReplayMismatchPolicy; io?: MemorySaveIo; settings?: MemorySettingsService } = {}) {
  const io = options.io ?? new MemorySaveIo();
  const settingsService = options.settings ?? new MemorySettingsService();
  const flushes = new Set<PendingWritesFlush>();
  TestBed.configureTestingModule({
    providers: [
      { provide: SETTINGS_SERVICE, useValue: settingsService },
      { provide: SAVE_FILES, useValue: io.files },
      { provide: SAVE_DIALOGS, useValue: io.dialogs },
      { provide: REPLAY_MISMATCH_POLICY, useValue: options.policy ?? 'notify' },
      {
        provide: APP_LIFECYCLE,
        useValue: { onBeforeQuit: (f: PendingWritesFlush) => (flushes.add(f), () => flushes.delete(f)) },
      },
    ],
  });
  const saves = TestBed.inject(SaveGames);
  const session = TestBed.inject(Session);
  const toasts = () =>
    TestBed.inject(NotificationService)
      .toasts()
      .map((t) => `${t.level}: ${t.message}`);
  /** Quits (runs every flush, as the host does: all at once) and starts the app again on the same storage. */
  const relaunch = async () => {
    await Promise.all([...flushes].map((flush) => flush()));
    TestBed.resetTestingModule();
    io.relaunch();
    const next = setup({ ...options, io, settings: settingsService });
    await Promise.all([next.saves.ready, TestBed.inject(SettingsStore).loaded]);
    return next;
  };
  /** The last-played pointer as stored (what the next launch reads). */
  const storedPointer = async () => (await settingsService.load()).settings.saves.lastPlayed;
  return { io, saves, session, flushes, toasts, shell: TestBed.inject(ShellState), relaunch, storedPointer };
}

/** A different game from {@link otherSave}: seed 7 with one crate. */
function thirdSave(): { bytes: Uint8Array; hash: string } {
  const game = createGame({ seed: 7 });
  game.exec('entity.place', place(70));
  return { bytes: game.save(), hash: game.hash() };
}

const hashOf = (bytes: Uint8Array | undefined) => {
  const loaded = loadGame(bytes ?? new Uint8Array());
  return loaded.ok ? loaded.game.hash() : 'unloadable';
};

describe('SaveGames', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('lists the save directory at start-up; Continue needs a save', async () => {
    const io = new MemorySaveIo();
    const { saves } = setup({ io });
    await saves.ready;
    expect(saves.canContinue()).toBe(false);
    io.seed({ kind: 'manual', name: 'Shop' }, otherSave().bytes);
    await saves.refresh();
    expect(saves.saves().map((e) => e.name)).toEqual(['Shop']);
    expect(saves.canContinue()).toBe(true);
  });

  it('file.save asks for a name first, then saves under it without asking again', async () => {
    const { io, saves, session, shell, toasts } = setup();
    session.newSandbox({ seed: 3 });
    session.exec('file.save');
    expect(shell.dialog()).toBe('save'); // no name yet: the Save game dialog
    expect(io.calls).not.toContain('write');

    expect(await saves.saveNamed('Shop', false)).toBe('saved');
    expect(saves.saveName()).toBe('Shop');
    expect(toasts()).toContain('success: Saved “Shop”.');
    expect(saves.isDirty()).toBe(false);
    expect(io.names()).toEqual(['Shop']);

    session.exec('entity.place', place(10));
    shell.closeDialog();
    expect(session.exec('file.save')).toMatchObject({ ok: true, logged: false });
    await vi.waitFor(() => expect(saves.isDirty()).toBe(false));
    expect(shell.dialog()).toBeNull();
    expect(io.names()).toEqual(['Shop']); // overwritten, not a second save
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place']); // file.save is never logged
  });

  it('refuses to replace another save unless asked, and reports platform failures without detail', async () => {
    const { io, saves, session, toasts } = setup();
    io.seed({ kind: 'manual', name: 'Shop' }, otherSave().bytes);
    session.newSandbox({ seed: 3 });
    expect(await saves.saveNamed('Shop', false)).toBe('exists');
    expect(toasts().at(-1)).toBe('error: Couldn’t save “Shop”. A save with that name already exists.');
    expect(await saves.saveNamed('Shop', true)).toBe('saved');

    io.failNext('write', 'io');
    expect(await saves.saveNamed('Other', false)).toBe('failed');
    expect(toasts().at(-1)).toBe('error: Couldn’t save “Other”. The file couldn’t be written.');
  });

  it('saves nothing without a game in progress', async () => {
    const { io, saves, session, toasts } = setup();
    session.exec('file.save');
    expect(await saves.saveToFile()).toBeNull();
    expect(io.calls).toEqual(['list']);
    expect(toasts()).toContain('info: There is no game to save. Start a sandbox or load a game first.');
  });

  it('loads a save: the world, a cleared history, the log continued, its name, then enters the game', async () => {
    const io = new MemorySaveIo();
    const other = otherSave();
    const entry = io.seed({ kind: 'manual', name: 'Shop' }, other.bytes);
    const { saves, session, toasts } = setup({ io });
    const entered = vi.fn();
    saves.onLoaded(entered);
    expect(await saves.load(entry)).toBe(true);
    expect(session.hash()).toBe(other.hash);
    expect(session.active()).toBe(true);
    expect(session.canUndo()).toBe(false);
    expect(session.entries().map((e) => e.seq)).toEqual([0, 1]);
    expect(saves.saveName()).toBe('Shop');
    expect(saves.isDirty()).toBe(false);
    expect(entered).toHaveBeenCalledOnce();
    expect(toasts()).toEqual(['success: Loaded “Shop”.']);
    expect(session.exec('entity.delete', { id: 1 })).toMatchObject({ ok: true, entry: { seq: 2 } });
    expect(saves.isDirty()).toBe(true);
  });

  it('leaves the session alone when a save does not load, and never echoes its content', async () => {
    const io = new MemorySaveIo();
    const junk = new TextEncoder().encode('PK\u0003\u0004 do-not-echo <script>');
    const bad = io.seed({ kind: 'manual', name: 'Broken' }, junk);
    const { saves, session, toasts } = setup({ io });
    session.newSandbox({ seed: 3 });
    session.exec('entity.place', place(10));
    const hash = session.hash();
    expect(await saves.load(bad)).toBe(false);
    expect(session.hash()).toBe(hash);
    expect(session.canUndo()).toBe(true);
    expect(toasts()).toEqual(['error: Couldn’t load “Broken”. The save is damaged, or it isn’t a Controls save.']);
    expect(toasts().join()).not.toContain('do-not-echo');
  });

  it('loads a save whose replay log does not match its world with a notice, or refuses it by policy', async () => {
    const world = { ...createWorld({ seed: 8 }) };
    const otherLog = createGame({ seed: 9 }).replayLog();
    const mismatched = writeCtrl({ manifest: createSaveManifest(), world, replayLog: otherLog, thumbnail: null });

    const notify = setup();
    const entry = notify.io.seed({ kind: 'manual', name: 'Odd' }, mismatched);
    expect(await notify.saves.load(entry)).toBe(true);
    expect(notify.session.world().seed).toBe(8);
    expect(notify.session.replayLog().initialWorld.seed).toBe(8); // a new log, from the loaded world
    expect(notify.toasts()).toEqual(['success: Loaded “Odd”.', `warning: ${REPLAY_RESTARTED_MESSAGE}`]);
    TestBed.resetTestingModule();

    const refuse = setup({ policy: 'refuse' });
    const again = refuse.io.seed({ kind: 'manual', name: 'Odd' }, mismatched);
    expect(await refuse.saves.load(again)).toBe(false);
    expect(refuse.session.active()).toBe(false);
    expect(refuse.toasts()).toEqual(['error: Couldn’t load “Odd”. Its replay log doesn’t match its world.']);
  });

  it('loads a save from another sim engine with a notice, never refusing it, even by policy (D8)', async () => {
    const world = { ...createWorld({ seed: 8 }) };
    const otherLog = createGame({ seed: 9 }).replayLog(); // it wouldn't verify, and isn't checked
    const manifest = { ...createSaveManifest(), simEngineVersion: 1 };
    const older = writeCtrl({ manifest, world, replayLog: otherLog, thumbnail: null });
    const refuse = setup({ policy: 'refuse' });
    const entry = refuse.io.seed({ kind: 'manual', name: 'Old engine' }, older);
    expect(await refuse.saves.load(entry)).toBe(true);
    expect(refuse.session.world().seed).toBe(8);
    expect(refuse.toasts()).toEqual(['success: Loaded “Old engine”.', `info: ${ENGINE_CHANGED_MESSAGE}`]);
  });

  it('Continue loads the newest save that loads, skipping damaged ones with one warning', async () => {
    const io = new MemorySaveIo();
    const good = otherSave();
    io.seed({ kind: 'manual', name: 'Older' }, createGame({ seed: 1 }).save());
    io.seed({ kind: 'autosave', name: 'Autosave 1', slot: 1 }, good.bytes);
    io.seed({ kind: 'autosave', name: 'Autosave 2', slot: 2 }, new Uint8Array([1, 2, 3]));
    const { saves, session, toasts } = setup({ io });
    expect(await saves.continueLatest()).toBe(true);
    expect(session.hash()).toBe(good.hash);
    expect(saves.saveName()).toBeNull(); // an autosave gives the game no save name
    expect(toasts()).toEqual([
      'warning: Skipped “Autosave 2”: The save is damaged, or it isn’t a Controls save.',
      'success: Loaded “Autosave 1”.',
    ]);
  });

  it('Continue says so when there is nothing to continue, or nothing loads', async () => {
    const io = new MemorySaveIo();
    const { saves, toasts } = setup({ io });
    expect(await saves.continueLatest()).toBe(false);
    io.seed({ kind: 'manual', name: 'A' }, new Uint8Array([1]));
    io.seed({ kind: 'manual', name: 'B' }, new Uint8Array([2]));
    expect(await saves.continueLatest()).toBe(false);
    expect(toasts()).toEqual([
      'info: There are no saved games to continue.',
      'error: None of your saves could be loaded. Skipped 2 saves that couldn’t be loaded: “B”, “A”.',
    ]);
  });

  it('autosaves only a game with unsaved changes, and only when enabled', async () => {
    const { io, saves, session } = setup();
    session.newSandbox({ seed: 3 });
    expect(await saves.autosave()).toBe(false); // an untouched new sandbox never takes a slot
    session.exec('entity.place', place(10));
    session.exec('view.resetLayout'); // view commands don't change the world
    expect(await saves.autosave()).toBe(true);
    expect(io.names()).toEqual(['Autosave 1']);
    expect(await saves.autosave()).toBe(false); // nothing new since
    session.exec('entity.place', place(20));
    session.exec('edit.undo');
    expect(await saves.autosave()).toBe(false); // back where the autosave left it

    session.exec('entity.place', place(30));
    TestBed.inject(SettingsStore).update('autosave', { enabled: false });
    expect(await saves.autosave()).toBe(false);
    TestBed.inject(SettingsStore).update('autosave', { enabled: true, slotCount: 2 });
    expect(await saves.autosave()).toBe(true);
    expect(io.names().sort()).toEqual(['Autosave 1', 'Autosave 2']);
  });

  it('a failed autosave warns and keeps the changes unsaved', async () => {
    const { io, saves, session, toasts } = setup();
    session.newSandbox({ seed: 3 });
    session.exec('entity.place', place(10));
    io.failNext('write', 'unavailable');
    expect(await saves.autosave()).toBe(false);
    expect(toasts()).toEqual([
      'warning: Autosave failed. Saving isn’t available here: this browser gives the game no storage.',
    ]);
    expect(saves.isDirty()).toBe(true);
  });

  it('autosaves on the settings interval while a game is in progress', async () => {
    vi.useFakeTimers();
    const { io, session } = setup();
    TestBed.inject(SettingsStore).update('autosave', { intervalSeconds: 60 });
    session.newSandbox({ seed: 3 });
    TestBed.tick(); // runs the timer effect
    session.exec('entity.place', place(10));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(io.calls).not.toContain('write');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.names()).toEqual(['Autosave 1']);
  });

  it('autosaves before quitting, and before another save replaces the game', async () => {
    const io = new MemorySaveIo();
    const other = io.seed({ kind: 'manual', name: 'Shop' }, otherSave().bytes);
    const { saves, session, flushes } = setup({ io });
    session.newSandbox({ seed: 3 });
    session.exec('entity.place', place(10));
    await Promise.all([...flushes].map((flush) => flush())); // SettingsStore's and ours
    expect(io.names()).toContain('Autosave 1');

    session.exec('entity.place', place(20));
    const before = session.hash();
    expect(await saves.load(other)).toBe(true);
    expect(io.names()).toContain('Autosave 2');
    const slot = loadGame(io.bytesOf('Autosave 2') ?? new Uint8Array()); // the game the load replaced
    expect(slot.ok && slot.game.hash()).toBe(before);
  });

  it('saves to a picked file (Save As) and opens one (Open)', async () => {
    const { io, saves, session, toasts } = setup();
    session.newSandbox({ seed: 3 });
    io.nextSaveAs(null);
    expect(await saves.saveToFile()).toBeNull(); // cancelled
    io.nextSaveAs('mine.ctrl');
    TestBed.inject(SaveThumbnails).register(async () => PNG);
    expect(await saves.saveToFile()).toBe('saved');
    expect(io.savedAs.map((s) => s.name)).toEqual(['mine.ctrl']);
    expect(toasts()).toContain('success: Saved to “mine.ctrl”.');

    const other = otherSave();
    io.nextOpen({ name: 'shared.ctrl', bytes: other.bytes });
    session.exec('file.open');
    await vi.waitFor(() => expect(session.hash()).toBe(other.hash));
    expect(saves.saveName()).toBeNull(); // an opened file isn't in the save directory
    io.nextOpen(null);
    expect(await saves.openFile()).toBe(false);
  });

  it('includes the thumbnail when it can, and saves without one when it is not a PNG', async () => {
    const { io, saves, session } = setup();
    session.newSandbox({ seed: 3 });
    const off = TestBed.inject(SaveThumbnails).register(async () => PNG);
    await saves.saveNamed('With', false);
    off();
    TestBed.inject(SaveThumbnails).register(async () => new Uint8Array([1, 2, 3]));
    await saves.saveNamed('Without', false);
    const read = (name: string) => {
      const r = readCtrl(io.bytesOf(name) ?? new Uint8Array());
      return r.ok ? r.value.thumbnail : 'unreadable';
    };
    expect(read('With')).toEqual(PNG);
    expect(read('Without')).toBeNull();
  });

  it('file.load lists the saves again and opens the Load game dialog', async () => {
    const { io, session, shell, saves } = setup();
    await saves.ready;
    io.seed({ kind: 'manual', name: 'Shop' }, otherSave().bytes);
    session.exec('file.load');
    await vi.waitFor(() => expect(shell.dialog()).toBe('load'));
    expect(saves.saves().map((e) => e.name)).toEqual(['Shop']);
  });

  it('suggests a valid save name from the seed', () => {
    expect(suggestedSaveName(4_294_967_295)).toBe('Sandbox 4294967295');
  });
});

/** The listed save named `name` (fails the test if there is none). */
function entryNamed(saves: SaveGames, name: string): SaveEntry {
  const entry = saves.saves().find((e) => e.name === name);
  if (!entry) throw new Error(`no save named ${name}`);
  return entry;
}

describe('Continue resumes the game the player was last in (settings.saves.lastPlayed)', () => {
  afterEach(() => TestBed.resetTestingModule());
  const pointer = () => TestBed.inject(SettingsStore).settings().saves.lastPlayed;

  it('after loading X over unsaved changes in A, A is autosaved but Continue resumes X', async () => {
    const io = new MemorySaveIo();
    const x = otherSave();
    io.seed({ kind: 'manual', name: 'X' }, x.bytes);
    const first = setup({ io });
    await first.saves.ready;
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    const a = first.session.hash();

    expect(await first.saves.load(entryNamed(first.saves, 'X'))).toBe(true);
    expect(hashOf(io.bytesOf('Autosave 1'))).toBe(a); // A was written before X replaced it
    expect(pointer()).toEqual({ kind: 'manual', name: 'X' });

    const next = await first.relaunch(); // quit without changing X: nothing more is written
    expect(next.saves.saves().map((e) => e.name)).toEqual(['Autosave 1', 'X']); // A's autosave is newest
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(x.hash);
    expect(next.saves.saveName()).toBe('X');
    expect(next.toasts()).toEqual(['success: Loaded “X”.']);
  });

  it('a file opened from outside the directory is copied in when left, and Continue resumes it', async () => {
    const io = new MemorySaveIo();
    const first = setup({ io });
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    const a = first.session.hash();
    const x = otherSave();
    io.nextOpen({ name: 'shared.ctrl', bytes: x.bytes });
    expect(await first.saves.openFile()).toBe(true);
    expect(hashOf(io.bytesOf('Autosave 1'))).toBe(a);
    expect(pointer()).toBeNull(); // an opened file's handle doesn't outlive the launch
    expect(first.saves.isDirty()).toBe(true); // the directory doesn't hold X

    const next = await first.relaunch(); // the quit flush autosaves X, then writes the pointer
    expect(hashOf(io.bytesOf('Autosave 2'))).toBe(x.hash);
    expect(await first.storedPointer()).toEqual({ kind: 'autosave', slot: 2 });
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(x.hash);
  });

  it('a game saved only to a file (Save As) is still autosaved into the directory for Continue', async () => {
    const first = setup();
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    const hash = first.session.hash();
    first.io.nextSaveAs('mine.ctrl');
    expect(await first.saves.saveToFile()).toBe('saved');
    expect(first.saves.isDirty()).toBe(true);

    const next = await first.relaunch();
    expect(hashOf(first.io.bytesOf('Autosave 1'))).toBe(hash);
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(hash);
  });

  it('a last-played save that no longer loads is skipped with the warning, and the newest that loads is used', async () => {
    const io = new MemorySaveIo();
    io.seed({ kind: 'manual', name: 'X' }, otherSave().bytes);
    const first = setup({ io });
    await first.saves.ready;
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    const a = first.session.hash();
    expect(await first.saves.load(entryNamed(first.saves, 'X'))).toBe(true);
    io.corrupt('X', new Uint8Array([1, 2, 3]));

    const next = await first.relaunch();
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(a);
    expect(next.toasts()).toEqual([
      'warning: Skipped “X”: The save is damaged, or it isn’t a Controls save.',
      'success: Loaded “Autosave 1”.',
    ]);
  });

  it('a last-played save that has been deleted is named in the warning, and the newest save loads', async () => {
    const io = new MemorySaveIo();
    const x = otherSave();
    io.seed({ kind: 'autosave', name: 'Autosave 1', slot: 1 }, x.bytes);
    const settings = new MemorySettingsService({
      ...defaultSettings(),
      saves: { lastPlayed: { kind: 'manual', name: 'Gone' } },
    });
    const { saves, session, toasts } = setup({ io, settings });
    expect(await saves.continueLatest()).toBe(true);
    expect(session.hash()).toBe(x.hash);
    expect(toasts()).toEqual([
      'warning: Skipped “Gone”: The save isn’t there any more.',
      'success: Loaded “Autosave 1”.',
    ]);
    expect(pointer()).toEqual({ kind: 'autosave', slot: 1 });
  });

  it('the pointer follows autosave rotation, so the slot it names holds the game last played', async () => {
    const io = new MemorySaveIo();
    const y = thirdSave();
    io.seed({ kind: 'manual', name: 'Y' }, y.bytes);
    const first = setup({ io });
    await first.saves.ready;
    TestBed.inject(SettingsStore).update('autosave', { slotCount: 2 });
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    expect(await first.saves.autosave()).toBe(true); // game X → slot 1
    expect(pointer()).toEqual({ kind: 'autosave', slot: 1 });

    expect(await first.saves.load(entryNamed(first.saves, 'Y'))).toBe(true); // X is stored: no autosave
    expect(io.names().sort()).toEqual(['Autosave 1', 'Y']);
    first.session.exec('entity.place', place(20));
    expect(await first.saves.autosave()).toBe(true); // Y → slot 2
    first.session.exec('entity.place', place(30));
    expect(await first.saves.autosave()).toBe(true); // Y → slot 1, X's autosave rotated out
    const latest = first.session.hash();
    expect(pointer()).toEqual({ kind: 'autosave', slot: 1 });

    const next = await first.relaunch();
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(latest);
  });

  it('a manual save followed by more play and an autosave: Continue resumes the autosave', async () => {
    const first = setup();
    first.session.newSandbox({ seed: 3 });
    first.session.exec('entity.place', place(10));
    expect(await first.saves.saveNamed('Shop', false)).toBe('saved');
    expect(pointer()).toEqual({ kind: 'manual', name: 'Shop' });
    first.session.exec('entity.place', place(20));
    expect(await first.saves.autosave()).toBe(true);
    const later = first.session.hash();
    expect(pointer()).toEqual({ kind: 'autosave', slot: 1 });

    const next = await first.relaunch();
    expect(await next.saves.continueLatest()).toBe(true);
    expect(next.session.hash()).toBe(later);
  });

  it('a write of a game that a New sandbox has since replaced does not move the pointer', async () => {
    const { saves, session } = setup();
    let release: (png: null) => void = () => undefined;
    const gate = new Promise<null>((resolve) => (release = resolve));
    TestBed.inject(SaveThumbnails).register(() => gate);
    session.newSandbox({ seed: 3 });
    session.exec('entity.place', place(10));
    const writing = saves.autosave(); // waits for the thumbnail
    session.newSandbox({ seed: 4 });
    release(null);
    expect(await writing).toBe(true);
    expect(pointer()).toBeNull();
  });

  it('points at manual saves by name and autosaves by slot, never at a file outside the directory', () => {
    const entry = (e: Partial<SaveEntry>): SaveEntry => ({
      handle: 'h',
      name: 'Shop',
      kind: 'manual',
      slot: null,
      modifiedMs: 0,
      sizeBytes: 1,
      ...e,
    });
    expect(lastPlayedOf(entry({}))).toEqual({ kind: 'manual', name: 'Shop' });
    expect(lastPlayedOf(entry({ kind: 'autosave', name: 'Autosave 2', slot: 2 }))).toEqual({
      kind: 'autosave',
      slot: 2,
    });
    expect(lastPlayedOf(entry({ kind: 'external', name: 'shared.ctrl' }))).toBeNull();
    expect(lastPlayedOf(entry({ kind: 'autosave', name: 'Autosave 15', slot: 15 }))).toBeNull(); // outside settings

    const list = [
      entry({ name: 'shop', handle: 'a' }),
      entry({ name: 'Shop', handle: 'b' }),
      entry({ kind: 'autosave', name: 'Autosave 1', slot: 1, handle: 'c' }),
    ];
    expect(findLastPlayed(list, { kind: 'manual', name: 'Shop' })?.handle).toBe('b'); // exact name first
    expect(findLastPlayed(list, { kind: 'manual', name: 'SHOP' })?.handle).toBe('a'); // then ignoring case
    expect(findLastPlayed(list, { kind: 'autosave', slot: 1 })?.handle).toBe('c');
    expect(findLastPlayed(list, { kind: 'autosave', slot: 2 })).toBeUndefined();
  });
});
