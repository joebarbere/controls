import { readCtrl, type ReplayEntry, type ReplayLog, type World } from '@controls/save-format';
import { ENGINE_BENCH, ENGINE_TEST_CATALOG, engineTestOptions } from '@controls/sim-core/testing';
import { createWorldRegistry, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { CHECKPOINT_TICKS, createGame, type Game, loadGame, MAX_VERIFY_TICKS, type TimeHost, writeSave } from './game';

/*
 * Save checkpoints (P3 kickoff step 4, decision D19): whenever time reaches a multiple of
 * `CHECKPOINT_TICKS`, a game keeps the materialised world at that tick, and a save rebases its replay
 * log onto the latest one (`rebaseReplayLog(log, count, worldAtCut)`, ADR 0013), so the log a load
 * verifies spans less than `MAX_VERIFY_TICKS` and long sessions load `continued`.
 */

const engine = engineTestOptions();
const registry = () => createWorldRegistry({ catalog: ENGINE_TEST_CATALOG });
const crate = { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 5, y: 0, z: 5 } };
const every = CHECKPOINT_TICKS.value;

/**
 * The engine test bench (a battery through a switch and an I²t fuse into a thermal load), switched
 * off at once so the fuse never blows and the load cools: long runs stay electrically interesting
 * (each switching re-solves) without the fuse ending the circuit.
 */
function bench(seed = 11): Game {
  const game = createGame({ seed, registry: registry(), engine });
  for (const [id, args] of ENGINE_BENCH) game.execOrThrow(id, args);
  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
  return game;
}

function load(bytes: Uint8Array) {
  const result = loadGame(bytes, { registry: registry(), engine });
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function savedLog(bytes: Uint8Array): ReplayLog {
  const read = readCtrl(bytes);
  if (!read.ok || read.value.replayLog === null) throw new Error('no replay log');
  return read.value.replayLog;
}

/** One step of a session: let time pass, then maybe a command (undo and redo may fail: not logged). */
type Action = 'none' | 'toggle' | 'place' | 'undo' | 'redo';
interface Step {
  readonly ticks: number;
  readonly action: Action;
}

function play(game: Game, steps: readonly Step[]): void {
  for (const { ticks, action } of steps) {
    game.advance(ticks);
    if (action === 'toggle') {
      const closed = game.world().entities.find((e) => e.id === 2)?.state['closed'] === true;
      game.execOrThrow('device.operate', { id: 2, control: 'closed', value: !closed });
    } else if (action === 'place') game.execOrThrow('entity.place', crate);
    else if (action === 'undo') game.exec('edit.undo');
    else if (action === 'redo') game.exec('edit.redo');
  }
}

/** The tick of the latest checkpoint at or before `tick`, for a game that started at 0. */
const lastCut = (tick: number) => tick - (tick % every);

describe('CHECKPOINT_TICKS (D19)', () => {
  it('equals MAX_VERIFY_TICKS and is a sourced numerical choice', () => {
    expect(CHECKPOINT_TICKS).toMatchObject({ value: MAX_VERIFY_TICKS.value, unit: 'tick', kind: 'numerical' });
    expect(CHECKPOINT_TICKS.source).toMatch(/D19/);
  });
});

describe('a save rebases its log onto the latest checkpoint', () => {
  // A command at 5 000, one exactly on the 10 000 boundary, one at 15 000; saved at each tick below.
  function session(saveAt: number): Game {
    const game = bench();
    const steps: [number, () => void][] = [
      [5_000, () => game.execOrThrow('entity.place', crate)],
      [every, () => game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true })],
      [15_000, () => game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false })],
    ];
    for (const [tick, command] of steps) {
      if (tick > saveAt) break;
      game.advanceTo(tick);
      command();
    }
    game.advanceTo(saveAt);
    return game;
  }

  it.each([
    [9_999, 0, 0],
    [10_000, 10_000, 11],
    [10_001, 10_000, 11],
    [25_000, 20_000, 13],
  ])('saved at %i: the log starts at tick %i, after %i entries, and loads continued', (saveAt, base, count) => {
    const game = session(saveAt);
    const bytes = game.save();
    const log = savedLog(bytes);
    expect(log.initialWorld.tick).toBe(base);
    expect(log.firstSeq).toBe(count);
    expect(log.endTick).toBe(saveAt);
    expect(log.entries.map((e) => e.seq)).toStrictEqual(
      game
        .entries()
        .slice(count)
        .map((e) => e.seq),
    );
    expect(log.endTick - log.initialWorld.tick).toBeLessThan(MAX_VERIFY_TICKS.value);
    // The command at exactly 10 000 is after the checkpoint: the world there holds the switch open.
    if (saveAt >= every && saveAt < 20_000) expect(log.entries[0]).toMatchObject({ tick: every, seq: 11 });
    // The checkpoint is the materialised world at its tick, before any command there: a game run
    // straight to that tick and no further materialises the same world.
    if (base > 0) {
      const straight = session(base - 1);
      straight.advanceTo(base);
      expect(log.initialWorld).toStrictEqual(straight.materialisedWorld());
    }
    const loaded = load(bytes);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
    expect(loaded.game.snapshot()).toStrictEqual(game.snapshot());
    // The loaded game continues the same numbering, and a save straight away writes the same log.
    expect(savedLog(loaded.game.save())).toStrictEqual(log);
  });

  it('saveLog is the log save writes, and replayLog stays the whole log', async () => {
    const game = session(25_000);
    expect(await game.saveLog()).toStrictEqual(savedLog(game.save()));
    expect(game.replayLog().initialWorld.tick).toBe(0);
    expect(game.replayLog().entries).toHaveLength(13);
  });

  it('is deterministic: the same session saves the same bytes, run after run', () => {
    expect(session(25_000).save()).toStrictEqual(session(25_000).save());
    // However time was let pass: one jump, or many small steps across the boundaries.
    const jumped = bench();
    jumped.advance(23_456);
    const stepped = bench();
    while (stepped.tick() < 23_456) stepped.advance(Math.min(997, 23_456 - stepped.tick()));
    expect(stepped.save()).toStrictEqual(jumped.save());
  });

  it('takes a checkpoint when a sim.step crosses a boundary, the step itself before it', () => {
    const game = bench();
    game.execOrThrow('sim.step', { ticks: 12_000 });
    game.execOrThrow('entity.place', crate);
    const log = savedLog(game.save());
    expect(log.initialWorld.tick).toBe(every);
    expect(log.entries).toStrictEqual([game.entries().at(-1)]);
    expect(load(game.save()).replay).toStrictEqual({ status: 'continued' });
  });
});

