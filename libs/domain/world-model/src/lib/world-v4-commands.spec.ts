import { BUILTIN_CATALOG, catalogOrThrow, mountType } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { World } from '@controls/save-format';
import {
  at,
  benchStabMm,
  BUS_ORIENTATION,
  CUTTER,
  RESIDENTIAL,
  RESIDENTIAL_TEST_CATALOG,
  RESIDENTIAL_TEST_KINDS,
  residentialBench,
  WIRE,
  WIRE_10,
} from '../testing';
import { argOptionChoices } from './arg-options';
import { selectionToggle } from './device-commands';
import { checkWorldReferences } from './devices';
import { checkPlugInsert } from './wiring/plug';
import { entityHold, moveBlocker } from './entity-commands';
import { placeInWorld } from './snap/world-placement';
import { beltChoices } from './tools/tool-belt';
import { busStabIndex, busStabLeg, checkMount } from './wiring/mounting';

/*
 * The world v4 commands (P4 PR 8, ADR 0019 "Commands"): `plug.insert`, `plug.remove`, `wire.mark`,
 * `panel.directory` and `device.press`; `entity.delete` unplugging; `entityHold`/`moveBlocker`'s
 * `plugged`; `device.operate`'s `momentary` refusal and the two-option selector rule; `lead.connect`'s
 * `inaccessible`; `wire.land`'s `multiConductor` cap; `busStabIndex` and the bus mount rules; the
 * single-mount anchor; `beltChoices` hiding superseded entries; the palette's suggestion lists. All on
 * the TEST-ONLY residential bench (`residentialBench`).
 */

type Bus = CommandBus<World>;

const code = (bus: Bus, id: string, args: unknown) => {
  const result = bus.exec(id, args);
  return result.ok ? null : 'code' in result.error ? result.error.code : result.error.kind;
};

/** Runs `id` and checks undo restores the world exactly and redo re-applies it. */
function undoRestores(bus: Bus, id: string, args: unknown): World {
  const before = bus.state;
  expect(bus.exec(id, args)).toMatchObject({ ok: true });
  const after = bus.state;
  expect(checkWorldReferences(after, RESIDENTIAL_TEST_CATALOG)).toStrictEqual([]);
  expect(World.safeParse(after).success).toBe(true);
  expect(bus.exec('edit.undo', {})).toMatchObject({ ok: true });
  expect(bus.state).toStrictEqual(before);
  expect(bus.exec('edit.redo', {})).toMatchObject({ ok: true });
  expect(bus.state).toStrictEqual(after);
  return after;
}

const entityOf = (bus: Bus, id: number) => bus.state.entities.find((e) => e.id === id);

