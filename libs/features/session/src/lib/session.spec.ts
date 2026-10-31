import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { createWorld } from '@controls/save-format';
import { createGame, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { worldHash } from '@controls/world-model';
import { FakeSimWorker } from '../testing/fake-sim-worker';
import { SANDBOX_LEVEL, Session } from './session';
import { SIM_TRANSPORT, SIM_WORKER_FACTORY } from './sim-host';

const crate = { id: 'prop.crate', version: 1 };
const place = { ref: crate, positionMm: { x: 10, y: 0, z: -20 } };

/** A session with a fake sim worker (the real engine, on this thread) through the factory token. */
function withWorker(providers: unknown[] = []) {
  const fakes = FakeSimWorker.factory();
  TestBed.configureTestingModule({
    providers: [
      { provide: SIM_WORKER_FACTORY, useValue: fakes.factory },
      { provide: SIM_TRANSPORT, useValue: 'message' },
      ...(providers as never[]),
    ],
  });
  return { session: TestBed.inject(Session), fakes };
}

describe('Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts from an empty seed-0 world behind the menu, with no worker, and hashes it as it is', async () => {
    const { session, fakes } = withWorker();
    expect(session.world()).toEqual(createWorld({ seed: 0 }));
    expect(await session.hashAt()).toBe(worldHash(createWorld({ seed: 0 })));
    expect(session.entries()).toEqual([]);
    expect(fakes.workers).toEqual([]); // the menu backdrop has no worker (ADR 0011 §10)
    expect(session.sim.status()).toBe('none');
  });

  it('changes the world only through exec, and updates the signals', async () => {
    const { session } = withWorker();
    session.newSandbox({ seed: 0 });
    const before = await session.hashAt();
    expect(session.exec('entity.place', place)).toMatchObject({ ok: true, entry: { seq: 0, id: 'entity.place' } });
    expect(session.world().entities.map((e) => e.id)).toEqual([1]);
    expect(await session.hashAt()).not.toBe(before);
    expect(session.canUndo()).toBe(true);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place']);

    expect(session.exec('edit.undo').ok).toBe(true);
    expect(await session.hashAt()).toBe(before);
    expect(session.canRedo()).toBe(true);
  });

  it('returns typed errors for bad commands and changes nothing', () => {
    const { session } = withWorker();
    const world = session.world();
    expect(session.exec('entity.place', { ref: crate })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(session.exec('no.such')).toMatchObject({ ok: false, error: { kind: 'unknown-command' } });
    expect(session.world()).toBe(world);
    expect(session.entries()).toEqual([]);
  });

  it('runs view commands through onCommand handlers without touching the world hash', async () => {
    const { session } = withWorker();
    session.newSandbox({ seed: 0 });
    session.exec('entity.place', place);
    const hash = await session.hashAt();
    const seen: string[] = [];
    const off = session.onCommand('view.resetLayout', (e) => seen.push(`${e.entry?.seq}`));
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
    expect(await session.hashAt()).toBe(hash);
    expect(session.entries().map((e) => e.id)).toEqual(['entity.place', 'view.resetLayout']);
    off();
    session.exec('view.resetLayout');
    expect(seen).toEqual(['1']);
  });

  it('runs onCommand handlers for unlogged UI chrome (palette.open) without logging it', () => {
    const { session } = withWorker();
    const seen: boolean[] = [];
    const off = session.onCommand('palette.open', (e) => seen.push(e.logged));
    const result = session.exec('palette.open');
    expect(result).toMatchObject({ ok: true, logged: false, entry: null, command: { id: 'palette.open' } });
    expect(seen).toEqual([false]);
    expect(session.entries()).toEqual([]);
    expect(session.replayLog().entries).toEqual([]);
    off();
  });

  it('evaluates when against history, UI and sim context keys', () => {
    const { session } = withWorker();
    expect(session.isEnabled('edit.undo')).toBe(false);
    session.exec('entity.place', place);
    expect(session.isEnabled('edit.undo')).toBe(true);
    expect(session.isEnabled('edit.redo')).toBe(false);
    session.setContext('mode', 'work');
    const sim = { 'sim.status': 'none', 'sim.paused': true, 'sim.speed': 0 };
    const base = { 'history.canUndo': true, 'history.canRedo': false, 'session.active': false, ...sim };
    expect(session.contextKeys()).toEqual({ mode: 'work', ...base });
    session.setContext('mode', null);
    expect(session.contextKeys()).toEqual(base);
  });

  it('publishes the sim context keys, and sim.restart restarts a crashed worker from the log', async () => {
    const { session, fakes } = withWorker();
    session.newSandbox({ seed: 2 });
    await vi.waitFor(() => expect(session.contextKeys()['sim.status']).toBe('paused'));
    session.exec('sim.setSpeed', { speed: 10 });
    expect(session.contextKeys()).toMatchObject({ 'sim.status': 'running', 'sim.paused': false, 'sim.speed': 10 });
    session.exec('sim.setSpeed', { speed: 0 });
    expect(session.isEnabled('sim.restart')).toBe(false);
    session.exec('sim.step', { ticks: 30 });
    fakes.workers[0].crash();
    await vi.waitFor(() => expect(session.sim.status()).toBe('crashed'));
    expect(session.isEnabled('sim.restart')).toBe(true);
    expect(session.exec('sim.restart')).toMatchObject({ ok: true, logged: false });
    expect(fakes.workers[1].received[0]).toMatchObject({ start: { kind: 'replay', log: { endTick: 30 } } });
    await vi.waitFor(() => expect(session.sim.status()).toBe('paused'));
    expect(session.entries().map((e) => e.id)).toEqual(['sim.setSpeed', 'sim.setSpeed', 'sim.step']);
  });

  it('registers the unlogged file commands, offering saves only while a game is in progress (F1.8b)', () => {
    const { session } = withWorker();
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

  it('saves to .ctrl bytes and adopts a checked save: same world, cleared history, the log continued, its worker carrying on', async () => {
    const { session, fakes } = withWorker();
    session.newSandbox({ seed: 9 });
    session.exec('entity.place', place);
    session.exec('entity.place', { ...place, positionMm: { x: 30, y: 0, z: -20 } });
    session.exec('edit.undo');
    const hash = await session.hashAt();
    const saved = await session.saver().save();
    expect(saved.hash).toBe(hash);
    const bytes = saved.bytes;
    // The same save, headless: the worker's export gives the same bytes as the in-process engine.
    const headless = loadGame(bytes);
    expect(headless.ok && headless.game.hash()).toBe(hash);

    session.newSandbox({ seed: 10 });
    expect(await session.hashAt()).not.toBe(hash);
    const generation = session.generation();
    const result = await session.prepareLoad(bytes);
    if (!result.ok) throw new Error(result.error.message);
    const prepared = result.prepared;
    expect(prepared.replay).toEqual({ status: 'continued' });
    expect(prepared.hash).toBe(hash);
    const workers = fakes.workers.length;
    session.adopt(prepared);
    expect(fakes.workers).toHaveLength(workers); // the worker that checked it carries on
    expect(fakes.workers[workers - 2].terminated).toBe(true); // the replaced game's
    expect(await session.hashAt()).toBe(hash);
    expect(await session.baselineHash(session.generation())).toBe(hash);
    expect(session.generation()).toBe(generation + 1);
    expect(session.active()).toBe(true);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
    expect(session.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(session.exec('entity.delete', { id: 1 })).toMatchObject({ ok: true, entry: { seq: 3 } });
    expect(session.entries()).toHaveLength(4);
    const replayed = replayGame(JSON.parse(JSON.stringify(session.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(await session.hashAt());
    await expect(session.baselineHash(generation)).rejects.toThrow(/replaced/);

    // A game on another registry would lose the file commands (and any host command): refused.
    const foreign = { ...prepared, game: createGame({ seed: 0 }) };
    expect(() => session.adopt(foreign)).toThrow(/registry/);
  });

  it('a saver captures the tick it was taken at, even if time passes before it is written (ADR 0011 §9.5)', async () => {
    const { session } = withWorker();
    session.newSandbox({ seed: 3 });
    expect(session.saver().changedWorld).toBe(false);
    session.exec('sim.step', { ticks: 5 });
    expect(session.saver().changedWorld).toBe(false); // sim.* alone never changes the world
    session.exec('entity.place', place);
    const saver = session.saver();
    session.exec('sim.step', { ticks: 500 });
    const { bytes } = await saver.save();
    expect(saver.tick).toBe(5);
    expect(saver.changedWorld).toBe(true);
    const loaded = loadGame(bytes);
    expect(loaded.ok && loaded.game.tick()).toBe(5);
  });

  it('starts a new session with a fresh history and log, and writes a replay log', () => {
    const { session } = withWorker();
    session.exec('entity.place', place);
    const world = createWorld({ seed: 77 });
    session.start(world);
    expect(session.world()).toBe(world);
    expect(session.canUndo()).toBe(false);
    expect(session.entries()).toEqual([]);
    session.exec('entity.place', place);
    expect(session.replayLog()).toMatchObject({ schemaVersion: 2, initialWorld: world, entries: [{ seq: 0 }] });
  });

  it('runs the same code as a scripting-api game: same console lines, same hash, same replay log', async () => {
    const { session } = withWorker();
    session.newSandbox({ seed: 0 });
    const game = createGame({ seed: 0 });
    const script = [
      'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 10 --positionMm.y 0 --positionMm.z -20',
      'entity.move 1 --positionMm.x 11 --positionMm.y 0 --positionMm.z -20',
      'view.resetLayout',
      'entity.delete 1',
      'edit.undo',
    ].join('\n');
    const target = { registry: session.registry, exec: session.exec.bind(session), hash: () => session.hashAt() };
    expect(await runConsoleScript(target, script)).toMatchObject({ ok: true, executed: 5 });
    expect(await runConsoleScript(game, script)).toMatchObject({ ok: true, executed: 5 });
    expect(await session.hashAt()).toBe(game.hash());
    expect(session.replayLog()).toEqual(game.replayLog());
    const replayed = replayGame(JSON.parse(JSON.stringify(session.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(await session.hashAt());
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
    const withLevel = (json: unknown) => withWorker([{ provide: SANDBOX_LEVEL, useValue: json }]).session;

    it('shows the level behind the menu, and New sandbox starts a game on it with a fresh history and log', async () => {
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
      const first = await session.hashAt();
      session.newSandbox({ seed: 4_294_967_295, difficulty: 'realistic' });
      expect(await session.hashAt()).toBe(first);
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

  it('exposes the test hook only with ?e2e=1', async () => {
    const fakeWindow: Record<string, unknown> = { location: { search: '?e2e=1' } };
    const fakeDocument = {
      defaultView: fakeWindow,
      visibilityState: 'visible',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    withWorker([{ provide: DOCUMENT, useValue: fakeDocument }]);
    const hook = fakeWindow['__controlsSession'] as {
      exec(id: string, args?: unknown): { ok: boolean };
      hash(): Promise<string>;
      snapshotHash(): Promise<string>;
      busWorld(): unknown;
      simTick(): number;
      simStatus(): string;
      waitForTick(tick: number): Promise<void>;
      simStats(): { misses: number };
      entries(): unknown[];
      hashWorld(json: unknown): string | null;
    };
    expect(hook.exec('entity.place', place).ok).toBe(true);
    expect(hook.entries()).toHaveLength(1);
    expect(await hook.hash()).toBe(worldHash(hook.busWorld() as ReturnType<typeof createWorld>));
    expect(hook.simStatus()).toBe('none');
    expect(hook.simTick()).toBe(0);
    expect(hook.simStats().misses).toBe(0);
    await expect(hook.snapshotHash()).rejects.toThrow();
    TestBed.inject(Session).newSandbox({ seed: 0 });
    await hook.waitForTick(0);
    expect(await hook.snapshotHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(hook.hashWorld(createWorld({ seed: 0 }))).toBe(worldHash(createWorld({ seed: 0 })));
    expect(hook.hashWorld({ schemaVersion: 1 })).toBeNull();
    TestBed.resetTestingModule();
    expect(fakeWindow['__controlsSession']).toBeUndefined();

    withWorker();
    expect((window as unknown as Record<string, unknown>)['__controlsSession']).toBeUndefined();
  });
});