describe('when an undo reaches across the checkpoint', () => {
  it('keeps the whole log (the rebase would not be exact), until the next checkpoint', () => {
    const game = bench();
    game.advanceTo(9_000);
    game.execOrThrow('entity.place', crate);
    game.advanceTo(11_000);
    game.execOrThrow('edit.undo'); // pops the place at 9 000, before the checkpoint at 10 000
    game.advanceTo(12_000);
    const bytes = game.save();
    expect(savedLog(bytes).initialWorld.tick).toBe(0);
    const loaded = load(bytes);
    expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
    expect(loaded.game.hash()).toBe(game.hash()); // the world is the save's, whatever the log
    game.advanceTo(20_500);
    const later = game.save();
    expect(savedLog(later).initialWorld.tick).toBe(20_000);
    expect(load(later).replay).toStrictEqual({ status: 'continued' });
  });

  it('rebases as usual when the undo stays after the checkpoint', () => {
    const game = bench();
    game.advanceTo(10_500);
    game.execOrThrow('entity.place', crate);
    game.advanceTo(11_000);
    game.execOrThrow('edit.undo');
    expect(savedLog(game.save()).initialWorld.tick).toBe(every);
    expect(load(game.save()).replay).toStrictEqual({ status: 'continued' });
  });
});