describe('plug.insert and plug.remove', () => {
  it('plugs a kettle into the top outlet; undo and redo restore the relation exactly', () => {
    const bus = residentialBench();
    const after = undoRestores(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'top' });
    expect(after.entities.find((e) => e.id === 2)?.pluggedInto).toStrictEqual({ entity: 1, outlet: 'top' });
    // Nothing else changed: the kettle stays where it was (a relation, not a transform).
    expect(entityOf(bus, 2)?.transform.positionMm).toStrictEqual(at(600, 0, 0));
  });

  it('refuses with the checkPlugInsert codes, and never logs a refusal', () => {
    const bus = residentialBench();
    const logged = bus.entries.length;
    expect(code(bus, 'plug.insert', { appliance: 99, receptacle: 1, outlet: 'top' })).toBe('not-found');
    expect(code(bus, 'plug.insert', { appliance: 1, receptacle: 1, outlet: 'top' })).toBe('not-an-appliance');
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 99, outlet: 'top' })).toBe('not-found');
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 7, outlet: 'top' })).toBe('not-a-receptacle');
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'side' })).toBe('unknown-outlet');
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 6, outlet: 'top' })).toBe('out-of-reach');
    expect(bus.entries.length).toBe(logged);
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'top' })).toBeNull();
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'bottom' })).toBe('already-plugged');
    expect(code(bus, 'plug.insert', { appliance: 3, receptacle: 1, outlet: 'top' })).toBe('outlet-occupied');
    expect(code(bus, 'plug.insert', { appliance: 3, receptacle: 1, outlet: 'bottom' })).toBeNull();
  });

  it('refuses a plug that doesn’t mate and one that would close a cycle', () => {
    const bus = residentialBench();
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.heater, positionMm: at(0, 500, 0) })).toBeNull();
    expect(code(bus, 'plug.insert', { appliance: 9, receptacle: 1, outlet: 'top' })).toBe('wrong-configuration');
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.strip, positionMm: at(0, -500, 0) })).toBeNull();
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.strip, positionMm: at(300, -500, 0) })).toBeNull();
    expect(code(bus, 'plug.insert', { appliance: 10, receptacle: 11, outlet: 'socket-1' })).toBeNull();
    expect(code(bus, 'plug.insert', { appliance: 11, receptacle: 10, outlet: 'socket-1' })).toBe('plug-cycle');
    expect(code(bus, 'plug.insert', { appliance: 10, receptacle: 10, outlet: 'socket-1' })).toBe('already-plugged');
  });

  it('refuses (defensively) an appliance that is mounted or in an entry', () => {
    const world = residentialBench().state;
    const with_ = (extra: object) => ({
      entities: world.entities.map((e) => (e.id === 2 ? { ...e, ...extra } : e)),
    });
    const args = { appliance: 2, receptacle: 1, outlet: 'top' };
    const mounted = with_({ mountedOn: { entity: 4, mount: 'left' } });
    const inEntry = with_({ inEntry: { entity: 4, entry: 'ko1' } });
    expect(checkPlugInsert(mounted, RESIDENTIAL_TEST_CATALOG, args)?.code).toBe('mounted');
    expect(checkPlugInsert(inEntry, RESIDENTIAL_TEST_CATALOG, args)?.code).toBe('in-entry');
  });

  it('plug.remove unplugs; refuses not-found, not-an-appliance and not-plugged', () => {
    const bus = residentialBench();
    expect(code(bus, 'plug.remove', { appliance: 2 })).toBe('not-plugged');
    expect(code(bus, 'plug.remove', { appliance: 99 })).toBe('not-found');
    expect(code(bus, 'plug.remove', { appliance: 1 })).toBe('not-an-appliance');
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'top' })).toBeNull();
    const after = undoRestores(bus, 'plug.remove', { appliance: 2 });
    expect(after.entities.find((e) => e.id === 2)?.pluggedInto).toBeNull();
  });
});

describe('occupancy and delete with plugs (ADR 0019 "Occupancy")', () => {
  function plugged(): Bus {
    const bus = residentialBench();
    expect(code(bus, 'plug.insert', { appliance: 2, receptacle: 1, outlet: 'top' })).toBeNull();
    expect(code(bus, 'plug.insert', { appliance: 3, receptacle: 1, outlet: 'bottom' })).toBeNull();
    bus.clearHistory();
    return bus;
  }

  it('deleting a receptacle unplugs everything in it; undo restores every relation exactly', () => {
    const bus = plugged();
    const after = undoRestores(bus, 'entity.delete', { id: 1 });
    expect(after.entities.find((e) => e.id === 1)).toBeUndefined();
    expect(after.entities.filter((e) => e.pluggedInto !== null)).toStrictEqual([]);
  });

  it('deleting an appliance takes its plug with it', () => {
    const bus = plugged();
    const after = undoRestores(bus, 'entity.delete', { id: 2 });
    expect(after.entities.map((e) => [e.id, e.pluggedInto])).toContainEqual([3, { entity: 1, outlet: 'bottom' }]);
  });

  it('a receptacle holding a plug can’t move or turn; a plugged appliance is `plugged`', () => {
    const bus = plugged();
    expect(entityHold(bus.state, 2)).toBe('plugged');
    expect(moveBlocker(bus.state, 2)).toBe('plugged');
    expect(entityHold(bus.state, 1)).toBe('occupied');
    expect(moveBlocker(bus.state, 1)).toBe('occupied');
    expect(moveBlocker(bus.state, 6)).toBeNull();
    expect(code(bus, 'entity.move', { id: 1, positionMm: at(10, 0, 0) })).toBe('occupied');
    expect(code(bus, 'entity.move', { id: 2, positionMm: at(610, 0, 0) })).toBe('plugged');
  });

  it('the placement ghost refuses picking up a plugged appliance (`WorldPlacementFailure` `plugged`)', () => {
    const bus = plugged();
    const result = placeInWorld(bus.state, RESIDENTIAL.kettle, at(700, 0, 0), [], {
      catalog: RESIDENTIAL_TEST_CATALOG,
      moving: 2,
    });
    expect(result).toStrictEqual({ ok: false, reason: 'plugged', targetId: null });
  });
});

