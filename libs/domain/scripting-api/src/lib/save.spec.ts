import { CommandRegistry } from '@controls/commands';
import { createReplayLog, createWorld, CtrlWriteError, readCtrl, writeCtrl } from '@controls/save-format';
import { TINY_PNG } from '@controls/save-format/testing';
import { createWorldRegistry, type World, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineCompatible } from './engine-compat';
import {
  BUILD_ENGINE_VERSIONS,
  createGame,
  createSaveManifest,
  type Game,
  gameFromSave,
  GameOptionsError,
  loadGame,
  replayLogGame,
} from './game';

const fixturesRoot = join(import.meta.dirname, '../../../save-format/fixtures');
const ctrlFixtures = ['v1', 'v2'].flatMap((version) =>
  readdirSync(join(fixturesRoot, version, 'ctrl'))
    .filter((name) => name.endsWith('.ctrl'))
    .map((name) => `${version}/ctrl/${name}`),
);

/** A manifest for this build, as `Game.save` writes it. */
const createManifest = createSaveManifest;

describe('the .ctrl fixtures', () => {
  it.each(ctrlFixtures)(
    '%s loads; its replay log (if any) reproduces its world, or it is from another engine (D8)',
    (path) => {
      const result = loadGame(new Uint8Array(readFileSync(join(fixturesRoot, path))));
      if (!result.ok) throw new Error(result.error.message);
      if (path.endsWith('world-only.ctrl')) {
        expect(result.replay.status).toBe('absent');
      } else if (engineCompatible(result.manifest, BUILD_ENGINE_VERSIONS) === 'engine-changed') {
        // Saves from engines before this one (the world v2 kickoff's engine 1, which never ran): never
        // verified, never refused.
        expect(result.manifest.simEngineVersion).toBe(1);
        expect(result.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
        // world.json loads as saved; it holds no solution (engine 1 never ran), so the engine solves at
        // the start, and only the solution record differs from the saved world.
        const saved = readCtrlOrThrow(join(fixturesRoot, path)).world;
        expect(result.game.world()).toStrictEqual(saved);
        expect({ ...result.game.materialisedWorld(), sim: null }).toStrictEqual(saved);
      } else {
        expect(result.replay.status).toBe('continued');
      }
    },
  );
});

function readCtrlOrThrow(path: string) {
  const read = readCtrl(new Uint8Array(readFileSync(path)));
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}

const crate = { id: 'prop.crate', version: 1 };
const place = (x: number) => ({ ref: crate, positionMm: { x, y: 0, z: -200 } });

function played(): Game {
  const game = createGame({ seed: 9 });
  game.execOrThrow('entity.place', place(100));
  game.execOrThrow('entity.place', place(300));
  game.execOrThrow('entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } });
  game.execOrThrow('edit.undo');
  return game;
}

function loaded(bytes: Uint8Array) {
  const result = loadGame(bytes);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

describe('Game.save', () => {
  it('writes a .ctrl holding the manifest, the world and the replay log', () => {
    const game = played();
    const read = readCtrl(game.save());
    expect(read).toStrictEqual({
      ok: true,
      value: {
        manifest: createManifest(),
        world: game.world(),
        replayLog: game.replayLog(),
        thumbnail: null,
        fromVersion: 2,
      },
    });
  });

  it('is deterministic: the same commands give the same bytes', () => {
    expect(played().save()).toStrictEqual(played().save());
    expect(played().save({ thumbnail: TINY_PNG })).toStrictEqual(played().save({ thumbnail: TINY_PNG }));
  });

  it('includes the thumbnail and refuses one that is not a PNG', () => {
    expect(loaded(played().save({ thumbnail: TINY_PNG })).thumbnail).toStrictEqual(TINY_PNG);
    expect(() => played().save({ thumbnail: new Uint8Array([1, 2]) })).toThrow(CtrlWriteError);
  });
});

describe('loadGame', () => {
  it('restores the world, clears the undo stack and continues the replay log', () => {
    const original = played();
    const result = loaded(original.save());
    const game = result.game;
    expect(result.replay).toEqual({ status: 'continued' });
    expect(result.fromVersion).toBe(2);
    expect(result.manifest).toStrictEqual(createManifest());
    expect(game.hash()).toBe(original.hash());
    expect(game.world()).toStrictEqual(original.world());
    expect(game.entries()).toStrictEqual(original.entries());
    expect(game.replayLog().initialWorld).toStrictEqual(original.replayLog().initialWorld);
    expect([original.canUndo(), original.canRedo()]).toEqual([true, true]);
    expect([game.canUndo(), game.canRedo()]).toEqual([false, false]);
    expect(game.exec('edit.undo')).toMatchObject({ ok: false });
    expect(game.exec('edit.redo')).toMatchObject({ ok: false });

    const entry = game.execOrThrow('entity.place', place(500));
    expect(entry?.seq).toBe(original.entries().length);
    expect(game.canUndo()).toBe(true);
    game.execOrThrow('edit.undo');
    game.execOrThrow('edit.redo');
  });

  it('a session saved after a load replays to its hash, through any number of loads', () => {
    let game = played();
    for (let round = 0; round < 3; round++) {
      game = loaded(game.save()).game;
      game.execOrThrow('entity.place', place(1000 + round));
      game.execOrThrow('edit.undo');
      game.execOrThrow('entity.place', place(2000 + round));
    }
    const replayed = replayLogGame(game.replayLog());
    expect(replayed.ok && replayed.game.hash()).toBe(game.hash());
    expect(loaded(game.save()).replay).toEqual({ status: 'continued' });
  });

  it('starts a new log when the save has none', () => {
    const world = played().world() as World;
    const result = loaded(writeCtrl({ manifest: createManifest(), world }));
    expect(result.replay).toEqual({ status: 'absent' });
    expect(result.game.hash()).toBe(worldHash(world));
    expect(result.game.replayLog()).toStrictEqual(createReplayLog(world));
  });

  it('drops a log that replays to a different world, keeping world.json', () => {
    const game = played();
    const other = createGame({ seed: 10 });
    const bytes = writeCtrl({ manifest: createManifest(), world: game.world() as World, replayLog: other.replayLog() });
    const result = loaded(bytes);
    expect(result.replay).toMatchObject({ status: 'restarted', reason: 'hash-mismatch' });
    expect(result.game.hash()).toBe(game.hash());
    expect(result.game.replayLog()).toStrictEqual(createReplayLog(game.world() as World));
  });

  it('drops a log that fails to replay, saying which entry failed', () => {
    const world = createWorld({ seed: 1 });
    const log = createReplayLog(world, [{ seq: 0, tick: 0, id: 'entity.delete', args: { id: 7 } }]);
    const result = loaded(writeCtrl({ manifest: createManifest(), world, replayLog: log }));
    expect(result.replay).toMatchObject({ status: 'restarted', reason: 'replay-failed' });
    expect(result.replay.status === 'restarted' && result.replay.message).toContain('Entry 0');
    expect(result.game.entries()).toEqual([]);
    // The new log continues the dropped log's numbering (ADR 0011 §10): seq-keyed streams don't repeat.
    expect(result.game.replayLog().firstSeq).toBe(1);
    expect(result.game.execOrThrow('view.resetLayout')?.seq).toBe(1);
  });

  it('returns the typed container error for a bad or newer save', () => {
    expect(loadGame(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, error: { kind: 'not-a-zip' } });
    expect(loadGame(played().save(), { limits: { maxContainerBytes: 10 } })).toMatchObject({
      ok: false,
      error: { kind: 'too-large' },
    });
  });

  it('uses the given registry', () => {
    const bytes = played().save();
    const read = readCtrl(bytes);
    if (!read.ok) throw new Error('unreadable');
    const empty = gameFromSave(read.value, { registry: new CommandRegistry<World>() });
    expect(empty.ok && empty.replay).toMatchObject({ status: 'restarted', reason: 'replay-failed' });
    const full = gameFromSave(read.value, { registry: createWorldRegistry() });
    expect(full.ok && full.replay).toEqual({ status: 'continued' });
  });

  it('property: save, load and continue at any point replays to the live hash', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('place' as const), x: fc.integer({ min: -500, max: 500 }) }),
      fc.record({
        kind: fc.constant('move' as const),
        id: fc.integer({ min: 1, max: 4 }),
        x: fc.integer({ min: 0, max: 9 }),
      }),
      fc.record({ kind: fc.constant('delete' as const), id: fc.integer({ min: 1, max: 4 }) }),
      fc.constant({ kind: 'undo' as const }),
      fc.constant({ kind: 'redo' as const }),
      fc.constant({ kind: 'save-load' as const }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 20 }), (ops) => {
        let game = createGame({ seed: 3 });
        for (const o of ops) {
          if (o.kind === 'place') game.exec('entity.place', place(o.x));
          else if (o.kind === 'move') game.exec('entity.move', { id: o.id, positionMm: { x: o.x, y: 0, z: 0 } });
          else if (o.kind === 'delete') game.exec('entity.delete', { id: o.id });
          else if (o.kind === 'undo') game.exec('edit.undo');
          else if (o.kind === 'redo') game.exec('edit.redo');
          else {
            const next = loaded(game.save());
            expect(next.replay).toEqual({ status: 'continued' });
            expect(next.game.hash()).toBe(game.hash());
            game = next.game;
          }
        }
        const replayed = replayLogGame(game.replayLog());
        expect(replayed.ok && replayed.game.hash()).toBe(game.hash());
      }),
      // Each save-load writes, reads and replays a .ctrl with the engine: fewer runs, not a longer timeout.
      { numRuns: 40 },
    );
  });
});

