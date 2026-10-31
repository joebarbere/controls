import {
  createManifest,
  createReplayLog,
  migrateReplayLog,
  readCtrl,
  type World,
  writeCtrl,
} from '@controls/save-format';
import {
  ENGINE_BENCH,
  ENGINE_TEST_CATALOG,
  engineTestOptions,
  I2T_FUSE,
  THERMAL_LOAD,
} from '@controls/sim-core/testing';
import { decodeSnapshot } from '@controls/sim-protocol';
import { createWorldRegistry, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineCompatible } from './engine-compat';
import {
  BUILD_ENGINE_VERSIONS,
  createGame,
  type Game,
  GameOptionsError,
  loadGame,
  MAX_VERIFY_TICKS,
  ProbeError,
  replayGame,
  replayLogGame,
  TOO_LONG_TO_VERIFY_MESSAGE,
} from './game';

/*
 * The sim in the scripting API (plan F2.3a): time, `sim.step`, `probe`, snapshots and sim events,
 * materialised hashes and saves, D8's `engineCompatible` and the load paths it picks.
 */

const engine = engineTestOptions();
const registry = () => createWorldRegistry({ catalog: ENGINE_TEST_CATALOG });

/** A game on the engine test catalogue (synthetic thermal load and I²t fuse), with the bench built. */
function bench(seed = 11): Game {
  const game = createGame({ seed, registry: registry(), engine });
  for (const [id, args] of ENGINE_BENCH) game.execOrThrow(id, args);
  return game;
}