describe('wire.mark', () => {
  it('tapes either end, survives land and unland, and clears with null; undo restores', () => {
    const bus = residentialBench();
    let after = undoRestores(bus, 'wire.mark', { id: 1, end: 'b', colour: 'black' });
    expect(after.connections.find((c) => c.id === 1)?.marking).toStrictEqual({ a: null, b: 'black' });
    // Setting the tape it already has succeeds and is logged (intent).
    const logged = bus.entries.length;
    expect(code(bus, 'wire.mark', { id: 1, end: 'b', colour: 'black' })).toBeNull();
    expect(bus.entries.length).toBe(logged + 1);
    after = undoRestores(bus, 'wire.mark', { id: 1, end: 'b', colour: null });
    expect(after.connections.find((c) => c.id === 1)?.marking).toStrictEqual({ a: null, b: null });
  });

  it('refuses a lead, an unknown id, bare and a colour not in the table', () => {
    const bus = residentialBench();
    expect(code(bus, 'wire.mark', { id: 2, end: 'a', colour: 'red' })).toBe('not-a-wire');
    expect(code(bus, 'wire.mark', { id: 9, end: 'a', colour: 'red' })).toBe('not-found');
    expect(code(bus, 'wire.mark', { id: 1, end: 'a', colour: 'bare' })).toBe('unavailable-colour');
    expect(code(bus, 'wire.mark', { id: 1, end: 'a', colour: 'mauve' })).toBe('unavailable-colour');
  });

  it('the tape goes with the conductor on delete and comes back on undo', () => {
    const bus = residentialBench();
    expect(code(bus, 'wire.mark', { id: 1, end: 'a', colour: 'red' })).toBeNull();
    const marked = bus.state;
    expect(code(bus, 'wire.delete', { id: 1 })).toBeNull();
    expect(code(bus, 'edit.undo', {})).toBeNull();
    expect(bus.state).toStrictEqual(marked);
  });
});

describe('panel.directory', () => {
  it('writes and clears one space; undo restores', () => {
    const bus = residentialBench();
    let after = undoRestores(bus, 'panel.directory', { id: 4, space: 3, text: 'KITCHEN COUNTER' });
    expect(after.entities.find((e) => e.id === 4)?.state['directory3']).toBe('KITCHEN COUNTER');
    // The text "null" is text, not a clear.
    after = undoRestores(bus, 'panel.directory', { id: 4, space: 4, text: 'null' });
    expect(after.entities.find((e) => e.id === 4)?.state['directory4']).toBe('null');
    after = undoRestores(bus, 'panel.directory', { id: 4, space: 3, text: null });
    expect(after.entities.find((e) => e.id === 4)?.state['directory3']).toBeNull();
  });

  it('refuses not-found, not-a-panel and unknown-space (above the entry’s spaces, with no schema maximum)', () => {
    const bus = residentialBench();
    expect(code(bus, 'panel.directory', { id: 99, space: 1, text: 'A' })).toBe('not-found');
    expect(code(bus, 'panel.directory', { id: 1, space: 1, text: 'A' })).toBe('not-a-panel');
    expect(code(bus, 'panel.directory', { id: 4, space: 5, text: 'A' })).toBe('unknown-space');
    expect(code(bus, 'panel.directory', { id: 4, space: 43, text: 'A' })).toBe('unknown-space');
    expect(bus.exec('panel.directory', { id: 4, space: 0, text: 'A' })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-args' },
    });
  });

  it('device.operate can’t set a directory key (it is never a control)', () => {
    const bus = residentialBench();
    expect(code(bus, 'device.operate', { id: 4, control: 'directory1', value: 'X' })).toBe('unknown-control');
  });
});

