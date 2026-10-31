import type { CommandBus } from '@controls/commands';
import { createWorld, migrateReplayLog, World } from '@controls/save-format';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { catalogRefArb, deepFreeze, rawWorldV2Arb } from '@controls/save-format/testing';
import fc from 'fast-check';
import { entityCommands } from './entity-commands';
import { worldHash } from './hash';
import { createWorldBus, createWorldRegistry, rebaseReplayLog, replayLog, toReplayLog } from './session';

/*
 * Plan F1.2 properties, over the real world commands:
 * - for any command sequence, undoing everything returns the initial hash;
 * - invert ∘ apply is the identity for every undoable command;
 * - replaying seed + log gives the live hash;
 * plus: view commands never change the hash, and every reachable world is a valid document;
 * and for world v2 (ADR 0011 §1 and §3, ADR 0013): every change keeps the tick, the solution record
 * and each surviving entity's `sim` bag, and a log rebased mid-session replays to the same hash.
 */

const coordinate = fc.integer({ min: -10_000_000, max: 10_000_000 });
const positionArb = fc.record({ x: coordinate, y: coordinate, z: coordinate });
const angle = fc.integer({ min: 0, max: 359_999 });
const delta = fc.integer({ min: -359_999, max: 359_999 });

/** An operation; `pick` chooses an existing entity (or, past the end, a missing id). */
type Op =
  | { kind: 'place'; ref: { id: string; version: number }; positionMm: object; orientationMdeg: object }
  | { kind: 'move'; pick: number; positionMm: object }
  | { kind: 'rotate'; pick: number; deltaMdeg: object }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'view' }
  | { kind: 'invalid' }
  | { kind: 'connect'; from: [number, number]; to: [number, number]; lead: boolean }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'operate'; pick: number; value: boolean };

const pick = fc.nat({ max: 8 });
const placeable = BUILTIN_CATALOG.devices
  .filter((d) => d.sizeMm !== null)
  .map((d) => ({ id: d.id, version: d.version }));
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('place' as const),
      // Catalogue devices (with state bags) as well as unknown refs.
      ref: fc.oneof(catalogRefArb, fc.constantFrom(...placeable)),
      positionMm: positionArb,
      orientationMdeg: fc.record({ yaw: angle, pitch: angle, roll: angle }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('move' as const), pick, positionMm: positionArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('rotate' as const),
      pick,
      deltaMdeg: fc.record({ yaw: delta, pitch: delta, roll: delta }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'view' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'invalid' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('connect' as const),
      from: fc.tuple(pick, fc.nat({ max: 2 })),
      to: fc.tuple(pick, fc.nat({ max: 2 })),
      lead: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('operate' as const), pick, value: fc.boolean() }) },
);

const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };

/** A terminal of the picked entity's device (or a made-up one, which the command refuses). */
function pickEnd(bus: CommandBus<World>, [entityIndex, terminalIndex]: [number, number]) {
  const entity = pickId(bus, entityIndex);
  const found = bus.state.entities.find((e) => e.id === entity);
  const terminals = (found && BUILTIN_CATALOG.device(found.ref)?.terminals) || [];
  return { entity, terminal: terminals[terminalIndex]?.id ?? 'a' };
}

const opsArb = fc.array(opArb, { maxLength: 25 });
/** Each op after time has passed (often none, so several commands share a tick), as in a running game. */
const timedOpsArb = fc.array(fc.tuple(opArb, fc.oneof(fc.constant(0), fc.nat({ max: 5_000 }))), {
  minLength: 1,
  maxLength: 25,
  size: 'medium',
});
/**
 * Which entity the delete property deletes: biased to one with leads (`withLeads`), else any entity
 * or, past the end, a missing id.
 */
const deleteTargetArb = fc.record({
  withLeads: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  pick: fc.nat({ max: 8 }),
});

function deleteTarget(world: World, target: { withLeads: boolean; pick: number }): number {
  const linked = world.entities.filter((e) =>
    world.connections.some((c) => c.a.entity === e.id || c.b.entity === e.id),
  );
  if (target.withLeads && linked.length > 0) return linked[target.pick % linked.length].id;
  const pool = world.entities;
  return target.pick < pool.length ? pool[target.pick].id : world.nextEntityId + target.pick;
}
const worldArb = rawWorldV2Arb.map((raw) => World.parse(raw));