function load(bytes: Uint8Array) {
  const result = loadGame(bytes, { registry: registry(), engine });
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

describe('engineCompatible (D8, narrow v0 compatibility)', () => {
  const build = { simEngineVersion: 2, catalogVersion: 1 };
  it.each([
    [{ simEngineVersion: 2, catalogVersion: 1 }, 'verify'],
    [{ simEngineVersion: 0, catalogVersion: 0 }, 'verify-v0'],
    [{ simEngineVersion: 0, catalogVersion: 1 }, 'engine-changed'],
    [{ simEngineVersion: 2, catalogVersion: 0 }, 'engine-changed'],
    [{ simEngineVersion: 1, catalogVersion: 1 }, 'engine-changed'],
    [{ simEngineVersion: 2, catalogVersion: 2 }, 'engine-changed'],
    [{ simEngineVersion: 3, catalogVersion: 1 }, 'engine-changed'],
  ] as const)('%o → %s', (manifest, expected) => {
    expect(engineCompatible(manifest, build)).toBe(expected);
  });

  it('is pure: a function of the four numbers alone, a single 0 never counting as compatible (property)', () => {
    const version = fc.oneof(fc.constant(0), fc.nat({ max: 4 }));
    fc.assert(
      fc.property(version, version, version, version, (se, ce, sb, cb) => {
        const result = engineCompatible(
          { simEngineVersion: se, catalogVersion: ce },
          { simEngineVersion: sb, catalogVersion: cb },
        );
        if (se === sb && ce === cb) expect(result).toBe('verify');
        else if (se === 0 && ce === 0) expect(result).toBe('verify-v0');
        else expect(result).toBe('engine-changed');
      }),
    );
    expect(BUILD_ENGINE_VERSIONS).toStrictEqual({ simEngineVersion: 3, catalogVersion: 1 });
  });
});

describe('time in the scripting API (ADR 0011 §3)', () => {
  it('advance and advanceTo move the tick without logging or touching the history', () => {
    const game = bench();
    const entries = game.entries().length;
    const canUndo = game.canUndo();
    game.advance(25);
    expect(game.tick()).toBe(25);
    game.advanceTo(40);
    game.advance(0);
    expect(game.tick()).toBe(40);
    expect(game.world().tick).toBe(40);
    expect(game.entries()).toHaveLength(entries);
    expect(game.canUndo()).toBe(canUndo);
    expect(game.execOrThrow('view.resetLayout')).toMatchObject({ tick: 40 });
    expect(() => game.advance(-1)).toThrow(RangeError);
    expect(() => game.advance(1.5)).toThrow(RangeError);
    expect(() => game.advanceTo(39)).toThrow(RangeError);
    expect(() => game.advanceTo(Number.NaN)).toThrow(RangeError);
  });

  it('sim.step is logged at its tick and advances by its ticks, so the next command is stamped there', () => {
    const game = bench();
    const states: number[] = [];
    game.on('executed', (event) => states.push(event.state.tick));
    expect(game.execOrThrow('sim.step', { ticks: 250 })).toMatchObject({ seq: 9, tick: 0, id: 'sim.step' });
    expect(game.tick()).toBe(250);
    expect(game.execOrThrow('sim.setSpeed', { speed: 0 })).toMatchObject({ tick: 250 }); // a no-op headless
    expect(game.execOrThrow('sim.resume')).toMatchObject({ tick: 250 });
    expect(game.tick()).toBe(250);
    expect(states).toStrictEqual([250, 250, 250]); // listeners see the world after the step
    // Replay: the step itself doesn't move time, the next entry's tick and endTick carry it.
    const replayed = replayGame(JSON.parse(JSON.stringify(game.replayLog())), { registry: registry(), engine });
    expect(replayed.ok && [replayed.game.tick(), replayed.game.hash(), replayed.game.snapshotHash()]).toStrictEqual([
      250,
      game.hash(),
      game.snapshotHash(),
    ]);
  });

  it('time passing heats the load and blows the fuse: sim events reach game.on("sim"), in order', () => {
    const game = bench();
    const events: unknown[] = [];
    game.on('sim', (event) => events.push(event));
    game.advance(100);
    expect(events).toStrictEqual([]);
    game.advance(400);
    expect(events).toStrictEqual([{ tick: expect.any(Number), kind: 'blown', entity: 4, entities: [], detail: {} }]);
    const again = bench();
    const replayedEvents: unknown[] = [];
    again.on('sim', (event) => replayedEvents.push(event));
    again.advance(500);
    expect(replayedEvents).toStrictEqual(events);
    const unsubscribe = again.on('sim', () => {
      throw new Error('unsubscribed');
    });
    unsubscribe();
    again.execOrThrow('entity.delete', { id: 4 });
  });
});

describe('game.probe: ideal and non-loading', () => {
  it('reads DC volts between two terminals, red on a, black on b', () => {
    const game = bench();
    const reading = game.probe('1:pos', '1:neg');
    expect(reading).toMatchObject({ kind: 'dc', tick: 0, solvedAt: 0 });
    const volts = reading.kind === 'dc' ? reading.volts : Number.NaN;
    expect(volts).toBeGreaterThan(11);
    expect(volts).toBeLessThan(12);
    const reversed = game.probe('1:neg', '1:pos');
    expect(reversed.kind === 'dc' && reversed.volts).toBe(-volts);
    // Non-loading: probing changes nothing.
    expect(game.probe('1:pos', '1:neg')).toStrictEqual(reading);
    expect(game.entries()).toHaveLength(ENGINE_BENCH.length);
  });

  it('reports floating across islands, and unsolved on an unmodelled island', () => {
    const game = bench();
    game.execOrThrow('entity.place', {
      ref: { id: 'lamp.lumivane-12v-5w', version: 1 },
      positionMm: { x: 0, y: 0, z: 0 },
    });
    expect(game.probe('1:pos', '5:a')).toStrictEqual({ kind: 'floating', tick: 0 });
    expect(game.probe('5:a', '5:b')).toMatchObject({ kind: 'unsolved', reason: 'unmodelled' });
    expect(game.islands().map((i) => i.status)).toStrictEqual(['solved', 'unmodelled']);
  });

  it('reads an AC island as RMS volts with a display-only phase, at the region frequency', () => {
    const game = createGame({ seed: 4, registry: registry(), engine });
    const at = { x: 0, y: 0, z: 0 };
    game.execOrThrow('entity.place', { ref: { id: 'source.test-ac-120v', version: 1 }, positionMm: at });
    game.execOrThrow('entity.place', { ref: THERMAL_LOAD, positionMm: at });
    const lead = { id: 'lead.quillfern-test-1m', version: 1 };
    game.execOrThrow('lead.connect', { ref: lead, a: { entity: 1, terminal: 'l' }, b: { entity: 2, terminal: 'a' } });
    game.execOrThrow('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'n' } });
    const hash = game.hash();
    const reading = game.probe('1:l', '1:n');
    if (reading.kind !== 'ac') throw new Error(`expected an AC reading, got ${reading.kind}`);
    expect(reading.frequencyHz).toBe(60);
    expect(reading.rmsVolts).toBeGreaterThan(100);
    expect(reading.rmsVolts).toBeLessThan(120);
    expect(Math.abs(reading.phaseDeg)).toBeLessThan(1e-6); // a resistive loop: in phase with the source
    const reversed = game.probe('1:n', '1:l');
    expect(reversed.kind === 'ac' && Math.abs(Math.abs(reversed.phaseDeg) - 180)).toBeLessThan(1e-6);
    expect(reversed.kind === 'ac' && reversed.rmsVolts).toBe(reading.rmsVolts);
    expect(game.hash()).toBe(hash); // probing changes nothing, and no angle is hashed
    expect(game.islands().map((i) => [i.kind, i.status])).toStrictEqual([['ac', 'solved']]);
  });

  it('refuses a malformed end or one that names no netlisted terminal', () => {
    const game = bench();
    for (const bad of ['', '1', ':pos', '0:pos', 'x:pos', '1:', '1:no space', '01:pos']) {
      expect(() => game.probe(bad, '1:neg')).toThrow(expect.objectContaining({ code: 'invalid-terminal', end: 'a' }));
    }
    expect(() => game.probe('1:pos', 42 as unknown as string)).toThrow(ProbeError);
    expect(() => game.probe('1:pos', '9:a')).toThrow(expect.objectContaining({ code: 'unknown-terminal', end: 'b' }));
    expect(() => game.probe('1:nope', '1:pos')).toThrow(
      expect.objectContaining({ code: 'unknown-terminal', end: 'a' }),
    );
  });
});

describe('materialised hashes and saves', () => {
  it('world.hash covers the materialised sim state; world() stays the commanded world', () => {
    const game = bench();
    game.advance(55);
    expect(game.world().sim).toBeNull(); // inert: as the session started
    expect(game.materialisedWorld().sim?.lastSolveTick).toBe(50);
    expect(game.hash()).toBe(worldHash(game.materialisedWorld() as World));
    expect(game.hash()).not.toBe(worldHash(game.world() as World));
    expect(decodeSnapshot(game.snapshot())).toMatchObject({ tick: 55, lastSolveTick: 50 });
    const hash = game.hash();
    game.advance(1);
    expect(game.hash()).not.toBe(hash); // the load heated
  });

  it('a save at a mid-interval tick loads, verifies (continued) and runs on exactly like the original', () => {
    const game = bench();
    game.advance(37);
    const loaded = load(game.save());
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
    expect(loaded.game.snapshot()).toStrictEqual(game.snapshot());
    for (const g of [game, loaded.game]) {
      g.advance(400);
      g.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
      g.advance(13);
    }
    expect(loaded.game.snapshot()).toStrictEqual(game.snapshot());
    expect(loaded.game.hash()).toBe(game.hash());
  });

  it('deleting a blown fuse, saving, loading and placing a fuse equals a straight run (ADR 0011 §3 tombstones)', () => {
    const play = (g: Game) => {
      g.execOrThrow('entity.place', { ref: I2T_FUSE, positionMm: { x: 0, y: 0, z: 0 } });
      g.execOrThrow('lead.connect', {
        ref: { id: 'lead.quillfern-test-1m', version: 1 },
        a: { entity: 5, terminal: 'a' },
        b: { entity: 1, terminal: 'pos' },
      });
      g.advance(30);
    };
    const straight = bench();
    straight.advance(1_000); // fuse 4 has blown
    straight.execOrThrow('entity.delete', { id: 4 });
    const loaded = load(straight.save()).game;
    play(straight);
    play(loaded);
    expect(loaded.hash()).toBe(straight.hash());
    expect(loaded.snapshot()).toStrictEqual(straight.snapshot());
  });

  // T anywhere in the first 0.4 s (the fuse blows at about 0.15 s), then up to 0.4 s more.
  const cutArb = fc.tuple(fc.nat({ max: 400 }), fc.nat({ max: 400 }), fc.boolean());

  it('the cuts fall mid-interval, before and after the fuse blows (generator health)', () => {
    const samples = fc.sample(cutArb, { seed: 20261031, numRuns: 100 });
    // Measured on this seed: 89, 44 and 40 of 100.
    expect(samples.filter(([t]) => t % 10 !== 0).length).toBeGreaterThan(75);
    expect(samples.filter(([t]) => t < 120).length).toBeGreaterThan(30);
    expect(samples.filter(([t]) => t > 200).length).toBeGreaterThan(30);
  });

  it('saving at T, loading and advancing to T2 equals running straight to T2 (property, through .ctrl bytes)', () => {
    fc.assert(
      fc.property(cutArb, ([t, more, open]) => {
        const straight = bench();
        straight.advance(t);
        const loaded = load(straight.save()).game;
        for (const g of [straight, loaded]) {
          if (open) g.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
          g.advance(more);
        }
        expect(loaded.snapshot()).toStrictEqual(straight.snapshot());
        expect(loaded.hash()).toBe(straight.hash());
      }),
      { numRuns: 12 },
    );
  });
});

describe('loading saves from other engines (D8)', () => {
  function saveWith(game: Game, versions: { simEngineVersion: number; catalogVersion: number }, mutateLog = false) {
    const read = readCtrl(game.save());
    if (!read.ok) throw new Error(read.error.message);
    const log = read.value.replayLog as NonNullable<typeof read.value.replayLog>;
    const replayLog = mutateLog ? { ...log, entries: log.entries.slice(0, -1) } : log;
    return writeCtrl({ ...read.value, manifest: createManifest(versions), replayLog });
  }

  it('engine-changed: loads world.json as saved with a new log, without replaying it', () => {
    const game = bench();
    game.advance(20);
    for (const versions of [
      { simEngineVersion: 1, catalogVersion: 1 },
      { simEngineVersion: 0, catalogVersion: 1 }, // a single 0 is not the v0 rule
      { simEngineVersion: 2, catalogVersion: 0 },
    ]) {
      const loaded = load(saveWith(game, versions, true)); // its log wouldn't even replay
      expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
      expect(loaded.game.hash()).toBe(game.hash());
      expect(loaded.game.entries()).toStrictEqual([]);
      // The new log continues the saved log's numbering (its last entry was cut off above).
      expect(loaded.game.execOrThrow('view.resetLayout')).toMatchObject({ seq: game.entries().length - 1 });
    }
  });

  it('verify-v0: a migrated P1 save is verified, and a failure restarts as engine-changed, never refused', () => {
    const game = createGame({ seed: 3, registry: registry(), engine });
    game.execOrThrow('entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 0, y: 0, z: 0 } });
    game.execOrThrow('entity.move', { id: 1, positionMm: { x: 5, y: 0, z: 0 } });
    expect(load(saveWith(game, { simEngineVersion: 0, catalogVersion: 0 })).replay).toStrictEqual({
      status: 'continued',
    });
    expect(load(saveWith(game, { simEngineVersion: 0, catalogVersion: 0 }, true)).replay).toMatchObject({
      status: 'restarted',
      reason: 'engine-changed',
    });
    // The same broken log from this build's engine is a mismatch, as in P1.
    expect(load(saveWith(game, BUILD_ENGINE_VERSIONS, true)).replay).toMatchObject({
      status: 'restarted',
      reason: 'hash-mismatch',
    });
  });

  it('refuses a save whose solution record does not fit its circuit (start-failed)', () => {
    const game = bench();
    const read = readCtrl(game.save());
    if (!read.ok) throw new Error(read.error.message);
    const world = read.value.world;
    const bad = { ...world, sim: { ...(world.sim as NonNullable<World['sim']>), topologyHash: 'f'.repeat(64) } };
    const bytes = writeCtrl({ ...read.value, world: bad, replayLog: null });
    const result = loadGame(bytes, { registry: registry(), engine });
    expect(result).toMatchObject({ ok: false, error: { kind: 'start-failed', reason: 'topology-mismatch' } });
    expect(() => createGame({ world: bad, registry: registry(), engine })).toThrow(GameOptionsError);
    const log = createReplayLog(bad);
    expect(replayLogGame(log, { registry: registry(), engine })).toMatchObject({
      ok: false,
      error: { kind: 'start-failed', reason: 'topology-mismatch' },
    });
  });

  it('never refuses an engine-changed save whose record does not fit: it drops the record and solves at the save tick', () => {
    const game = bench();
    game.advance(37);
    const read = readCtrl(game.save());
    if (!read.ok) throw new Error(read.error.message);
    const sim = read.value.world.sim as NonNullable<World['sim']>;
    for (const bad of [
      { ...sim, topologyHash: 'f'.repeat(64) },
      { ...sim, nodes: sim.nodes.slice(2) },
      { ...sim, islands: [...sim.islands, { flags: 0, iterations: 1 }] },
    ]) {
      for (const versions of [
        { simEngineVersion: 1, catalogVersion: 1 },
        { simEngineVersion: 0, catalogVersion: 0 },
      ]) {
        const bytes = writeCtrl({
          ...read.value,
          manifest: createManifest(versions),
          world: { ...read.value.world, sim: bad },
        });
        const loaded = load(bytes);
        expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
        expect(loaded.game.tick()).toBe(37);
        // Solved afresh at the save's tick: the record's values were another engine's.
        expect(loaded.game.materialisedWorld().sim?.lastSolveTick).toBe(37);
        expect(loaded.game.world().sim).toBeNull();
      }
    }
  });

  it('restarts a log spanning more than MAX_VERIFY_TICKS without replaying it (a crafted endTick never hangs a load)', () => {
    expect(MAX_VERIFY_TICKS).toMatchObject({ value: 10_000, unit: 'tick', kind: 'numerical' });
    const game = bench();
    game.advance(MAX_VERIFY_TICKS.value);
    expect(load(game.save()).replay).toStrictEqual({ status: 'continued' }); // at the bound: verified
    const read = readCtrl(game.save());
    if (!read.ok) throw new Error(read.error.message);
    const log = read.value.replayLog as NonNullable<typeof read.value.replayLog>;
    const huge = 1e12;
    const bytes = writeCtrl({
      ...read.value,
      world: { ...read.value.world, tick: huge },
      replayLog: { ...log, endTick: huge },
    });
    const loaded = load(bytes);
    expect(loaded.replay).toStrictEqual({
      status: 'restarted',
      reason: 'too-long-to-verify',
      message: TOO_LONG_TO_VERIFY_MESSAGE,
    });
    expect(loaded.game.tick()).toBe(huge);
    expect(loaded.game.entries()).toStrictEqual([]);
    game.advance(1);
    expect(load(game.save()).replay).toMatchObject({ reason: 'too-long-to-verify' }); // one past the bound
  });
});

describe('v1 logs replay unchanged with the engine (P1 fixtures)', () => {
  const root = join(import.meta.dirname, '../../../save-format/fixtures/v1');
  const logs = [
    JSON.parse(readFileSync(join(root, 'replay-log/place-move-delete-undo.json'), 'utf8')),
    ...readdirSync(join(root, 'ctrl'))
      .map((name) => readCtrl(new Uint8Array(readFileSync(join(root, 'ctrl', name)))))
      .flatMap((read) => (read.ok && read.value.replayLog !== null ? [read.value.replayLog] : [])),
  ];

  it('every prefix of every P1 log replays to the same world with the engine as without it (property)', () => {
    expect(logs.length).toBeGreaterThanOrEqual(3);
    fc.assert(
      fc.property(fc.nat({ max: logs.length - 1 }), fc.nat({ max: 40 }), (which, cut) => {
        const migrated = migrateReplayLog(logs[which]);
        if (!migrated.ok) throw new Error(migrated.error.message);
        const log = migrated.value;
        const entries = log.entries.slice(0, cut % (log.entries.length + 1));
        const prefix = createReplayLog(log.initialWorld, entries, { firstSeq: log.firstSeq });
        const withEngine = replayLogGame(prefix);
        const without = replayLogGame(prefix, { engine: false });
        if (!withEngine.ok || !without.ok) throw new Error('a P1 log failed to replay');
        expect(withEngine.game.hash()).toBe(without.game.hash());
        expect(withEngine.game.materialisedWorld()).toStrictEqual(without.game.world());
        expect(withEngine.game.tick()).toBe(0);
        expect(withEngine.game.entries()).toStrictEqual(without.game.entries());
      }),
      { numRuns: 60 },
    );
  });
});