describe('the device check (invalid-device-state, ADR 0013)', () => {
  const spst = { id: 'switch.tessaline-spst-toggle', version: 1 };
  const withSwitch = (state: Record<string, unknown>): World =>
    ({
      ...createWorld({ seed: 3 }),
      nextEntityId: 2,
      entities: [
        {
          id: 1,
          ref: spst,
          transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
          state,
          sim: {},
          extensions: {},
        },
      ],
    }) as World;

  it('loadGame refuses a save whose bags don’t match the device’s model kind, without echoing values', () => {
    const bytes = writeCtrl({ manifest: createManifest(), world: withSwitch({ closed: 'secret' }) });
    const result = loadGame(bytes);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid-device-state',
        issues: [{ path: 'entities[0].state.closed', message: 'Not a valid switch.spst closed value' }],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(loadGame(writeCtrl({ manifest: createManifest(), world: withSwitch({ closed: true }) })).ok).toBe(true);
  });

  it('createGame refuses such a world too', () => {
    expect(() => createGame({ world: withSwitch({}) })).toThrow(GameOptionsError);
    expect(createGame({ world: withSwitch({ closed: false }) }).world().entities[0].state).toStrictEqual({
      closed: false,
    });
  });
});

describe('createSaveManifest', () => {
  it('records the built-in catalogue and the engine version', () => {
    expect(createSaveManifest()).toMatchObject({ schemaVersion: 2, catalogVersion: 1, simEngineVersion: 3 });
  });
});