describe('device.press and device.operate’s momentary refusal', () => {
  it('adds one to the counter per press; undo restores it', () => {
    const bus = residentialBench();
    undoRestores(bus, 'device.press', { id: 6, control: 'test' });
    expect(code(bus, 'device.press', { id: 6, control: 'test' })).toBeNull();
    expect(entityOf(bus, 6)?.state).toMatchObject({ test: 2, reset: 0 });
    expect(code(bus, 'device.press', { id: 6, control: 'reset' })).toBeNull();
    expect(entityOf(bus, 6)?.state).toMatchObject({ test: 2, reset: 1 });
  });

  it('refuses not-found, not-a-device, unknown-control and not-momentary', () => {
    const bus = residentialBench();
    expect(code(bus, 'device.press', { id: 99, control: 'test' })).toBe('not-found');
    expect(code(bus, 'entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: at(0, 3000, 0) })).toBeNull();
    expect(code(bus, 'device.press', { id: 9, control: 'test' })).toBe('not-a-device');
    expect(code(bus, 'device.press', { id: 6, control: 'hush' })).toBe('unknown-control');
    expect(code(bus, 'device.press', { id: 7, control: 'position' })).toBe('not-momentary');
  });

  it('refuses a counter at Number.MAX_SAFE_INTEGER (ids-exhausted)', () => {
    const bus = residentialBench();
    const world = {
      ...bus.state,
      entities: bus.state.entities.map((e) =>
        e.id === 6 ? { ...e, state: { ...e.state, test: Number.MAX_SAFE_INTEGER } } : e,
      ),
    };
    const full = residentialBench();
    const exhausted = full.registry.get('device.press');
    const result = exhausted?.run(
      { state: world, seq: 0, tick: 0, canUndo: false, canRedo: false },
      { id: 6, control: 'test' },
    );
    expect(result).toMatchObject({ ok: false, code: 'ids-exhausted' });
  });

  it('device.operate refuses a momentary control with `momentary`, naming device.press', () => {
    const bus = residentialBench();
    const result = bus.exec('device.operate', { id: 6, control: 'test', value: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'momentary' } });
    expect(result.ok ? '' : result.error.message).toContain('device.press');
  });

  it('the operate key flips a two-option selector (a three-way’s position)', () => {
    const bus = residentialBench();
    expect(selectionToggle(bus.state, 7, RESIDENTIAL_TEST_CATALOG)).toStrictEqual({ control: 'position', value: 't2' });
    expect(code(bus, 'device.operate', { id: 7, control: 'position', value: 't2' })).toBeNull();
    expect(selectionToggle(bus.state, 7, RESIDENTIAL_TEST_CATALOG)).toStrictEqual({ control: 'position', value: 't1' });
    // A GFCI has only buttons: nothing for the operate key.
    expect(selectionToggle(bus.state, 6, RESIDENTIAL_TEST_CATALOG)).toBeNull();
  });
});

describe('lead.connect refuses an inaccessible terminal', () => {
  it('`access: none` takes no clip (`inaccessible`); the device’s other terminals still do', () => {
    const bus = residentialBench();
    const lead = (terminal: string) => ({
      ref: { id: 'lead.quillfern-test-1m', version: 1 },
      a: { entity: 8, terminal },
      b: { entity: 6, terminal: 'a' },
    });
    expect(code(bus, 'lead.connect', lead('a'))).toBe('inaccessible');
    expect(code(bus, 'lead.connect', lead('ground'))).toBeNull();
  });
});

describe('the load check refuses a stored lead on an inaccessible terminal', () => {
  it('a lead clip on `access: none` is refused; on the device’s other terminals it loads', () => {
    const bus = residentialBench();
    const lead = bus.state.connections.find((c) => c.id === 2);
    const end = lead?.b;
    if (!end) throw new Error('missing lead');
    const at = (terminal: string) => ({
      ...bus.state,
      connections: bus.state.connections.map((c) => (c.id === 2 ? { ...c, b: { ...end, terminal } } : c)),
    });
    expect(checkWorldReferences(at('ground'), RESIDENTIAL_TEST_CATALOG)).toStrictEqual([]);
    expect(checkWorldReferences(at('a'), RESIDENTIAL_TEST_CATALOG)).toStrictEqual([
      { path: 'connections[1].b.terminal', message: "A clip can't reach that terminal" },
    ]);
  });
});

describe('wire.land enforces multiConductor (catalogue v3)', () => {
  const route = (x: number) => [
    { kind: 'free', positionMm: at(x, 2000, 0), entity: null, fixture: null, tool: null },
    { kind: 'free', positionMm: at(x, 2500, 0), entity: null, fixture: null, tool: null },
  ];
  const add = (bus: Bus, ref: typeof WIRE, terminal: string, x: number) =>
    code(bus, 'wire.add', {
      ref,
      a: { entity: 9, terminal, termination: 'auto' },
      b: null,
      route: route(x),
      lengthMm: 3000,
      colour: { base: 'black', stripe: null },
      tool: CUTTER,
    });

  it('two of one size within the cap land; a second of another size is refused', () => {
    const bus = residentialBench();
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.cap, positionMm: at(2000, 2000, 0) })).toBeNull();
    expect(add(bus, WIRE, '1', 1000)).toBeNull();
    // Terminal 1: 14–10 AWG, equal sizes. A 10 alone would land; beside a 14 it doesn't.
    expect(add(bus, WIRE_10, '1', 1100)).toBe('multi-conductor-out-of-range');
    expect(add(bus, WIRE, '1', 1200)).toBeNull();
    // Terminal 2: only 14 AWG when doubled, any mix of 14s. A lone 10 lands (the method's own range).
    expect(add(bus, WIRE_10, '2', 1300)).toBeNull();
    expect(add(bus, WIRE, '2', 1400)).toBe('multi-conductor-out-of-range');
  });

  it('wire.land checks the same cap', () => {
    const bus = residentialBench();
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.cap, positionMm: at(2000, 2000, 0) })).toBeNull();
    expect(add(bus, WIRE, '1', 1000)).toBeNull(); // connection 3
    const free = (ref: typeof WIRE, x: number) =>
      code(bus, 'wire.add', {
        ref,
        a: null,
        b: null,
        route: route(x),
        lengthMm: 3000,
        colour: { base: 'black', stripe: null },
        tool: CUTTER,
      });
    expect(free(WIRE_10, 1100)).toBeNull(); // connection 4
    expect(free(WIRE, 1200)).toBeNull(); // connection 5
    const land = (id: number) =>
      code(bus, 'wire.land', { id, end: 'a', at: { entity: 9, terminal: '1', termination: 'auto' } });
    expect(land(4)).toBe('multi-conductor-out-of-range');
    expect(land(5)).toBeNull();
  });
});