function pickId(bus: CommandBus<World>, index: number): number {
  const entities = bus.state.entities;
  return index < entities.length ? entities[index].id : bus.state.nextEntityId + index; // past the end: missing
}

function run(bus: CommandBus<World>, op: Op): void {
  switch (op.kind) {
    case 'place':
      bus.exec('entity.place', { ref: op.ref, positionMm: op.positionMm, orientationMdeg: op.orientationMdeg });
      return;
    case 'move':
      bus.exec('entity.move', { id: pickId(bus, op.pick), positionMm: op.positionMm });
      return;
    case 'rotate':
      bus.exec('entity.rotate', { id: pickId(bus, op.pick), deltaMdeg: op.deltaMdeg });
      return;
    case 'delete':
      bus.exec('entity.delete', { id: pickId(bus, op.pick) });
      return;
    case 'undo':
      bus.exec('edit.undo');
      return;
    case 'redo':
      bus.exec('edit.redo');
      return;
    case 'view':
      bus.exec('view.resetLayout');
      return;
    case 'invalid':
      bus.exec('entity.move', { id: 1, positionMm: { x: 0.25, y: 0, z: 0 } });
      return;
    case 'connect':
      bus.exec('lead.connect', {
        ref: op.lead ? LEAD : { id: 'prop.crate', version: 1 },
        a: pickEnd(bus, op.from),
        b: pickEnd(bus, op.to),
      });
      return;
    case 'disconnect': {
      const connections = bus.state.connections;
      bus.exec('lead.disconnect', { id: op.pick < connections.length ? connections[op.pick].id : 99 + op.pick });
      return;
    }
    case 'operate':
      bus.exec('device.operate', { id: pickId(bus, op.pick), control: 'closed', value: op.value });
      return;
  }
}

