import { BUILTIN_CATALOG } from '@controls/catalog';
import { createReplayLog, createWorld, LEAD_SIM_BAG_V3, migrateWorld, World } from '@controls/save-format';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorldReferences, terminalProblem } from './devices';
import { createWorldBus, rebaseReplayLog, toReplayLog } from './session';
import type { Entity } from './types';

const T = { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } };
const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const SPST = { id: 'switch.tessaline-spst-toggle', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const CRATE = { id: 'prop.crate', version: 1 };

const entity = (id: number, ref: Entity['ref'], state: Entity['state'] = {}, sim: Entity['sim'] = {}): Entity => ({
  id,
  ref,
  transform: T,
  state,
  sim,
  mountedOn: null,
  label: null,
  extensions: {},
});

function world(entities: Entity[], connections: World['connections'] = []): World {
  return World.parse({
    ...createWorld({ seed: 1 }),
    nextEntityId: 10,
    nextConnectionId: 10,
    entities,
    connections,
  });
}

const lead = (id: number, a: [number, string], b: [number, string], ref = LEAD) => ({
  id,
  ref,
  a: { entity: a[0], terminal: a[1], termination: null },
  b: { entity: b[0], terminal: b[1], termination: null },
  cable: null,
  route: null,
  lengthMm: null,
  colour: null,
  label: null,
  state: {},
  sim: { ...LEAD_SIM_BAG_V3 },
  extensions: {},
});

const fixtures = join(import.meta.dirname, '../../../save-format/fixtures');
const levels = join(import.meta.dirname, '../../../../../content/levels');
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('checkWorldReferences (the invalid-device-state load check)', () => {
  it('accepts devices whose bags match their model kind, and leads on real terminals', () => {
    const good = world(
      [entity(1, BATTERY, {}, { stateOfCharge: 0.5 }), entity(2, SPST, { closed: true })],
      [lead(1, [1, 'pos'], [2, 'a']), lead(2, [2, 'b'], [1, 'neg'])],
    );
    expect(checkWorldReferences(good)).toStrictEqual([]);
    expect(checkWorldReferences(good, BUILTIN_CATALOG)).toStrictEqual([]);
  });

  it('checks each device’s bags against its model kind', () => {
    expect(checkWorldReferences(world([entity(1, SPST)]))).toStrictEqual([
      { path: 'entities[0].state.closed', message: 'Missing (an absent value is null, never a missing key)' },
    ]);
    expect(checkWorldReferences(world([entity(1, BATTERY, {}, { stateOfCharge: 2 })]))).toStrictEqual([
      { path: 'entities[0].sim.stateOfCharge', message: 'Not a valid battery stateOfCharge value' },
    ]);
  });

  it('refuses a lamp filament temperature outside 200–3600 K (a 1 K save would give a negative R, F2.5 review)', () => {
    const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
    const lamp = (filamentTempK: number | null) =>
      checkWorldReferences(world([entity(1, LAMP, {}, { filamentTempK })]));
    for (const ok of [null, 200, 293.15, 3600]) expect(lamp(ok)).toStrictEqual([]);
    for (const bad of [1, 65, 199.9, 3600.1]) {
      expect(lamp(bad)).toStrictEqual([
        { path: 'entities[0].sim.filamentTempK', message: 'Not a valid lamp.incandescent filamentTempK value' },
      ]);
    }
  });

  it("checks each control's value against the entry's control range (a crafted 1e9 V setpoint)", () => {
    const SUPPLY = { id: 'supply.brindlecore-bench-30v-5a', version: 1 };
    const state = { currentLimitA: 1, outputOn: false, setpointV: 12 };
    expect(checkWorldReferences(world([entity(1, SUPPLY, state, { mode: 'cv' })]))).toStrictEqual([]);
    expect(
      checkWorldReferences(
        world([entity(1, SUPPLY, { ...state, setpointV: 1e9, currentLimitA: 5.5 }, { mode: 'cv' })]),
      ),
    ).toStrictEqual([
      { path: 'entities[0].state.setpointV', message: 'Voltage takes a number from 0 to 30 V' },
      { path: 'entities[0].state.currentLimitA', message: 'Current limit takes a number from 0 to 5 A' },
    ]);
    // A value its key refuses is reported once, by the bag check, not again by the control check.
    expect(
      checkWorldReferences(world([entity(1, SUPPLY, { ...state, setpointV: -1 }, { mode: 'cv' })])).map((i) => i.path),
    ).toStrictEqual(['entities[0].state.setpointV']);
  });

  it('built-in props have no device state; unknown refs round-trip untouched', () => {
    expect(checkWorldReferences(world([entity(1, CRATE, { lit: true }, { x: 1 })]))).toStrictEqual([
      { path: 'entities[0].state', message: 'A built-in prop has no device state' },
      { path: 'entities[0].sim', message: 'A built-in prop has no device state' },
    ]);
    const modDevice = entity(1, { id: 'mod.example-relay', version: 2 }, { coil: true }, { hot: 0.5 });
    expect(checkWorldReferences(world([modDevice]))).toStrictEqual([]);
  });

  it('a lead can’t be placed as an entity, and a connection’s ref must be a connection kind', () => {
    expect(checkWorldReferences(world([entity(1, LEAD)]))).toStrictEqual([
      { path: 'entities[0].ref', message: 'lead is a connection kind, not a placed device' },
    ]);
    const devices = [entity(1, SPST, { closed: false }), entity(2, SPST, { closed: false })];
    expect(checkWorldReferences(world(devices, [lead(1, [1, 'a'], [2, 'a'], SPST)]))).toStrictEqual([
      { path: 'connections[0].ref', message: 'switch.spst is not a connection kind' },
    ]);
    const modLead = lead(1, [1, 'a'], [2, 'a'], { id: 'mod.example-jumper', version: 1 });
    expect(checkWorldReferences(world(devices, [modLead]))).toStrictEqual([]);
  });

  it('every lead end is a terminal of its entity’s device, never a prop, without echoing the terminal', () => {
    const devices = [entity(1, SPST, { closed: false }), entity(2, CRATE), entity(3, { id: 'mod.x', version: 1 })];
    const issues = checkWorldReferences(
      world(devices, [lead(1, [1, 'secretTerminal'], [2, 'a']), lead(2, [1, 'a'], [3, 'anything'])]),
    );
    expect(issues).toStrictEqual([
      { path: 'connections[0].a.terminal', message: "Not a terminal of the entity's device" },
      { path: 'connections[0].b.terminal', message: 'A built-in prop has no terminals' },
    ]);
    expect(JSON.stringify(issues)).not.toContain('secretTerminal');
  });

  it('terminalProblem names the reason', () => {
    expect(terminalProblem(entity(1, SPST), 'a')).toBeNull();
    expect(terminalProblem(entity(1, SPST), 'c')).toBe('unknown-terminal');
    expect(terminalProblem(entity(1, CRATE), 'a')).toBe('prop');
    expect(terminalProblem(entity(1, { id: 'mod.x', version: 1 }), 'a')).toBeNull();
  });

  it('reports at most 20 issues', () => {
    const many = Array.from({ length: 30 }, (_, i) => entity(i + 1, SPST));
    expect(World.parse({ ...world([]), nextEntityId: 31, entities: many }).entities).toHaveLength(30);
    expect(checkWorldReferences(World.parse({ ...world([]), nextEntityId: 31, entities: many }))).toHaveLength(20);
  });

  it('every level, every v2 world fixture (migrated) and every v3 world fixture passes', () => {
    const paths = [
      ...readdirSync(levels).map((name) => join(levels, name)),
      ...['empty', 'props-and-extensions', 'devices-sim-null', 'bench-lamp-mid-interval'].map((name) =>
        join(fixtures, 'v2/world', `${name}.json`),
      ),
      ...readdirSync(join(fixtures, 'v3/world'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(fixtures, 'v3/world', name)),
    ];
    for (const path of paths) {
      const loaded = migrateWorld(json(path));
      if (!loaded.ok) throw new Error(`${path}: ${loaded.error.message}`);
      // The bench-lamp fixture's fuses and the v3 fixtures' conductors, cables, boxes and panels aren't
      // in the catalogue yet: unknown refs, left alone.
      expect(checkWorldReferences(loaded.value), path).toStrictEqual([]);
    }
  });
});

describe('rebaseReplayLog edge cases', () => {
  const initial = world([]);
  const live = createWorldBus(initial);
  live.exec('entity.place', { ref: CRATE, positionMm: { x: 0, y: 0, z: 0 } });
  live.exec('entity.place', { ref: CRATE, positionMm: { x: 10, y: 0, z: 0 } });
  live.exec('edit.undo');
  const log = toReplayLog(initial, live);

  it('rebasing after 0 entries, or all of them, is exact', () => {
    const none = rebaseReplayLog(log, 0);
    expect(none.ok && none.log).toStrictEqual(log);
    const all = rebaseReplayLog(log, log.entries.length);
    expect(all.ok && all.log).toStrictEqual(createReplayLog(live.state, [], { firstSeq: 3, endTick: log.endTick }));
  });

  it('refuses a cut outside the log, or one a later undo reaches across', () => {
    for (const count of [-1, 4, 1.5]) {
      expect(rebaseReplayLog(log, count)).toMatchObject({ ok: false, error: { kind: 'out-of-range' } });
    }
    // The undo (seq 2) pops the place at seq 1: cutting between them loses that history.
    expect(rebaseReplayLog(log, 2)).toMatchObject({ ok: false, error: { kind: 'failed', seq: 2 } });
  });

  it('refuses a log whose head no longer replays', () => {
    const broken = createReplayLog(initial, [{ seq: 0, tick: 0, id: 'entity.delete', args: { id: 99 } }]);
    expect(rebaseReplayLog(broken, 1)).toMatchObject({ ok: false, error: { kind: 'failed', seq: 0 } });
  });
});

describe('rebaseReplayLog onto a given world at the cut (ADR 0013, P3 D19)', () => {
  // Commands at ticks 0, 5 and 12; the cut world is at tick 10 (between seq 1 and seq 2).
  const initial = world([]);
  const live = createWorldBus(initial);
  live.exec('entity.place', { ref: CRATE, positionMm: { x: 0, y: 0, z: 0 } });
  live.advanceTo(5);
  live.exec('entity.place', { ref: CRATE, positionMm: { x: 10, y: 0, z: 0 } });
  live.advanceTo(10);
  // What a checkpoint holds: the world at the cut, here marked (an extension) so it differs from the replayed one.
  const atCut: World = { ...live.state, entities: live.state.entities.map((e) => ({ ...e, extensions: { cut: 1 } })) };
  live.advanceTo(12);
  live.exec('entity.move', { id: 11, positionMm: { x: 20, y: 0, z: 0 } });
  live.advanceTo(15);
  const log = toReplayLog(initial, live);

  it('starts the log from that world, without replaying the head, and keeps the tail, seqs and endTick', () => {
    const result = rebaseReplayLog(log, 2, atCut);
    expect(result.ok && result.log).toStrictEqual(
      createReplayLog(atCut, log.entries.slice(2), { firstSeq: 2, endTick: 15 }),
    );
    // The head isn't replayed: even a head that no longer replays rebases (the caller vouches for it).
    const broken = { ...log, entries: [{ ...log.entries[0], args: { id: 99 } }, ...log.entries.slice(1)] };
    expect(rebaseReplayLog(broken, 2, atCut).ok).toBe(true);
  });

  it('accepts a cut world at either end of the gap, and none outside it or of another seed', () => {
    expect(rebaseReplayLog(log, 2, { ...atCut, tick: 5 }).ok).toBe(true); // the head's last entry
    expect(rebaseReplayLog(log, 2, { ...atCut, tick: 12 }).ok).toBe(true); // the tail's first
    expect(rebaseReplayLog(log, 3, { ...atCut, tick: 15 }).ok).toBe(true); // empty tail: up to endTick
    expect(rebaseReplayLog(log, 0, { ...atCut, tick: 0 }).ok).toBe(true); // empty head: from the start
    for (const [count, cut] of [
      [2, { ...atCut, tick: 4 }],
      [2, { ...atCut, tick: 13 }],
      [3, { ...atCut, tick: 16 }],
      [2, { ...atCut, seed: atCut.seed + 1 }],
    ] as const) {
      expect(rebaseReplayLog(log, count, cut)).toMatchObject({ ok: false, error: { kind: 'out-of-range' } });
    }
    expect(rebaseReplayLog(log, 4, atCut)).toMatchObject({ ok: false, error: { kind: 'out-of-range' } });
  });

  it('refuses a cut that a later undo reaches across, and keeps one whose undos stay in the tail', () => {
    const undoing = createWorldBus(initial);
    undoing.exec('entity.place', { ref: CRATE, positionMm: { x: 0, y: 0, z: 0 } });
    undoing.advanceTo(10);
    const cut = undoing.state;
    undoing.exec('entity.place', { ref: CRATE, positionMm: { x: 10, y: 0, z: 0 } });
    undoing.exec('edit.undo'); // pops the place at tick 10: inside the tail
    expect(rebaseReplayLog(toReplayLog(initial, undoing), 1, cut).ok).toBe(true);
    undoing.exec('edit.undo'); // pops the place at tick 0: across the cut
    expect(rebaseReplayLog(toReplayLog(initial, undoing), 1, cut)).toMatchObject({
      ok: false,
      error: { kind: 'failed', seq: 3 },
    });
  });
});