describe('busStabIndex and the bus mount', () => {
  const panel = (bus: Bus) => entityOf(bus, 4) as World['entities'][number];
  const left = RESIDENTIAL_TEST_CATALOG.device(RESIDENTIAL.panel)?.enclosure?.mounts[0];
  if (!left) throw new Error('missing');
  const FIT = { crossMm: 0 };

  it('finds a stab by exact lookup, and maps it to its leg by row', () => {
    const bus = residentialBench();
    expect(busStabIndex(panel(bus), left, benchStabMm('left', 0), FIT)).toBe(0);
    expect(busStabIndex(panel(bus), left, benchStabMm('left', 1), FIT)).toBe(1);
    expect(busStabIndex(panel(bus), left, at(5000, 99, 0), FIT)).toBeNull();
    expect(busStabIndex(panel(bus), left, at(5000, 100, 1), FIT)).toBeNull();
    expect(busStabIndex(panel(bus), left, at(5000, 50, 0), FIT)).toBeNull(); // k = 2 is past the last stab
    // Off the device's cross line (its fit's crossMm): no stab, however exact the along offset.
    expect(busStabIndex(panel(bus), left, benchStabMm('left', 0), { crossMm: 3 })).toBeNull();
    expect(busStabIndex(panel(bus), left, at(5003, 100, 0), FIT)).toBeNull();
    expect([busStabLeg(left, 0), busStabLeg(left, 1), busStabLeg(left, 2)]).toStrictEqual(['busL1', 'busL2', null]);
  });

  it('a breaker goes only on a stab; a two-pole one only where both its stabs are on the bus', () => {
    const bus = residentialBench();
    const mount = (column: 'left' | 'right', positionMm: ReturnType<typeof at>, ref = RESIDENTIAL.breaker1p) =>
      checkMount(
        bus.state,
        RESIDENTIAL_TEST_CATALOG,
        ref,
        positionMm,
        BUS_ORIENTATION,
        { entity: 4, mount: column },
        null,
      )?.code ?? null;
    expect(mount('right', benchStabMm('right', 0))).toBeNull();
    expect(mount('right', at(5040, 90, 0))).toBe('off-mount');
    expect(mount('left', benchStabMm('left', 0))).toBe('mount-full');
    expect(mount('right', benchStabMm('right', 0), RESIDENTIAL.breaker2p)).toBeNull();
    expect(mount('right', benchStabMm('right', 1), RESIDENTIAL.breaker2p)).toBe('off-mount');
  });

  it('the load check refuses a stored breaker off its stabs', () => {
    const bus = residentialBench();
    const moved = {
      ...bus.state,
      entities: bus.state.entities.map((e) =>
        e.id === 5 ? { ...e, transform: { ...e.transform, positionMm: at(5000, 90, 0) } } : e,
      ),
    };
    expect(checkWorldReferences(moved, RESIDENTIAL_TEST_CATALOG).map((i) => i.path)).toContain('entities[4].mountedOn');
  });

  it('the ghost snaps a breaker onto the nearest stab its contacts fit', () => {
    const bus = residentialBench();
    const place = (cursor: ReturnType<typeof at>, ref = RESIDENTIAL.breaker1p) =>
      placeInWorld(bus.state, ref, cursor, [], { catalog: RESIDENTIAL_TEST_CATALOG });
    expect(place(at(5050, 70, 0))).toMatchObject({
      ok: true,
      kind: 'mount',
      positionMm: benchStabMm('right', 1),
      mountedOn: { entity: 4, mount: 'right' },
    });
    // A two-pole breaker near the last stab goes to the one before it (both poles on the bus).
    expect(place(at(5050, 70, 0), RESIDENTIAL.breaker2p)).toMatchObject({
      ok: true,
      positionMm: benchStabMm('right', 0),
    });
  });
});