describe('a session saved at any tick, loaded and advanced, equals the uninterrupted run (property)', () => {
  const action = fc.constantFrom<Action>('none', 'toggle', 'place', 'undo', 'redo');
  // After the load only commands that don't depend on the history: a load clears it (ADR 0007), so an
  // undo there differs from the straight run's by design, checkpoint or not.
  const later = fc.constantFrom<Action>('none', 'toggle', 'place');
  const steps = fc.array(fc.record({ ticks: fc.nat({ max: 6_000 }), action }), { minLength: 1, maxLength: 8 });
  const afterSteps = fc.array(fc.record({ ticks: fc.nat({ max: 6_000 }), action: later }), { maxLength: 4 });

  it('generator health: sessions cross one and two checkpoints, and undo before the save', () => {
    const samples = fc.sample(fc.tuple(steps, afterSteps), { seed: 20261111, numRuns: 100 });
    const end = (s: readonly Step[]) => s.reduce((sum, step) => sum + step.ticks, 0);
    expect(samples.filter(([before]) => end(before) >= every).length).toBeGreaterThan(30);
    expect(samples.filter(([before]) => end(before) >= 2 * every).length).toBeGreaterThan(5);
    expect(samples.filter(([before]) => before.some((s) => s.action === 'undo')).length).toBeGreaterThan(30);
  });

  it('same world.hash and snapshot, and a load verifies whenever the rebase was exact', () => {
    fc.assert(
      fc.property(steps, afterSteps, (before, after) => {
        const straight = bench();
        play(straight, before);
        const bytes = straight.save();
        const saved = savedLog(bytes);
        const loaded = load(bytes);
        const tick = straight.tick();
        // The tail after the latest checkpoint: if no undo or redo in it, the rebase was exact.
        const cut = lastCut(tick);
        const tail = straight.entries().filter((e: ReplayEntry) => e.tick >= cut);
        if (!tail.some((e) => e.id === 'edit.undo' || e.id === 'edit.redo')) {
          expect(saved.initialWorld.tick).toBe(cut);
        }
        expect([0, cut]).toContain(saved.initialWorld.tick);
        if (saved.endTick - saved.initialWorld.tick <= MAX_VERIFY_TICKS.value) {
          expect(loaded.replay).toStrictEqual({ status: 'continued' });
        } else {
          expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'too-long-to-verify' });
        }
        expect(loaded.game.hash()).toBe(straight.hash());
        play(straight, after);
        play(loaded.game, after);
        expect(loaded.game.snapshot()).toStrictEqual(straight.snapshot());
        expect(loaded.game.hash()).toBe(straight.hash());
      }),
      { numRuns: 30 },
    );
    // Generous: each run plays up to ~72 000 ticks twice and loads a save, about 2.4 s for all 30 runs
    // locally; CI runs every project's tests in parallel with coverage, which took it past the 5 s default.
  }, 60_000);
});

describe('checkpoints with a time host (the game: the sim worker answers later)', () => {
  /**
   * A time host over an in-process engine (the worker's stand-in: it follows every entry and advance)
   * that answers `captureWorld` asynchronously, as the worker's `state` query does.
   */
  function workerLike(world: World, answer: 'resolve' | 'reject' | 'none') {
    const shadow = createGame({ world, registry: registry(), engine });
    const host: TimeHost = {
      advanceTo: (tick) => shadow.advanceTo(tick),
      applied: (entry) => void shadow.execOrThrow(entry.id, entry.args),
      captureWorld:
        answer === 'none'
          ? undefined
          : () => {
              const world = shadow.materialisedWorld() as World; // taken now, at the bus's tick
              return answer === 'resolve' ? Promise.resolve(world) : Promise.reject(new Error('crashed'));
            },
    };
    return { host, shadow };
  }

  async function run(answer: 'resolve' | 'reject' | 'none') {
    const start = bench().world() as World;
    const worker = workerLike(start, answer);
    const game = createGame({ world: start, registry: registry(), time: worker.host });
    game.advanceTo(12_000);
    game.execOrThrow('entity.place', crate);
    game.advanceTo(13_000);
    expect(() => game.save()).toThrow(/sim worker/); // no synchronous save in the game
    return { log: await game.saveLog(), whole: game.replayLog(), shadow: worker.shadow };
  }

  it('rebases onto the worker’s answer: the same log the headless game saves', async () => {
    const { log, shadow } = await run('resolve');
    expect(log.initialWorld.tick).toBe(every);
    const headless = createGame({ world: bench().world() as World, registry: registry(), engine });
    headless.advanceTo(12_000);
    headless.execOrThrow('entity.place', crate);
    headless.advanceTo(13_000);
    expect(log).toStrictEqual(savedLog(headless.save()));
    expect(worldHash(shadow.materialisedWorld() as World)).toBe(headless.hash());
    const loaded = load(writeSave(shadow.materialisedWorld() as World, log));
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
  });

  it('keeps the whole log if the worker never answered, or the host takes no checkpoints', async () => {
    for (const answer of ['reject', 'none'] as const) {
      const { log, whole } = await run(answer);
      expect(log).toStrictEqual(whole);
    }
  });
});
