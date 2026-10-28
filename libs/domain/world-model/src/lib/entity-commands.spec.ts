import { defaultBindingDecls, defineCommand, Keymap, NoArgs, succeed } from '@controls/commands';
import { createWorld, migrateReplayLog, ReplayLog, World } from '@controls/save-format';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addAngleMdeg, findEntity, findEntityIndex } from './entity-commands';
import { worldHash } from './hash';
import { createWorldBus, createWorldRegistry, replayLog, toReplayLog } from './session';
import type { Entity } from './types';

const crate = { id: 'prop.crate', version: 1 };
const origin = { x: 0, y: 0, z: 0 };

function entity(id: number, x = 0): Entity {
  return {
    id,
    ref: crate,
    transform: { positionMm: { x, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
    extensions: {},
  };
}

function worldWith(ids: number[], nextEntityId = Math.max(0, ...ids) + 1): World {
  return World.parse({ ...createWorld({ seed: 7 }), nextEntityId, entities: ids.map((id) => entity(id, id * 10)) });
}

describe('entity.place', () => {
  it('takes the id from nextEntityId, increments it and defaults the orientation', () => {
    const bus = createWorldBus(worldWith([1, 4], 9));
    expect(bus.exec('entity.place', { ref: crate, positionMm: { x: 5, y: 6, z: -7 } })).toMatchObject({
      ok: true,
      entry: {
        args: { ref: crate, positionMm: { x: 5, y: 6, z: -7 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      },
    });
    expect(bus.state.nextEntityId).toBe(10);
    expect(bus.state.entities.map((e) => e.id)).toEqual([1, 4, 9]);
    expect(findEntity(bus.state, 9)).toEqual({
      id: 9,
      ref: crate,
      transform: { positionMm: { x: 5, y: 6, z: -7 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      extensions: {},
    });
    expect(World.safeParse(bus.state).success).toBe(true);
  });

  it('undo removes the entity and restores the counter', () => {
    const initial = worldWith([2]);
    const bus = createWorldBus(initial);
    bus.exec('entity.place', { ref: crate, positionMm: origin });
    bus.exec('edit.undo');
    expect(bus.state).toEqual(initial);
    expect(worldHash(bus.state)).toBe(worldHash(initial));
    bus.exec('edit.redo');
    expect(bus.state.entities.map((e) => e.id)).toEqual([2, 3]);
  });

  it('does not share objects with the logged (frozen) args', () => {
    const bus = createWorldBus(createWorld({ seed: 1 }));
    bus.exec('entity.place', { ref: crate, positionMm: origin });
    expect(Object.isFrozen(bus.entries[0].args)).toBe(true);
    expect(Object.isFrozen(bus.state.entities[0].transform.positionMm)).toBe(false);
  });

  it('refuses to place once ids run out', () => {
    const bus = createWorldBus(worldWith([], Number.MAX_SAFE_INTEGER));
    expect(bus.exec('entity.place', { ref: crate, positionMm: origin })).toMatchObject({
      ok: false,
      error: { kind: 'rejected', code: 'ids-exhausted' },
    });
  });

  it.each([
    ['fractional millimetres', { ref: crate, positionMm: { x: 0.5, y: 0, z: 0 } }],
    ['beyond ±10 km', { ref: crate, positionMm: { x: 10_000_001, y: 0, z: 0 } }],
    [
      'an angle of a full turn',
      { ref: crate, positionMm: origin, orientationMdeg: { yaw: 360000, pitch: 0, roll: 0 } },
    ],
    ['a malformed catalogue id', { ref: { id: 'Crate', version: 1 }, positionMm: origin }],
    ['an unknown key', { ref: crate, positionMm: origin, colour: 'red' }],
    ['no position', { ref: crate }],
  ])('rejects %s and leaves the world and log unchanged', (_name, args) => {
    const initial = worldWith([1]);
    const bus = createWorldBus(initial);
    expect(bus.exec('entity.place', args)).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(bus.state).toBe(initial);
    expect(bus.entries).toEqual([]);
  });
});

describe('entity.move', () => {
  it('sets the position and undo restores it', () => {
    const initial = worldWith([1, 2]);
    const bus = createWorldBus(initial);
    expect(bus.exec('entity.move', { id: 2, positionMm: { x: -1, y: 2, z: 3 } }).ok).toBe(true);
    expect(findEntity(bus.state, 2)?.transform.positionMm).toEqual({ x: -1, y: 2, z: 3 });
    expect(findEntity(bus.state, 1)).toBe(initial.entities[0]); // untouched entities are shared
    bus.exec('edit.undo');
    expect(bus.state).toEqual(initial);
  });

  it('fails for an unknown id', () => {
    const bus = createWorldBus(worldWith([1]));
    expect(bus.exec('entity.move', { id: 5, positionMm: origin })).toEqual({
      ok: false,
      error: { kind: 'rejected', id: 'entity.move', code: 'not-found', message: 'No entity with id 5' },
    });
  });
});

describe('entity.rotate', () => {
  it('composes by modular addition per axis and undo restores the triple exactly', () => {
    const initial = World.parse({
      ...worldWith([1]),
      entities: [
        { ...entity(1), transform: { positionMm: origin, orientationMdeg: { yaw: 359999, pitch: 0, roll: 180000 } } },
      ],
    });
    const bus = createWorldBus(initial);
    bus.exec('entity.rotate', { id: 1, deltaMdeg: { yaw: 2, pitch: -1, roll: 180000 } });
    expect(findEntity(bus.state, 1)?.transform.orientationMdeg).toEqual({ yaw: 1, pitch: 359999, roll: 0 });
    bus.exec('edit.undo');
    expect(bus.state).toEqual(initial);
  });

  it('rejects a delta of a full turn or more, and unknown ids', () => {
    const bus = createWorldBus(worldWith([1]));
    expect(bus.exec('entity.rotate', { id: 1, deltaMdeg: { yaw: 360000, pitch: 0, roll: 0 } }).ok).toBe(false);
    expect(bus.exec('entity.rotate', { id: 2, deltaMdeg: { yaw: 1, pitch: 0, roll: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });

  it('addAngleMdeg wraps both ways into [0, 360000)', () => {
    expect(addAngleMdeg(0, -1)).toBe(359999);
    expect(addAngleMdeg(359999, 1)).toBe(0);
    expect(addAngleMdeg(100, -359999)).toBe(101);
    expect(Object.is(addAngleMdeg(0, 0), 0)).toBe(true);
    expect(Object.is(addAngleMdeg(360000 - 5, 5), 0)).toBe(true);
  });
});

describe('entity.delete', () => {
  it('removes the entity without touching the counter; undo reinserts the same id in order', () => {
    const initial = worldWith([1, 3, 5], 8);
    const bus = createWorldBus(initial);
    bus.exec('entity.delete', { id: 3 });
    expect(bus.state.entities.map((e) => e.id)).toEqual([1, 5]);
    expect(bus.state.nextEntityId).toBe(8);
    bus.exec('edit.undo');
    expect(bus.state).toEqual(initial);
    expect(findEntity(bus.state, 3)).toBe(initial.entities[1]);
  });

  it('never reuses the id of a deleted entity for a new one', () => {
    const bus = createWorldBus(createWorld({ seed: 1 }));
    bus.exec('entity.place', { ref: crate, positionMm: origin });
    bus.exec('entity.delete', { id: 1 });
    bus.exec('entity.place', { ref: crate, positionMm: origin });
    expect(bus.state.entities.map((e) => e.id)).toEqual([2]);
  });

  it('reinserts at the start and the end too', () => {
    for (const id of [1, 9]) {
      const initial = worldWith([1, 5, 9]);
      const bus = createWorldBus(initial);
      bus.exec('entity.delete', { id });
      bus.exec('edit.undo');
      expect(bus.state).toEqual(initial);
    }
  });

  it('fails for an unknown id', () => {
    expect(createWorldBus(worldWith([])).exec('entity.delete', { id: 1 })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
  });
});

describe('findEntityIndex', () => {
  it('binary-searches the sorted entities', () => {
    const entities = [1, 3, 4, 8, 20].map((id) => entity(id));
    for (const [index, e] of entities.entries()) expect(findEntityIndex(entities, e.id)).toBe(index);
    for (const missing of [0, 2, 5, 21]) expect(findEntityIndex(entities, missing)).toBe(-1);
    expect(findEntityIndex([], 1)).toBe(-1);
  });
});

describe('world registry, replay log and cheats', () => {
  it('holds the world, edit and view commands', () => {
    expect(
      createWorldRegistry()
        .list()
        .map((c) => `${c.id}:${c.undoable}`),
    ).toEqual([
      'edit.redo:false',
      'edit.undo:false',
      'entity.delete:true',
      'entity.move:true',
      'entity.place:true',
      'entity.rotate:true',
      'toolbelt.select:false',
      'view.resetLayout:false',
    ]);
  });

  it('has conflict-free default keybindings on every platform (F1.4)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const keymap = Keymap.create(defaultBindingDecls(createWorldRegistry()), {}, platform);
      expect(keymap.conflicts).toEqual([]);
    }
  });

  it('logs toolbelt.select without changing the world or its hash', () => {
    const bus = createWorldBus(createWorld({ seed: 1 }));
    const before = worldHash(bus.state);
    expect(bus.exec('toolbelt.select', { slot: 3 })).toMatchObject({ ok: true, entry: { args: { slot: 3 } } });
    expect(bus.exec('toolbelt.select', { slot: 10 })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(worldHash(bus.state)).toBe(before);
    expect(bus.entries.map((e) => e.id)).toEqual(['toolbelt.select']);
  });

  it('replays the F1.8a replay-log fixture', () => {
    const raw = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../save-format/fixtures/v1/replay-log/place-move-delete-undo.json'),
        'utf8',
      ),
    );
    const loaded = migrateReplayLog(raw);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const result = replayLog(loaded.value);
    if (!result.ok) throw new Error(result.error.message);
    // place → move → (view) → delete → undo: the moved crate is back.
    expect(result.world.entities).toEqual([
      {
        id: 1,
        ref: crate,
        transform: { positionMm: { x: 150, y: 0, z: -200 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
        extensions: {},
      },
    ]);
    expect(result.world.nextEntityId).toBe(2);
    expect(result.hash).toBe(worldHash(result.world));
    expect(result.bus.canRedo).toBe(true);
  });

  it('reports a log that no longer replays', () => {
    const log = ReplayLog.parse({
      schemaVersion: 1,
      initialWorld: createWorld({ seed: 0 }),
      entries: [{ seq: 0, tick: 0, id: 'entity.delete', args: { id: 1 } }],
    });
    expect(replayLog(log)).toMatchObject({ ok: false, error: { kind: 'failed', seq: 0 } });
  });

  it('writes a replay log that survives JSON and replays to the live hash', () => {
    const initial = createWorld({ seed: 99 });
    const bus = createWorldBus(initial);
    bus.exec('entity.place', { ref: crate, positionMm: { x: 1, y: 2, z: 3 } });
    bus.exec('view.resetLayout');
    const loaded = migrateReplayLog(JSON.parse(JSON.stringify(toReplayLog(initial, bus))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.value.entries.map((e) => e.id)).toEqual(['entity.place', 'view.resetLayout']);
    const replayed = replayLog(loaded.value);
    expect(replayed.ok && replayed.hash).toBe(worldHash(bus.state));
  });

  it('marks the world assisted after a cheat, once, and undo keeps the mark', () => {
    const registry = createWorldRegistry().register(
      defineCommand<NoArgs, World>({
        id: 'cheat.test',
        title: 'Test cheat',
        category: 'Cheat',
        args: NoArgs,
        undoable: false,
        cheat: true,
        run: () => succeed(),
      }),
    );
    const bus = createWorldBus(createWorld({ seed: 1 }), registry);
    bus.exec('entity.place', { ref: crate, positionMm: origin });
    bus.exec('cheat.test');
    expect(bus.state.assisted).toBe(true);
    const assisted = bus.state;
    bus.exec('cheat.test');
    expect(bus.state).toBe(assisted); // already assisted: same object
    bus.exec('edit.undo');
    expect(bus.state.assisted).toBe(true);
  });
});