describe('the single-mount anchor (catalogue v3 `alongMm`, `crossMm`)', () => {
  const bulb = RESIDENTIAL_TEST_CATALOG.device(RESIDENTIAL.bulb);
  const anchored = catalogOrThrow(
    RESIDENTIAL_TEST_CATALOG.version,
    {
      devices: [
        ...RESIDENTIAL_TEST_CATALOG.devices,
        {
          ...bulb,
          id: 'bulb.test-anchored',
          mounts: [{ type: 'e26', widthMm: 20, crossMm: 3, alongMm: 5, contacts: [] }],
        },
      ],
      cables: RESIDENTIAL_TEST_CATALOG.cables,
      tools: RESIDENTIAL_TEST_CATALOG.tools,
      accessories: RESIDENTIAL_TEST_CATALOG.accessories,
      tables: RESIDENTIAL_TEST_CATALOG.tables,
    },
    RESIDENTIAL_TEST_KINDS,
  );
  const ANCHORED = { id: 'bulb.test-anchored', version: 1 };

  it('checkMount and the ghost put the device at its anchor on the mount', () => {
    const bus = residentialBench();
    expect(code(bus, 'entity.place', { ref: RESIDENTIAL.holder, positionMm: at(0, 4000, 0) })).toBeNull();
    const Z = { yaw: 0, pitch: 0, roll: 0 };
    const on = { entity: 9, mount: 'socket' };
    expect(checkMount(bus.state, anchored, ANCHORED, at(5, 4003, 0), Z, on, null)).toBeNull();
    expect(checkMount(bus.state, anchored, ANCHORED, at(0, 4000, 0), Z, on, null)?.code).toBe('off-mount');
    expect(placeInWorld(bus.state, ANCHORED, at(10, 4010, 0), [], { catalog: anchored })).toMatchObject({
      ok: true,
      kind: 'mount',
      positionMm: at(5, 4003, 0),
      mountedOn: on,
    });
    // A catalogue-2 style fit (0, 0) is unchanged: the bulb snaps to the socket's origin.
    expect(placeInWorld(bus.state, RESIDENTIAL.bulb, at(10, 4010, 0), [], { catalog: anchored })).toMatchObject({
      ok: true,
      positionMm: at(0, 4000, 0),
    });
  });

  it('the built-in single-mount anchors are exactly the F4.1 part 1 entries’ (bulbs centred on a socket, devices in a gang)', () => {
    const anchored = BUILTIN_CATALOG.devices.flatMap((device) =>
      device.mounts
        .filter((fit) => mountType(fit.type)?.occupancy === 'single' && (fit.alongMm !== 0 || fit.crossMm !== 0))
        .map((fit) => [device.id, fit.type, fit.alongMm, fit.crossMm]),
    );
    expect(anchored).toStrictEqual([
      ['dimmer.castellby-600w', 'deviceYoke', 1, 1],
      ['lamp.lumivane-a19-100w', 'e26', -30, -30],
      ['lamp.lumivane-a19-60w', 'e26', -30, -30],
      ['light.fennisby-led-wall-15w', 'deviceYoke', -37, -24],
      ['light.lumivane-led-a19-9w', 'e26', -30, -30],
      ['switch.castellby-1p-15a', 'deviceYoke', 6, 4],
      ['switch.castellby-3way-15a', 'deviceYoke', 6, 4],
      ['switch.castellby-4way-15a', 'deviceYoke', 6, 4],
    ]);
  });

  it('a shipped bulb screws into a shipped holder at its anchor, and a switch into a steel box’s yoke', () => {
    const bus = residentialBench();
    const holder = { id: 'lampholder.castellby-keyless', version: 1 };
    const bulb = { id: 'lamp.lumivane-a19-60w', version: 1 };
    const Z = { yaw: 0, pitch: 0, roll: 0 };
    expect(code(bus, 'entity.place', { ref: holder, positionMm: at(0, 4000, 0) })).toBeNull();
    const id = bus.state.nextEntityId - 1;
    const on = { entity: id, mount: 'socket' };
    // The socket is at (54, 54, 40) in the holder; the bulb's anchor is (−30, −30).
    expect(checkMount(bus.state, BUILTIN_CATALOG, bulb, at(24, 4024, 40), Z, on, null)).toBeNull();
    expect(checkMount(bus.state, BUILTIN_CATALOG, bulb, at(54, 4054, 40), Z, on, null)?.code).toBe('off-mount');
    expect(placeInWorld(bus.state, bulb, at(40, 4040, 40), [], { catalog: BUILTIN_CATALOG })).toMatchObject({
      ok: true,
      kind: 'mount',
      positionMm: at(24, 4024, 40),
      mountedOn: on,
    });
    const box = { id: 'box.tinmoor-1g-steel', version: 1 };
    const sw = { id: 'switch.castellby-3way-15a', version: 1 };
    expect(code(bus, 'entity.place', { ref: box, positionMm: at(1000, 4000, 0) })).toBeNull();
    const boxId = bus.state.nextEntityId - 1;
    // The yoke is at (2, 2, 2) inside the box; the switch's anchor is (6, 4).
    expect(
      checkMount(bus.state, BUILTIN_CATALOG, sw, at(1008, 4006, 2), Z, { entity: boxId, mount: 'yoke' }, null),
    ).toBeNull();
  });
});

