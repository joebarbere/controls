import { ctrlJson, readCtrl, type ReplayLog, utf8ByteLength, type World } from '@controls/save-format';
import { ENGINE_BENCH, ENGINE_TEST_CATALOG, engineTestOptions } from '@controls/sim-core/testing';
import { createWorldRegistry } from '@controls/world-model';
import fc from 'fast-check';
import {
  CHECKPOINT_TICKS,
  createGame,
  createSaveManifest,
  entryBytes,
  type Game,
  loadGame,
  LOG_CHECKPOINT_BYTES,
  MAX_VERIFY_TICKS,
  rebasedAtSave,
  replayLogGame,
} from './game';

/*
 * The replay-log cap (P4 Saves, the carried P1 "replay log never shrinks" item). A save writes its
 * log rebased onto the latest checkpoint (P3 D19); two additions keep a long session saveable:
 *
 * - a checkpoint is also taken once the entries since the latest one pass `checkpointLogBytes`
 *   (`LOG_CHECKPOINT_BYTES`, 4 MiB of compact JSON), at the next tick time reaches;
 * - a log that would still put the save over a cap (time stood still, or an undo reached across
 *   the checkpoint) is rebased onto the save's own world (`rebasedAtSave`): no entries.
 *
 * Either way a capped session saves, loads `continued` and replays to the same hash.
 */

const engine = engineTestOptions();
const registry = () => createWorldRegistry({ catalog: ENGINE_TEST_CATALOG });
const crate = { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 5, y: 0, z: 5 } };
const every = CHECKPOINT_TICKS.value;
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** The engine test bench, switched off (as in `checkpoint.spec.ts`), then one tick on (any due checkpoint taken). */
function bench(checkpointLogBytes?: number): Game {
  const game = createGame({ seed: 11, registry: registry(), engine, checkpointLogBytes });
  for (const [id, args] of ENGINE_BENCH) game.execOrThrow(id, args);
  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
  game.advance(1);
  return game;
}

