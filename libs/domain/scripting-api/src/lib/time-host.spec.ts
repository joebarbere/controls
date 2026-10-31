import {
  createManifest,
  createReplayLog,
  createWorld,
  readCtrl,
  type ReplayEntry,
  type World,
} from '@controls/save-format';
import { SimEngine } from '@controls/sim-core';
import { createWorldRegistry, worldHash } from '@controls/world-model';
import { ENGINE_CHANGED_MESSAGE, MAX_VERIFY_TICKS, TOO_LONG_TO_VERIFY_MESSAGE } from './game';
import {
  BUILD_ENGINE_VERSIONS,
  createGame,
  gameFromSave,
  NotAvailableError,
  planLoad,
  replayLogGame,
  type TimeHost,
  verifyFailure,
  writeSave,
} from './game';

/*
 * A game whose engine runs elsewhere (F2.3b, ADR 0011 §3, §9.4): the session's game takes the sim
 * worker's host as its time host. No engine runs in-process; entries and advances go to the host;
 * the synchronous hash, save and sim queries are not available unless the host can export.
 * And the load plan, the one rule both the headless load and the game's worker load follow.
 */

const crate = { id: 'prop.crate', version: 1 };
const place = { ref: crate, positionMm: { x: 1, y: 0, z: 2 } };

/** A recording time host. */
function recorder(exportState?: TimeHost['exportState']) {
  const calls: string[] = [];
  const host: TimeHost = {
    advanceTo: (tick) => void calls.push(`advance ${tick}`),
    applied: (entry: ReplayEntry, world: World) => void calls.push(`applied ${entry.seq}@${entry.tick} ${world.tick}`),
    exportState,
  };
  return { calls, host };
}

describe('a game with a time host', () => {
  it('forwards every logged entry and every advance, sim.step included, and runs no engine', () => {
    const start = vi.spyOn(SimEngine, 'start');
    const { calls, host } = recorder();
    const game = createGame({ seed: 1, time: host });
    expect(start).not.toHaveBeenCalled();
    game.execOrThrow('entity.place', place);
    game.execOrThrow('view.resetLayout');
    game.execOrThrow('sim.step', { ticks: 25 });
    game.advanceTo(40);
    game.advance(5);
    game.execOrThrow('entity.move', { id: 1, positionMm: { x: 3, y: 0, z: 2 } });
    expect(calls).toEqual([
      'applied 0@0 0',
      'applied 1@0 0',
      'applied 2@0 0',
      'advance 25',
      'advance 40',
      'advance 45',
      'applied 3@45 45',
    ]);
    expect(game.tick()).toBe(45);
    start.mockRestore();
  });

  it('has no synchronous hash, save or sim queries, unless the host can export', () => {
    const { host } = recorder();
    const game = createGame({ seed: 1, time: host });
    for (const query of [
      () => game.hash(),
      () => game.save(),
      () => game.materialisedWorld(),
      () => game.snapshot(),
      () => game.snapshotHash(),
      () => game.islands(),
      () => game.probe('1:a', '1:b'),
    ]) {
      expect(query).toThrow(NotAvailableError);
    }
    try {
      game.hash();
    } catch (error) {
      expect(error).toMatchObject({ code: 'not-available', query: 'hash', phase: 'worker' });
      expect((error as Error).message).toContain('SimHost');
    }
    const exporting = createGame({
      seed: 1,
      time: recorder(() => ({ tick: 0, entities: [], solution: null })).host,
    });
    expect(exporting.hash()).toBe(worldHash(createWorld({ seed: 1 })));
    expect(readCtrl(exporting.save()).ok).toBe(true);
  });

  it('a replayed or loaded game rebuilds the commanded state only, then forwards live play', () => {
    const source = createGame({ seed: 2 });
    source.execOrThrow('entity.place', place);
    source.execOrThrow('sim.step', { ticks: 30 });
    source.execOrThrow('edit.undo');
    const start = vi.spyOn(SimEngine, 'start');
    const { calls, host } = recorder();
    const replayed = replayLogGame(source.replayLog(), { registry: createWorldRegistry(), time: host });
    expect(start).not.toHaveBeenCalled();
    expect(calls).toEqual([]); // the replay itself sends nothing
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.game.world()).toEqual(source.world());
    replayed.game.execOrThrow('edit.redo');
    expect(calls).toEqual(['applied 3@30 30']);
    start.mockRestore();
  });
});

describe('planLoad', () => {
  const world = createWorld({ seed: 3 });
  const manifest = createManifest(BUILD_ENGINE_VERSIONS);

  it('verifies a log of this engine and catalogue within MAX_VERIFY_TICKS', () => {
    const log = createReplayLog(world, [], { endTick: MAX_VERIFY_TICKS.value });
    expect(planLoad({ manifest, replayLog: log })).toEqual({ kind: 'verify', log, compatibility: 'verify' });
  });

  it('restarts an absent, too-long or other-engine log, never refusing it', () => {
    expect(planLoad({ manifest, replayLog: null })).toMatchObject({ kind: 'restart', replay: { status: 'absent' } });
    const long = createReplayLog(world, [], { endTick: MAX_VERIFY_TICKS.value + 1 });
    expect(planLoad({ manifest, replayLog: long })).toEqual({
      kind: 'restart',
      replay: { status: 'restarted', reason: 'too-long-to-verify', message: TOO_LONG_TO_VERIFY_MESSAGE },
      compatibility: 'verify',
    });
    const other = createManifest({
      ...BUILD_ENGINE_VERSIONS,
      simEngineVersion: BUILD_ENGINE_VERSIONS.simEngineVersion + 1,
    });
    expect(planLoad({ manifest: other, replayLog: createReplayLog(world, []) })).toEqual({
      kind: 'restart',
      replay: { status: 'restarted', reason: 'engine-changed', message: ENGINE_CHANGED_MESSAGE },
      compatibility: 'engine-changed',
    });
    const v0 = createManifest({ simEngineVersion: 0, catalogVersion: 0 });
    expect(planLoad({ manifest: v0, replayLog: createReplayLog(world, []) })).toMatchObject({
      kind: 'verify',
      compatibility: 'verify-v0',
    });
  });

  it('is what gameFromSave follows (a too-long log restarts without replaying)', () => {
    const log = createReplayLog(world, [], { endTick: MAX_VERIFY_TICKS.value + 1 });
    const tick = { ...world, tick: log.endTick };
    const loaded = gameFromSave({ manifest, world: tick, replayLog: log, thumbnail: null, fromVersion: 2 });
    expect(loaded.ok && loaded.replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
  });
});

describe('verifyFailure', () => {
  it('names a mismatch or a failed replay, except for a migrated P1 save (engine-changed)', () => {
    expect(verifyFailure('verify', { kind: 'hash-mismatch' })).toMatchObject({
      status: 'restarted',
      reason: 'hash-mismatch',
    });
    expect(verifyFailure('verify', { kind: 'replay-failed', message: 'entry 3' })).toEqual({
      status: 'restarted',
      reason: 'replay-failed',
      message: 'entry 3',
    });
    expect(verifyFailure('verify-v0', { kind: 'hash-mismatch' })).toMatchObject({ reason: 'engine-changed' });
  });
});

describe('writeSave', () => {
  it('writes a save of this build that reads back', () => {
    const world = createWorld({ seed: 4 });
    const read = readCtrl(writeSave(world, createReplayLog(world, [])));
    expect(read.ok && read.value.manifest.simEngineVersion).toBe(BUILD_ENGINE_VERSIONS.simEngineVersion);
  });
});