describe('beltChoices hides superseded entries', () => {
  it('offers no superseded device or conductor of the built-in catalogue', () => {
    const superseded = new Set(
      BUILTIN_CATALOG.devices.filter((d) => d.supersededBy !== null).map((d) => `${d.id}@${d.version}`),
    );
    expect(superseded.size).toBeGreaterThan(0);
    for (const choice of beltChoices(BUILTIN_CATALOG)) {
      expect(superseded.has(`${choice.ref.id}@${choice.ref.version}`)).toBe(false);
    }
  });

  it('drops an id whose newest entry is superseded by another id', () => {
    const kettle = RESIDENTIAL_TEST_CATALOG.device(RESIDENTIAL.kettle);
    const catalog = catalogOrThrow(
      RESIDENTIAL_TEST_CATALOG.version,
      {
        devices: [
          ...RESIDENTIAL_TEST_CATALOG.devices,
          { ...kettle, id: 'appliance.test-old-kettle', supersededBy: RESIDENTIAL.kettle },
        ],
        cables: RESIDENTIAL_TEST_CATALOG.cables,
        tools: RESIDENTIAL_TEST_CATALOG.tools,
        accessories: RESIDENTIAL_TEST_CATALOG.accessories,
        tables: RESIDENTIAL_TEST_CATALOG.tables,
      },
      RESIDENTIAL_TEST_KINDS,
    );
    const ids = beltChoices(catalog).map((c) => c.ref.id);
    expect(ids).toContain('appliance.test-kettle');
    expect(ids).not.toContain('appliance.test-old-kettle');
  });
});