function load(bytes: Uint8Array, checkpointLogBytes?: number) {
  const result = loadGame(bytes, { registry: registry(), engine, checkpointLogBytes });
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function savedLog(bytes: Uint8Array): ReplayLog {
  const read = readCtrl(bytes);
  if (!read.ok || read.value.replayLog === null) throw new Error('no replay log');
  return read.value.replayLog;
}

/**
 * Flips the bench switch `times` times (an even count leaves it as it was): entries that grow the
 * log but not the world, as a long session's do relative to its world.
 */
function flip(game: Game, times: number): void {
  for (let i = 0; i < times; i++) {
    const closed = game.world().entities.find((e) => e.id === 2)?.state['closed'] === true;
    game.execOrThrow('device.operate', { id: 2, control: 'closed', value: !closed });
  }
}

/** UTF-8 bytes of the entries `game` would save after its latest checkpoint (what the trigger counts). */
function carried(game: Game): number {
  return savedLog(game.save()).entries.reduce((sum, e) => sum + utf8ByteLength(JSON.stringify(e)), 0);
}

/** The size of `replay.log` if `game` were saved with no log cap fallback: its log at the save's own world. */
const atSaveBytes = (game: Game) =>
  utf8Length(ctrlJson(rebasedAtSave(game.materialisedWorld() as World, game.replayLog())));

describe('LOG_CHECKPOINT_BYTES', () => {
  it('is 4 MiB, a sourced numerical choice', () => {
    expect(LOG_CHECKPOINT_BYTES).toMatchObject({ value: 4 * 1024 * 1024, unit: 'B', kind: 'numerical' });
    expect(LOG_CHECKPOINT_BYTES.source).toMatch(/32 MiB/);
  });
});

describe('a checkpoint once the log since the latest one passes checkpointLogBytes', () => {
  it('is taken at the next tick time reaches, before any command there, and saves load continued', () => {
    const game = bench(2_000);
    const start = game.tick();
    for (let i = 0; i < 20; i++) game.execOrThrow('entity.place', crate); // ≈ 3 KB of entries
    expect(savedLog(game.save()).initialWorld.tick).toBeLessThan(start); // not yet: time hasn't moved
    game.advance(5);
    game.execOrThrow('entity.place', crate);
    const bytes = game.save();
    const log = savedLog(bytes);
    expect(log.initialWorld.tick).toBe(start + 5);
    expect(log.entries).toStrictEqual([game.entries().at(-1)]);
    expect(log.initialWorld.tick % every).not.toBe(0); // off the CHECKPOINT_TICKS grid
    const loaded = load(bytes, 2_000);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
  });

  it('counts the entries a loaded game carries: they are in its next save until a checkpoint', () => {
    const trigger = 2_000;
    const game = bench(trigger);
    const entrySize = utf8ByteLength(JSON.stringify(game.execOrThrow('entity.place', crate)));
    while (carried(game) + entrySize < trigger) game.execOrThrow('entity.place', crate);
    const saved = game.save();
    const base = savedLog(saved).initialWorld.tick; // under the trigger: no checkpoint since
    const loaded = load(saved, trigger).game;
    expect(loaded.entries().length).toBe(savedLog(saved).entries.length);
    // One more entry passes the trigger only if the carried ones count.
    loaded.execOrThrow('entity.place', crate);
    loaded.advance(3);
    const log = savedLog(loaded.save());
    expect(log.initialWorld.tick).toBe(loaded.tick());
    expect(log.initialWorld.tick).toBeGreaterThan(base);
    expect(log.entries).toStrictEqual([]);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // No command takes non-ASCII text today (labels are `LabelText`), so the entry is built by hand.
    const entry = { seq: 0, tick: 0, id: 'future.note', args: { text: '€'.repeat(100) } };
    expect(entryBytes(entry)).toBe(JSON.stringify(entry).length + 200); // 3 bytes per €, not 1 unit
    expect(entryBytes(entry)).toBe(new TextEncoder().encode(JSON.stringify(entry)).length);
  });

  it('is not taken below the threshold: the default keeps today’s saves byte for byte', () => {
    const small = bench();
    for (let i = 0; i < 20; i++) small.execOrThrow('entity.place', crate);
    small.advance(5);
    expect(savedLog(small.save()).initialWorld.tick).toBe(0);
    const negative = createGame({ seed: 1, checkpointLogBytes: -1 }); // ignored: the default applies
    negative.execOrThrow('entity.place', crate);
    negative.advance(1);
    expect(savedLog(negative.save()).initialWorld.tick).toBe(0);
  });
});

describe('a log over the cap is rebased onto the save’s own world', () => {
  /** Two hundred switchings while time stands still: the log since the checkpoint can't shrink. */
  function stillSession(): Game {
    const game = bench();
    game.execOrThrow('entity.place', crate);
    flip(game, 200);
    return game;
  }

  it('saves, loads continued, replays to the same hash, and numbering continues', () => {
    const game = stillSession();
    const cap = atSaveBytes(game);
    expect(utf8Length(ctrlJson(game.replayLog()))).toBeGreaterThan(cap); // the whole log doesn't fit
    const bytes = game.save({ limits: { maxReplayLogBytes: cap } });
    const log = savedLog(bytes);
    expect(log.entries).toStrictEqual([]);
    expect(log.initialWorld).toStrictEqual(game.materialisedWorld());
    expect(log.firstSeq).toBe(game.entries().length);
    expect(log.endTick).toBe(game.tick());
    const loaded = load(bytes);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
    const replayed = replayLogGame(log, { registry: registry(), engine });
    expect(replayed.ok && replayed.game.hash()).toBe(game.hash());
    // The loaded game numbers its next entry where the session would have.
    expect(loaded.game.execOrThrow('entity.place', crate)?.seq).toBe(game.execOrThrow('entity.place', crate)?.seq);
    expect(loaded.game.hash()).toBe(game.hash());
  });

  it('only when it doesn’t fit: under the cap the log is kept', () => {
    const game = stillSession();
    const whole = utf8Length(ctrlJson(game.replayLog()));
    expect(savedLog(game.save({ limits: { maxReplayLogBytes: whole } })).entries).toHaveLength(game.entries().length);
  });

  it('turns an undo across the checkpoint (whole log, too long to verify) into a save that loads continued', () => {
    const game = bench();
    flip(game, 200);
    game.advanceTo(9_000);
    game.execOrThrow('entity.place', crate);
    game.advanceTo(11_000);
    game.execOrThrow('edit.undo'); // pops the place at 9 000, before the checkpoint at 10 000
    game.advanceTo(12_000);
    expect(load(game.save()).replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
    const capped = game.save({ limits: { maxReplayLogBytes: atSaveBytes(game) } });
    expect(savedLog(capped).initialWorld.tick).toBe(12_000);
    const loaded = load(capped);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
  });

  it('also when it is the whole container that is over its total, not replay.log alone', () => {
    const game = stillSession();
    const world = game.materialisedWorld() as World;
    const size = (value: unknown) => utf8ByteLength(ctrlJson(value));
    // Room for the manifest, the world and the log rebased at the save, not for the whole log.
    const total = size(createSaveManifest()) + size(world) + atSaveBytes(game);
    expect(size(createSaveManifest()) + size(world) + size(game.replayLog())).toBeGreaterThan(total);
    const bytes = game.save({ limits: { maxTotalBytes: total } }); // replay.log's own cap untouched
    const log = savedLog(bytes);
    expect(log.entries).toStrictEqual([]);
    expect(log.initialWorld.tick).toBe(game.tick());
    const loaded = load(bytes);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
    // One byte less and even the rebased save doesn't fit: that is thrown, never written.
    expect(() => game.save({ limits: { maxTotalBytes: total - 1 } })).toThrow(/larger than/);
  });

  it('still throws when the world itself is over its cap', () => {
    const game = stillSession();
    expect(() => game.save({ limits: { maxWorldBytes: 100 } })).toThrow(/world\.json/);
  });
});

describe('a capped session saves, loads continued and replays to the same hash (property)', () => {
  type Action = 'none' | 'toggle' | 'burst' | 'undo' | 'redo';
  interface Step {
    readonly ticks: number;
    readonly action: Action;
  }
  const action = fc.constantFrom<Action>('none', 'toggle', 'burst', 'undo', 'redo');
  const later = fc.constantFrom<Action>('none', 'toggle', 'burst');
  const steps = fc.array(fc.record({ ticks: fc.nat({ max: 6_000 }), action }), { minLength: 1, maxLength: 8 });
  const afterSteps = fc.array(fc.record({ ticks: fc.nat({ max: 3_000 }), action: later }), { maxLength: 3 });
  const trigger = 1_500; // checkpointLogBytes: a burst passes it

  function play(game: Game, list: readonly Step[]): void {
    for (const { ticks, action: a } of list) {
      game.advance(ticks);
      if (a === 'toggle') {
        const closed = game.world().entities.find((e) => e.id === 2)?.state['closed'] === true;
        game.execOrThrow('device.operate', { id: 2, control: 'closed', value: !closed });
      } else if (a === 'burst') {
        game.execOrThrow('entity.place', crate);
        flip(game, 40);
      } else if (a === 'undo') game.exec('edit.undo');
      else if (a === 'redo') game.exec('edit.redo');
    }
  }

  it('whatever the session and however tight the cap', () => {
    const seen = { fallback: 0, offGrid: 0, kept: 0 };
    fc.assert(
      fc.property(steps, afterSteps, fc.nat({ max: 4_000 }), (before, after, slack) => {
        const straight = bench(trigger);
        play(straight, before);
        // The tightest cap any save can meet (its world as the log) plus some slack.
        const cap = atSaveBytes(straight) + slack;
        const bytes = straight.save({ limits: { maxReplayLogBytes: cap } }); // never throws
        const log = savedLog(bytes);
        expect(utf8Length(ctrlJson(log))).toBeLessThanOrEqual(cap);
        if (log.entries.length === 0 && log.initialWorld.tick === straight.tick()) seen.fallback++;
        else seen.kept++;
        if (log.initialWorld.tick % every !== 0) seen.offGrid++;
        const loaded = load(bytes, trigger);
        if (log.endTick - log.initialWorld.tick <= MAX_VERIFY_TICKS.value) {
          expect(loaded.replay).toStrictEqual({ status: 'continued' });
        } else {
          expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
        }
        expect(loaded.game.hash()).toBe(straight.hash());
        const replayed = replayLogGame(log, { registry: registry(), engine });
        expect(replayed.ok && replayed.game.hash()).toBe(straight.hash());
        // Played on from the load, it stays the uninterrupted run.
        play(straight, after);
        play(loaded.game, after);
        expect(loaded.game.snapshot()).toStrictEqual(straight.snapshot());
        expect(loaded.game.hash()).toBe(straight.hash());
      }),
      { numRuns: 30, seed: 20261118 },
    );
    // Generator health: the fallback, the size trigger and an ordinary log all happen.
    expect(seen.fallback).toBeGreaterThan(3);
    expect(seen.kept).toBeGreaterThan(3);
    expect(seen.offGrid).toBeGreaterThan(3);
  }, 60_000);
});
