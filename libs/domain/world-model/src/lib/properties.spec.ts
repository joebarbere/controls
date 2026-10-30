import type { CommandBus } from '@controls/commands';
import { createWorld, migrateReplayLog, World } from '@controls/save-format';
import { BUILTIN_CATALOG } from '@controls/catalog';
import { catalogRefArb, deepFreeze, rawWorldV2Arb } from '@controls/save-format/testing';
import fc from 'fast-check';
import { entityCommands } from './entity-commands';
import { worldHash } from './hash';
import { createWorldBus, rebaseReplayLog, replayLog, toReplayLog } from './session';

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
  | { kind: 'invalid' };

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
);

const opsArb = fc.array(opArb, { maxLength: 25 });
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
    const undoable = entityCommands().filter((def) => def.undoable);
    expect(undoable.map((d) => d.id)).toEqual(['entity.place', 'entity.move', 'entity.rotate', 'entity.delete']);
    fc.assert(
      fc.property(worldArb, opArb, (world, op) => {
        deepFreeze(world);
        const probe = createWorldBus(world);
        run(probe, op);
        const entry = probe.entries[0];
        if (!entry || !entry.id.startsWith('entity.')) return; // not a world command, or it failed
        const def = undoable.find((d) => d.id === entry.id);
        if (!def) throw new Error(`no def for ${entry.id}`);
        const result = def.run({ state: world, seq: 0, tick: 0, canUndo: false, canRedo: false }, entry.args);
        if (!result.ok || !('change' in result) || !result.change) throw new Error('expected a change');
        const applied = result.change.apply(world);
        expect(result.change.invert(applied)).toEqual(world);
        expect(worldHash(result.change.invert(applied))).toBe(worldHash(world));
        expect(result.change.apply(result.change.invert(applied))).toEqual(applied);
      }),
    );
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