describe('argOptionChoices (palette suggestions; form-only)', () => {
  it('lists outlets, colours less bare, panel spaces and momentary controls', () => {
    const bus = residentialBench();
    expect(code(bus, 'panel.directory', { id: 4, space: 2, text: 'BATH' })).toBeNull();
    const w = bus.state;
    const c = RESIDENTIAL_TEST_CATALOG;
    expect(argOptionChoices(w, { from: 'outlets', entity: 'receptacle' }, { receptacle: 1 }, c)).toStrictEqual([
      { value: 'top', label: 'top (5-15R)' },
      { value: 'bottom', label: 'bottom (5-15R)' },
    ]);
    expect(argOptionChoices(w, { from: 'outlets', entity: 'receptacle' }, { receptacle: '1' }, c)).toHaveLength(2);
    expect(argOptionChoices(w, { from: 'outlets', entity: 'receptacle' }, { receptacle: 'x' }, c)).toStrictEqual([]);
    const colours = argOptionChoices(w, { from: 'colours', except: ['bare'] }, {}, c).map((o) => o.value);
    expect(colours).toContain('black');
    expect(colours).not.toContain('bare');
    expect(argOptionChoices(w, { from: 'directorySpaces' }, { id: 4 }, c)).toStrictEqual([
      { value: '1', label: '1' },
      { value: '2', label: '2: BATH' },
      { value: '3', label: '3' },
      { value: '4', label: '4' },
    ]);
    expect(argOptionChoices(w, { from: 'controls', type: 'momentary' }, { id: 6 }, c)).toStrictEqual([
      { value: 'test', label: 'Test' },
      { value: 'reset', label: 'Reset' },
    ]);
    expect(argOptionChoices(w, { from: 'controls', type: 'momentary' }, { id: 7 }, c)).toStrictEqual([]);
    expect(argOptionChoices(w, { from: 'controls' }, { id: 99 }, c)).toStrictEqual([]);
  });
});
