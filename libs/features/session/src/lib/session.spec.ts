import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { createWorld } from '@controls/save-format';
import { createGame, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { SANDBOX_LEVEL, Session } from './session';

const crate = { id: 'prop.crate', version: 1 };
const place = { ref: crate, positionMm: { x: 10, y: 0, z: -20 } };

describe('Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts from an empty seed-0 world and exposes it as a signal with its hash', () => {
    const session = TestBed.inject(Session);
    expect(session.world()).toEqual(createWorld({ seed: 0 }));
    expect(session.hash()).toBe(worldHash(createWorld({ seed: 0 })));
    expect(session.entries()).toEqual([]);
  });

  it('changes the world only through exec, and updates the signals', () => {
    const session = TestBed.inject(Session);
    const before = session.hash();
    expect(session.exec('entity.place', place)).toMatchObject({ ok: true, entry: { seq: 0, id: 'entity.place' } });
    expect(session.world().entities.map((e) => e.id)).toEqual([1]);
    expect(session.hash()).not.toBe(before);
    expect(session.canUndo()).toBe(true);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place']);

    expect(session.exec('edit.undo').ok).toBe(true);
    expect(session.hash()).toBe(before);
    expect(session.canRedo()).toBe(true);
  });

  it('returns typed errors for bad commands and changes nothing', () => {
    const session = TestBed.inject(Session);
    const world = session.world();
    expect(session.exec('entity.place', { ref: crate })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(session.exec('no.such')).toMatchObject({ ok: false, error: { kind: 'unknown-command' } });
    expect(session.world()).toBe(world);
    expect(session.entries()).toEqual([]);
  });

  it('runs view commands through onCommand handlers without touching the world hash', () => {
    const session = TestBed.inject(Session);
    session.exec('entity.place', place);
    const hash = session.hash();
    const seen: string[] = [];
    const off = session.onCommand('view.resetLayout', (e) => seen.push(`${e.entry?.seq}`));
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
    expect(session.hash()).toBe(hash);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'view.resetLayout']);
    off();
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
  });

  it('runs onCommand handlers for unlogged UI chrome (palette.open) without logging it', () => {
    const session = TestBed.inject(Session);
    const seen: boolean[] = [];
    const off = session.onCommand('palette.open', (e) => seen.push(e.logged));
    const result = session.exec('palette.open');
    expect(result).toMatchObject({ ok: true, logged: false, entry: null, command: { id: 'palette.open' } });
    expect(seen).toEqual([false]);
    expect(session.entries()).toEqual([]);
    expect(session.replayLog().entries).toEqual([]);
    off();
  });

  it('evaluates when against history and UI context keys', () => {
    const session = TestBed.inject(Session);
    expect(session.isEnabled('edit.undo')).toBe(false);
    session.exec('entity.place', place);
    expect(session.isEnabled('edit.undo')).toBe(true);
    expect(session.isEnabled('edit.redo')).toBe(false);
    session.setContext('mode', 'work');
    expect(session.contextKeys()).toEqual({
      mode: 'work',
      'history.canUndo': true,
      'history.canRedo': false,
      'session.active': false,
    });
    session.setContext('mode', null);
    expect(session.contextKeys()).toEqual({
      'history.canUndo': true,
      'history.canRedo': false,
      'session.active': false,
    });
  });

  it('registers the unlogged file commands, offering saves only while a game is in progress (F1.8b)', () => {
    const session = TestBed.inject(Session);
    expect(['file.save', 'file.saveAs', 'file.open', 'file.load'].every((id) => session.registry.has(id))).toBe(true);
    expect(session.active()).toBe(false);
    expect(session.isEnabled('file.save')).toBe(false);
    expect(session.isEnabled('file.load')).toBe(true);
    session.newSandbox({ seed: 1 });
    expect(session.active()).toBe(true);
    expect(session.isEnabled('file.save')).toBe(true);
    const seen: string[] = [];
    session.onCommand('file.save', (e) => seen.push(e.command.id));
    expect(session.exec('file.save')).toMatchObject({ ok: true, logged: false });
    expect(seen).toEqual(['file.save']);
    expect(session.entries()).toEqual([]);
  });

  it('saves to .ctrl bytes and adopts a loaded game: same world, cleared history, the log continued (F1.8b)', () => {
    const session = TestBed.inject(Session);
    session.newSandbox({ seed: 9 });
    session.exec('entity.place', place);
    session.exec('entity.place', { ...place, positionMm: { x: 30, y: 0, z: -20 } });
    session.exec('edit.undo');
    const hash = session.hash();
    const bytes = session.save();

    session.newSandbox({ seed: 10 });
    expect(session.hash()).not.toBe(hash);
    const generation = session.generation();
    const loaded = loadGame(bytes, { registry: session.registry });
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toEqual({ status: 'continued' });
    session.adopt(loaded.game);
    expect(session.hash()).toBe(hash);
    expect(session.generation()).toBe(generation + 1);
    expect(session.active()).toBe(true);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
    expect(session.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(session.exec('entity.delete', { id: 1 })).toMatchObject({ ok: true, entry: { seq: 3 } });
    expect(session.entries()).toHaveLength(4);
    const replayed = replayGame(JSON.parse(JSON.stringify(session.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(session.hash());

    // A game on another registry would lose the file commands (and any host command): refused.
    const foreign = loadGame(bytes);
    expect(() => session.adopt(foreign.ok ? foreign.game : createGame({ seed: 0 }))).toThrow(/registry/);
  });

  it('starts a new session with a fresh history and log, and writes a replay log', () => {
    const session = TestBed.inject(Session);
    session.exec('entity.place', place);
    const world = createWorld({ seed: 77 });
    session.start(world);
    expect(session.world()).toBe(world);
    expect(session.canUndo()).toBe(false);
    expect(session.entries()).toEqual([]);
    session.exec('entity.place', place);
    expect(session.replayLog()).toMatchObject({ schemaVersion: 2, initialWorld: world, entries: [{ seq: 0 }] });
  });

  it('runs the same code as a scripting-api game: same console lines, same hash, same replay log', () => {
    const session = TestBed.inject(Session);
    const game = createGame({ seed: 0 });
    const script = [
      'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 10 --positionMm.y 0 --positionMm.z -20',
      'entity.move 1 --positionMm.x 11 --positionMm.y 0 --positionMm.z -20',
      'view.resetLayout',
      'entity.delete 1',
      'edit.undo',
    ].join('\n');
    expect(runConsoleScript(session, script)).toMatchObject({ ok: true, executed: 5 });
    expect(runConsoleScript(game, script)).toMatchObject({ ok: true, executed: 5 });
    expect(session.hash()).toBe(game.hash());
    expect(session.replayLog()).toEqual(game.replayLog());
    const replayed = replayGame(JSON.parse(JSON.stringify(session.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(session.hash());
    // The session's world is the game's frozen snapshot.
    expect(Object.isFrozen(session.world())).toBe(true);
  });

  describe('the sandbox level (F1.9)', () => {
    const bench = {
      id: 'bench',
      ref: { id: 'prop.bench', version: 1 },
      transform: { positionMm: { x: 700, y: -1200, z: 80 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      extensions: {},
    };
    const level = { ...createWorld({ seed: 0 }), fixtures: [bench] };
    const withLevel = (json: unknown) => {
      TestBed.configureTestingModule({ providers: [{ provide: SANDBOX_LEVEL, useValue: json }] });
      return TestBed.inject(Session);
    };

    it('shows the level behind the menu, and New sandbox starts a game on it with a fresh history and log', () => {
      const session = withLevel(JSON.parse(JSON.stringify(level)));
      expect(session.world()).toEqual(level);
      expect(session.generation()).toBe(1);
      session.exec('entity.place', place);
      expect(session.canUndo()).toBe(true);

      session.newSandbox({ seed: 4_294_967_295, difficulty: 'realistic' });
      expect(session.world()).toEqual({ ...level, seed: 4_294_967_295, difficulty: 'realistic' });
      expect(session.world().fixtures).toEqual([bench]);
      expect(session.entries()).toEqual([]);
      expect(session.canUndo()).toBe(false);
      expect(session.replayLog().initialWorld.seed).toBe(4_294_967_295);
      expect(session.generation()).toBe(2);

      // The same seed is the same world, so the same hash (a typed seed reproduces a session).
      const first = session.hash();
      session.newSandbox({ seed: 4_294_967_295, difficulty: 'realistic' });
      expect(session.hash()).toBe(first);
      expect(() => session.newSandbox({ seed: -1 })).toThrow();
    });

    it('falls back to an empty world (and says so) when the level does not load', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const session = withLevel({ schemaVersion: 1, fixtures: 'nope' });
      expect(session.world()).toEqual(createWorld({ seed: 0 }));
      expect(error).toHaveBeenCalledOnce();
      session.newSandbox({ seed: 3 });
      expect(session.world()).toEqual(createWorld({ seed: 3 }));
    });
  });

  it('exposes the test hook only with ?e2e=1', () => {
    const fakeWindow: Record<string, unknown> = { location: { search: '?e2e=1' } };
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: fakeWindow } }],
    });
    TestBed.inject(Session);
    const hook = fakeWindow['__controlsSession'] as {
      exec(id: string, args?: unknown): { ok: boolean };
      hash(): string;
      world(): unknown;
      entries(): unknown[];
      hashWorld(json: unknown): string | null;
    };
    expect(hook.exec('entity.place', place).ok).toBe(true);
    expect(hook.entries()).toHaveLength(1);
    expect(hook.hash()).toBe(worldHash(hook.world() as ReturnType<typeof createWorld>));
    expect(hook.hashWorld(createWorld({ seed: 0 }))).toBe(worldHash(createWorld({ seed: 0 })));
    expect(hook.hashWorld({ schemaVersion: 1 })).toBeNull();
    TestBed.resetTestingModule();
    expect(fakeWindow['__controlsSession']).toBeUndefined();

    TestBed.inject(Session);
    expect((window as unknown as Record<string, unknown>)['__controlsSession']).toBeUndefined();
  });
});