describe('world command properties', () => {
  it('undoing everything returns the initial hash, for any command sequence', () => {
    fc.assert(
      fc.property(worldArb, opsArb, (initial, ops) => {
        const bus = createWorldBus(deepFreeze(initial));
        ops.forEach((op) => run(bus, op));
        while (bus.exec('edit.undo').ok);
        expect(worldHash(bus.state)).toBe(worldHash(initial));
        expect(bus.state).toEqual(initial);
      }),
    );
  });

  it('replaying the initial world (seed) + log through JSON gives the live hash', () => {
    fc.assert(
      fc.property(worldArb, opsArb, (initial, ops) => {
        const live = createWorldBus(initial);
        ops.forEach((op) => run(live, op));
        const loaded = migrateReplayLog(JSON.parse(JSON.stringify(toReplayLog(initial, live))));
        if (!loaded.ok) throw new Error(loaded.error.message);
        const replayed = replayLog(loaded.value);
        if (!replayed.ok) throw new Error(replayed.error.message);
        expect(replayed.hash).toBe(worldHash(live.state));
        expect(replayed.bus.entries).toEqual(live.entries);
      }),
    );
  });

  it('view commands are logged but never change the hash', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const withViews = createWorldBus(createWorld({ seed: 3 }));
        const without = createWorldBus(createWorld({ seed: 3 }));
        for (const op of ops) {
          run(withViews, op);
          const before = worldHash(withViews.state);
          const logged = withViews.entries.length;
          expect(withViews.exec('view.resetLayout').ok).toBe(true);
          expect(withViews.entries.length).toBe(logged + 1);
          expect(worldHash(withViews.state)).toBe(before);
          if (op.kind !== 'view') run(without, op);
        }
        expect(worldHash(withViews.state)).toBe(worldHash(without.state));
      }),
    );
  });

  it('every reachable world is a valid, sorted document and failures change nothing', () => {
    fc.assert(
      fc.property(worldArb, opsArb, (initial, ops) => {
        const bus = createWorldBus(initial);
        for (const op of ops) {
          const before = bus.state;
          const logged = bus.entries.length;
          run(bus, op);
          if (bus.entries.length === logged) expect(bus.state).toBe(before);
          const parsed = World.safeParse(bus.state);
          expect(parsed.success).toBe(true);
          expect(parsed.data).toEqual(bus.state); // already normalised: parsing changes nothing
        }
      }),
    );
  });

  it('invert ∘ apply is the identity (and redo re-applies) for every undoable command', () => {
    const undoable = createWorldRegistry()
      .list()
      .filter((def) => def.undoable);
    expect(undoable.map((d) => d.id).sort()).toEqual(
      [...entityCommands().map((d) => d.id), 'lead.connect', 'lead.disconnect', 'device.operate'].sort(),
    );
    fc.assert(
      fc.property(worldArb, opsArb, opArb, (initial, prefix, op) => {
        // A prefix first, so connect, disconnect and operate find devices and leads to act on.
        const setup = createWorldBus(initial);
        prefix.forEach((p) => run(setup, p));
        const world = deepFreeze(setup.state);
        const probe = createWorldBus(world);
        run(probe, op);
        const entry = probe.entries[0];
        const def = entry && undoable.find((d) => d.id === entry.id);
        if (!entry || !def) return; // not an undoable world command, or it failed
        const result = def.run({ state: world, seq: 0, tick: 0, canUndo: false, canRedo: false }, entry.args);
        if (!result.ok || !('change' in result) || !result.change) throw new Error('expected a change');
        const applied = result.change.apply(world);
        expect(result.change.invert(applied)).toEqual(world);
        expect(worldHash(result.change.invert(applied))).toBe(worldHash(world));
        expect(result.change.apply(result.change.invert(applied))).toEqual(applied);
      }),
    );
  });

  it('with time passing between commands, every apply and invert keeps the tick, and undoing everything restores the commanded world (F2.3a)', () => {
    const undoable = new Map(
      createWorldRegistry()
        .list()
        .filter((def) => def.undoable)
        .map((def) => [def.id, def]),
    );
    fc.assert(
      fc.property(worldArb, timedOpsArb, (initial, steps) => {
        const bus = createWorldBus(deepFreeze(initial));
        for (const [op, dt] of steps) {
          bus.advanceTo(bus.currentTick() + dt);
          const before = bus.state;
          const logged = bus.entries.length;
          run(bus, op);
          expect(bus.state.tick).toBe(before.tick);
          const entry = bus.entries[logged];
          const def = entry && undoable.get(entry.id);
          if (!def) continue;
          // The change itself, against the world it ran on, at the tick time had reached.
          const ctx = { state: before, seq: entry.seq, tick: entry.tick, canUndo: false, canRedo: false };
          const result = def.run(ctx, entry.args);
          if (!result.ok || !('change' in result) || !result.change) throw new Error('expected a change');
          const applied = result.change.apply(before);
          expect(applied.tick).toBe(before.tick);
          expect(result.change.invert(applied).tick).toBe(before.tick);
        }
        const end = bus.currentTick();
        while (bus.exec('edit.undo').ok);
        // Time never rewinds; what was commanded returns (ADR 0011 §3, "undo everything" restated).
        expect(bus.state.tick).toBe(end);
        expect({ ...bus.state, tick: initial.tick }).toEqual(initial);
      }),
    );
  });

  it('the timed sessions reach later ticks and run undoable changes there (generator health)', () => {
    const samples = fc.sample(fc.tuple(worldArb, timedOpsArb), { seed: 20261031, numRuns: 150 });
    let advancedChanges = 0;
    for (const [initial, steps] of samples) {
      const bus = createWorldBus(initial);
      let changed = false;
      for (const [op, dt] of steps) {
        bus.advanceTo(bus.currentTick() + dt);
        const logged = bus.entries.length;
        run(bus, op);
        const entry = bus.entries[logged];
        if (entry && entry.tick > initial.tick && op.kind !== 'undo' && op.kind !== 'redo' && op.kind !== 'view') {
          changed = true;
        }
      }
      if (changed) advancedChanges++;
    }
    expect(advancedChanges).toBeGreaterThan(75);
  });

  it('every change keeps the tick, the solution record and each surviving entity’s sim bag (ADR 0011 §1, §3)', () => {
    fc.assert(
      fc.property(worldArb, opsArb, (initial, ops) => {
        const bus = createWorldBus(deepFreeze(initial));
        for (const op of ops) {
          const before = bus.state;
          run(bus, op);
          const after = bus.state;
          expect(after.tick).toBe(before.tick);
          expect(after.sim).toBe(before.sim);
          for (const entity of after.entities) {
            const previous = before.entities.find((e) => e.id === entity.id);
            // Kept entities keep the very same sim bag; only an insert (place, undo of delete) brings one.
            if (previous) expect(entity.sim).toBe(previous.sim);
          }
        }
      }),
    );
  });

  it('deleting an entity removes exactly its connections; undo restores them with the same ids, redo removes the same ids (plan F2.1)', () => {
    fc.assert(
      fc.property(worldArb, opsArb, deleteTargetArb, (initial, ops, target) => {
        const bus = createWorldBus(initial);
        ops.forEach((op) => run(bus, op));
        const before = bus.state;
        const id = deleteTarget(before, target);
        if (!bus.exec('entity.delete', { id }).ok) return; // a missing id: refused, nothing to check
        const touches = (c: World['connections'][number]) => c.a.entity === id || c.b.entity === id;
        const kept = before.connections.filter((c) => !touches(c));
        // No connection is left with an end on the deleted entity, and every other one is kept as it was.
        expect(bus.state.connections).toStrictEqual(kept);
        expect(bus.state.nextConnectionId).toBe(before.nextConnectionId);
        expect(bus.exec('edit.undo').ok).toBe(true);
        expect(bus.state.connections).toStrictEqual(before.connections);
        expect(worldHash(bus.state)).toBe(worldHash(before));
        expect(bus.exec('edit.redo').ok).toBe(true);
        expect(bus.state.connections.map((c) => c.id)).toStrictEqual(kept.map((c) => c.id));
      }),
    );
  });

  it('the delete property usually deletes an entity that has leads (generator health)', () => {
    const samples = fc.sample(fc.tuple(worldArb, opsArb, deleteTargetArb), { seed: 20261030, numRuns: 200 });
    const withLeads = samples.filter(([initial, ops, target]) => {
      const bus = createWorldBus(initial);
      ops.forEach((op) => run(bus, op));
      const id = deleteTarget(bus.state, target);
      return bus.state.connections.some((c) => c.a.entity === id || c.b.entity === id);
    }).length;
    expect(withLeads / samples.length).toBeGreaterThanOrEqual(0.4);
  });

  it('deleting a battery with two leads removes both; undo restores ids 1 and 2; redo removes them again', () => {
    const bus = createWorldBus(createWorld({ seed: 1 }));
    const origin = { x: 0, y: 0, z: 0 };
    bus.exec('entity.place', { ref: { id: 'battery.ferrovane-12v-7ah', version: 1 }, positionMm: origin });
    bus.exec('entity.place', { ref: { id: 'lamp.lumivane-12v-5w', version: 1 }, positionMm: origin });
    bus.exec('lead.connect', { ref: LEAD, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
    bus.exec('lead.connect', { ref: LEAD, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
    const before = bus.state;
    expect(before.connections.map((c) => c.id)).toStrictEqual([1, 2]);
    expect(bus.exec('entity.delete', { id: 1 }).ok).toBe(true);
    expect(bus.state.connections).toStrictEqual([]);
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(bus.state).toStrictEqual(before);
    expect(bus.exec('edit.redo').ok).toBe(true);
    expect(bus.state.connections).toStrictEqual([]);
    expect(bus.state.nextConnectionId).toBe(3);
  });

  it('a log rebased onto a mid-session world (sim state included) replays to the same hash (ADR 0013)', () => {
    fc.assert(
      fc.property(worldArb, opsArb, opsArb, (initial, before, after) => {
        // A session that saved and loaded between `before` and `after`: the load clears the history.
        const live = createWorldBus(initial);
        before.forEach((op) => run(live, op));
        const cut = live.entries.length;
        live.clearHistory();
        after.forEach((op) => run(live, op));
        const log = toReplayLog(initial, live);

        const rebased = rebaseReplayLog(log, cut);
        if (!rebased.ok) throw new Error(rebased.error.message);
        expect(rebased.log.firstSeq).toBe(cut);
        expect(rebased.log.entries).toStrictEqual(log.entries.slice(cut));
        // The rebased log goes through JSON and the loader like a saved one.
        const loaded = migrateReplayLog(JSON.parse(JSON.stringify(rebased.log)));
        if (!loaded.ok) throw new Error(loaded.error.message);
        const replayed = replayLog(loaded.value);
        if (!replayed.ok) throw new Error(replayed.error.message);
        expect(replayed.hash).toBe(worldHash(live.state));
        expect(replayed.bus.entries).toStrictEqual(live.entries.slice(cut));
      }),
      { numRuns: 60 },
    );
  });
});
