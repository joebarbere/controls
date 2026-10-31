import { CommandRegistry, defineViewCommand, NoArgs } from '@controls/commands';
import { createReplayLog, createWorld } from '@controls/save-format';
import { createWorldRegistry, type World, worldHash } from '@controls/world-model';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandFailedError, createGame, GameOptionsError, NotAvailableError, replayGame, replayLogGame } from './game';

const crate = { id: 'prop.crate', version: 1 };
const place = (x: number) => ({ ref: crate, positionMm: { x, y: 0, z: -200 } });
const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../save-format/fixtures/v1', path), 'utf8'));

describe('createGame', () => {
  it('starts from an empty world with the seed, a fresh history and an empty log', () => {
    const game = createGame({ seed: 42 });
    expect(game.world()).toEqual(createWorld({ seed: 42 }));
    expect(game.hash()).toBe(worldHash(createWorld({ seed: 42 })));
    expect(game.entries()).toEqual([]);
    expect(game.canUndo()).toBe(false);
    expect(game.canRedo()).toBe(false);
    expect(game.replayLog()).toEqual(createReplayLog(createWorld({ seed: 42 })));
  });

  it('runs commands through exec and reports typed errors without changing anything', () => {
    const game = createGame({ seed: 1 });
    const before = game.hash();
    expect(game.exec('entity.place', place(100))).toMatchObject({ ok: true, entry: { seq: 0, id: 'entity.place' } });
    expect(game.world().entities.map((e) => e.id)).toEqual([1]);
    expect(game.hash()).not.toBe(before);
    expect(game.canUndo()).toBe(true);

    const world = game.world();
    expect(game.exec('entity.move', { id: 9, positionMm: { x: 0, y: 0, z: 0 } })).toMatchObject({
      ok: false,
      error: { kind: 'rejected', code: 'not-found' },
    });
    expect(game.exec('no.such')).toMatchObject({ ok: false, error: { kind: 'unknown-command' } });
    expect(game.world()).toBe(world);
    expect(game.entries()).toHaveLength(1);

    expect(game.exec('edit.undo').ok).toBe(true);
    expect(game.hash()).toBe(before);
    expect(game.canRedo()).toBe(true);
    expect(game.contextKeys()).toEqual({ 'history.canUndo': false, 'history.canRedo': true });
  });

  it('execOrThrow returns the logged entry or throws CommandFailedError', () => {
    const game = createGame({ seed: 1 });
    expect(game.execOrThrow('entity.place', place(1))).toEqual({
      seq: 0,
      tick: 0,
      id: 'entity.place',
      args: { ...place(1), orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
    });
    expect(game.execOrThrow('view.resetLayout')).toMatchObject({ seq: 1, args: {} });
    let thrown: unknown;
    try {
      game.execOrThrow('entity.delete', { id: 7 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect(thrown).toMatchObject({ message: 'No entity with id 7', error: { kind: 'rejected', code: 'not-found' } });
  });

  it('returns frozen world snapshots that later commands never change', () => {
    const game = createGame({ seed: 1 });
    game.exec('entity.place', place(1));
    const snapshot = game.world();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entities[0].transform.positionMm)).toBe(true);
    expect(() => {
      (snapshot as World).assisted = true;
    }).toThrow(TypeError);
    game.exec('entity.move', { id: 1, positionMm: { x: 5, y: 5, z: 5 } });
    expect(snapshot.entities[0].transform.positionMm).toEqual({ x: 1, y: 0, z: -200 });
    expect(game.world().entities[0].transform.positionMm).toEqual({ x: 5, y: 5, z: 5 });
  });

  it('caches the hash per world', () => {
    const game = createGame({ seed: 1 });
    const first = game.hash();
    expect(game.hash()).toBe(first);
    game.exec('entity.place', place(1));
    expect(game.hash()).toBe(worldHash(game.world() as World));
  });

  it('notifies executed listeners until they unsubscribe, and rejects unknown events', () => {
    const game = createGame({ seed: 1 });
    const seen: string[] = [];
    const off = game.on('executed', (event) => seen.push(`${event.entry?.seq ?? 'unlogged'}:${event.command.id}`));
    game.exec('entity.place', place(1));
    game.exec('entity.delete', { id: 99 }); // fails: no event
    game.exec('palette.open'); // UI chrome: an event, but no entry and no seq
    game.exec('view.resetLayout');
    off();
    game.exec('edit.undo');
    expect(seen).toEqual(['0:entity.place', 'unlogged:palette.open', '1:view.resetLayout']);
    expect(game.entries().map((e) => e.id)).toEqual(['entity.place', 'view.resetLayout', 'edit.undo']);
    expect(game.execOrThrow('palette.open')).toBeNull();
    expect(() => game.on('nope' as 'executed', () => undefined)).toThrow(/Unknown game event "nope"/);
  });

  it('evaluates when with the history keys plus the caller context', () => {
    const registry = createWorldRegistry().register(
      defineViewCommand<NoArgs, World>({
        id: 'view.workOnly',
        title: 'Work only',
        category: 'View',
        args: NoArgs,
        when: 'mode == "work"',
      }),
    );
    const game = createGame({ seed: 1, registry });
    expect(game.registry).toBe(registry);
    expect(game.isEnabled('edit.undo')).toBe(false);
    game.exec('entity.place', place(1));
    expect(game.isEnabled('edit.undo')).toBe(true);
    expect(game.isEnabled('view.workOnly')).toBe(false);
    expect(game.isEnabled('view.workOnly', { mode: 'work' })).toBe(true);
    // The game's own keys win over caller context.
    expect(game.isEnabled('edit.undo', { 'history.canUndo': false })).toBe(true);
  });

  it('reserves tag (P10) and throws NotAvailableError; a game without an engine has no sim queries', () => {
    const game = createGame({ seed: 1 });
    const still = createGame({ seed: 1, engine: false });
    expect(() => still.probe('1:a', '1:b')).toThrow(NotAvailableError);
    expect(() => still.probe('1:a', '1:b')).toThrow('game.probe() needs the sim engine');
    expect(() => still.snapshot()).toThrow(NotAvailableError);
    expect(() => still.snapshotHash()).toThrow(NotAvailableError);
    expect(() => still.islands()).toThrow(NotAvailableError);
    let thrown: unknown;
    try {
      game.tag('PLC1:Motor.Run');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'NotAvailableError', code: 'not-available', query: 'tag', phase: 'P10' });
  });

  it('is itself frozen, so a script cannot swap out exec', () => {
    const game = createGame({ seed: 1 });
    expect(Object.isFrozen(game)).toBe(true);
  });

  it('starts from a given world, keeping it (frozen) as the initial world of the log', () => {
    const world = createWorld({ seed: 9, difficulty: 'trainee' });
    const game = createGame({ world, seed: 9 });
    expect(game.world()).toBe(world);
    expect(Object.isFrozen(world)).toBe(true);
    game.exec('entity.place', place(3));
    expect(game.replayLog().initialWorld).toEqual(world);
  });

  it.each([
    [{ seed: -1 }, /unsigned 32-bit/],
    [{ seed: 2 ** 32 }, /unsigned 32-bit/],
    [{ seed: 1.5 }, /unsigned 32-bit/],
    [{ world: createWorld({ seed: 3 }), seed: 4 }, /contradicts/],
  ])('rejects options %j', (options, message) => {
    expect(() => createGame(options)).toThrow(GameOptionsError);
    expect(() => createGame(options)).toThrow(message);
  });

  it('rejects an invalid world with issues and no echo of the input', () => {
    const bad = { ...createWorld({ seed: 3 }), nextEntityId: 'secret' } as unknown as World;
    let thrown: unknown;
    try {
      createGame({ world: bad });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GameOptionsError);
    const error = thrown as GameOptionsError;
    expect(error.issues[0]).toMatchObject({ path: 'nextEntityId' });
    expect(JSON.stringify(error.issues)).not.toContain('secret');
  });
});

describe('replayGame', () => {
  it('replays a replay-log fixture to the live hash and continues the same log', () => {
    const result = replayGame(fixture('replay-log/place-move-delete-undo.json'));
    if (!result.ok) throw new Error(result.error.message);
    const { game } = result;
    expect(game.entries()).toHaveLength(5);
    expect(game.world().entities.map((e) => e.id)).toEqual([1]);
    expect(game.canRedo()).toBe(true);

    // The same session, live.
    const live = createGame({ world: createWorld({ seed: 123456789, difficulty: 'trainee' }) });
    live.execOrThrow('entity.place', { ref: crate, positionMm: { x: 100, y: 0, z: -200 } });
    live.execOrThrow('entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } });
    live.execOrThrow('view.resetLayout');
    live.execOrThrow('entity.delete', { id: 1 });
    live.execOrThrow('edit.undo');
    expect(game.hash()).toBe(live.hash());
    expect(game.replayLog()).toEqual(live.replayLog());

    // It continues the log: redo the delete.
    expect(game.execOrThrow('edit.redo')?.seq).toBe(5);
    expect(game.world().entities).toEqual([]);
  });

  it('reports a document that does not load', () => {
    expect(replayGame({ schemaVersion: 99 })).toMatchObject({
      ok: false,
      error: { kind: 'load', error: { kind: 'newer-than-build' } },
    });
    expect(replayGame('nope')).toMatchObject({ ok: false, error: { kind: 'load', error: { kind: 'not-an-object' } } });
  });

  it('reports a log that no longer replays', () => {
    const log = createReplayLog(createWorld({ seed: 1 }), [{ seq: 0, tick: 0, id: 'entity.delete', args: { id: 1 } }]);
    expect(replayLogGame(log)).toMatchObject({
      ok: false,
      error: { kind: 'replay', error: { kind: 'failed', seq: 0 } },
    });
    // A registry missing a logged command can't replay it either.
    const empty = new CommandRegistry<World>();
    const viewLog = createReplayLog(createWorld({ seed: 1 }), [{ seq: 0, tick: 0, id: 'view.resetLayout', args: {} }]);
    expect(replayLogGame(viewLog, { registry: empty })).toMatchObject({ ok: false, error: { kind: 'replay' } });
  });
});
