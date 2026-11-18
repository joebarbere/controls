import { MAX_PANEL_SPACES } from '@controls/catalog';
import { createWorld, World } from '@controls/save-format';
import { RESIDENTIAL, RESIDENTIAL_TEST_CATALOG, RESIDENTIAL_TEST_KINDS } from '../testing';
import { checkWorldReferences, directoryKeyProblems } from './devices';
import { createWorldBus, createWorldRegistry } from './session';
import type { Connection, Entity } from './types';
import { checkMount } from './wiring/mounting';
import { checkPlugInsert, plugReach } from './wiring/plug';

/*
 * World v4's load checks (P4 PR 7, ADR 0019; ADR 0020's PR 7 list) on the TEST-ONLY residential
 * catalogue (`RESIDENTIAL_TEST_CATALOG`: receptacles, plugged appliances, a lampholder and bulb, a
 * four-space load centre). Nothing there is a real product; every number is `game-design: test`.
 */

const KINDS = RESIDENTIAL_TEST_KINDS;
const CATALOG = RESIDENTIAL_TEST_CATALOG;
const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const ref = (id: string) => ({ id, version: 1 });
const { duplex: DUPLEX, r20: R20, kettle: KETTLE, heater: HEATER, lamp: LAMP, strip: STRIP } = RESIDENTIAL;
const { holder: HOLDER, bulb: BULB, panel: PANEL } = RESIDENTIAL;
const Z = { yaw: 0, pitch: 0, roll: 0 };

const entity = (id: number, entityRef: Entity['ref'], x = 0, overrides: Partial<Entity> = {}): Entity => ({
  id,
  ref: entityRef,
  transform: { positionMm: at(x), orientationMdeg: Z },
  state: {},
  sim: {},
  mountedOn: null,
  inEntry: null,
  label: null,
  extensions: {},
  pluggedInto: null,
  ...overrides,
});
const plugged = (id: number, entityRef: Entity['ref'], x: number, into: number, outlet = 'top'): Entity =>
  entity(id, entityRef, x, { pluggedInto: { entity: into, outlet } });

function world(entities: Entity[], extra: Partial<World> = {}): World {
  return World.parse({ ...createWorld({ seed: 1 }), nextEntityId: 20, nextConnectionId: 20, entities, ...extra });
}
const check = (w: World) => checkWorldReferences(w, CATALOG);
const messages = (w: World) => check(w).map((i) => `${i.path}: ${i.message}`);

describe('the world v4 load check: plugs (checkPlugInsert for a plug in place)', () => {
  it('accepts plugs that mate, at quarter-turns, within the cord’s reach; one per outlet', () => {
    const good = world([
      entity(1, DUPLEX),
      plugged(2, KETTLE, 600, 1, 'top'),
      plugged(3, LAMP, -900, 1, 'bottom'), // a 1-15P enters a 5-15R
      entity(4, R20, 3000),
      plugged(5, KETTLE, 3500, 4, 'face'), // a 5-15P enters a 5-20R
    ]);
    expect(check(good)).toStrictEqual([]);
  });

  it('refuses each way a stored plug disagrees with the catalogue', () => {
    const cases: [Entity[], string][] = [
      [[entity(1, DUPLEX), plugged(2, HEATER, 0, 1)], 'wrong-configuration'],
      [[entity(1, DUPLEX), plugged(2, KETTLE, 1001, 1)], 'out-of-reach'],
      [[entity(1, DUPLEX), plugged(2, KETTLE, 0, 1, 'side')], 'unknown-outlet'],
      [[entity(1, HOLDER), plugged(2, KETTLE, 0, 1)], 'not-a-receptacle'],
      [[entity(1, DUPLEX), plugged(2, BULB, 0, 1)], 'not-an-appliance'],
      [
        [
          entity(1, DUPLEX, 0, { transform: { positionMm: at(0), orientationMdeg: { ...Z, yaw: 45_000 } } }),
          plugged(2, KETTLE, 100, 1),
        ],
        'not-axis-aligned',
      ],
    ];
    for (const [entities, code] of cases) {
      expect(messages(world(entities)), code).toStrictEqual([
        `entities[1].pluggedInto: Not a plug the receptacle takes there (${code})`,
      ]);
    }
    // Reach is exact in integers: 1000 mm reaches, 1001 doesn't (above); diagonal √(600² + 800²) = 1000.
    expect(check(world([entity(1, DUPLEX), plugged(2, KETTLE, 1000, 1)]))).toStrictEqual([]);
    const diagonal = entity(2, KETTLE, 600, { transform: { positionMm: at(600, 800), orientationMdeg: Z } });
    expect(check(world([entity(1, DUPLEX), { ...diagonal, pluggedInto: { entity: 1, outlet: 'top' } }]))).toStrictEqual(
      [],
    );
  });

  it('leaves a plug alone where the catalogue doesn’t know the receptacle; a built-in prop has no plug, outlets or mounts', () => {
    const unknown = { id: 'receptacle.fixture-unknown', version: 1 };
    expect(check(world([entity(1, unknown), plugged(2, KETTLE, 5000, 1)]))).toStrictEqual([]);
    expect(messages(world([entity(1, DUPLEX), plugged(2, ref('prop.crate'), 0, 1)]))).toStrictEqual([
      'entities[1].pluggedInto: A built-in prop has no cord plug',
    ]);
    // A built-in prop is known, not unknown: it has no outlets (plug.insert: not-a-receptacle) and no mounts.
    expect(messages(world([entity(1, ref('prop.crate')), plugged(2, KETTLE, 0, 1)]))).toStrictEqual([
      'entities[1].pluggedInto: A built-in prop has no outlets',
    ]);
    expect(
      checkPlugInsert(world([entity(1, ref('prop.crate')), entity(2, KETTLE)]), CATALOG, {
        appliance: 2,
        receptacle: 1,
        outlet: 'top',
      })?.code,
    ).toBe('not-a-receptacle');
    const onProp = world([
      entity(1, ref('prop.crate')),
      entity(2, BULB, 0, { mountedOn: { entity: 1, mount: 'socket' } }),
    ]);
    expect(messages(onProp)).toStrictEqual(['entities[1].mountedOn: A built-in prop has no mounts']);
    expect(checkMount(onProp, CATALOG, BULB, at(0), Z, { entity: 1, mount: 'socket' }, 2)?.code).toBe('unknown-mount');
  });
});

describe('checkPlugInsert and plugReach (the command check, shared with the load check)', () => {
  const base = [entity(1, DUPLEX), entity(2, KETTLE, 600), entity(3, LAMP, -600), entity(4, R20, 5000)];
  const code = (entities: Entity[], args: { appliance: number; receptacle: number; outlet: string }) =>
    checkPlugInsert(world(entities), CATALOG, args)?.code ?? null;

  it('accepts a plug that fits and refuses in the documented order', () => {
    expect(code(base, { appliance: 2, receptacle: 1, outlet: 'top' })).toBeNull();
    expect(code(base, { appliance: 9, receptacle: 1, outlet: 'top' })).toBe('not-found');
    expect(code(base, { appliance: 1, receptacle: 4, outlet: 'face' })).toBe('not-an-appliance');
    const pluggedIn = [entity(1, DUPLEX), plugged(2, KETTLE, 600, 1), entity(3, LAMP, -600)];
    expect(code(pluggedIn, { appliance: 2, receptacle: 1, outlet: 'bottom' })).toBe('already-plugged');
    expect(code(base, { appliance: 2, receptacle: 9, outlet: 'top' })).toBe('not-found');
    expect(code(base, { appliance: 2, receptacle: 2, outlet: 'top' })).toBe('plug-cycle');
    expect(code(base, { appliance: 2, receptacle: 3, outlet: 'top' })).toBe('not-a-receptacle');
    expect(code(base, { appliance: 2, receptacle: 1, outlet: 'side' })).toBe('unknown-outlet');
    expect(code(pluggedIn, { appliance: 3, receptacle: 1, outlet: 'top' })).toBe('outlet-occupied');
    expect(code(pluggedIn, { appliance: 3, receptacle: 1, outlet: 'bottom' })).toBeNull();
    expect(code([...base, entity(5, HEATER)], { appliance: 5, receptacle: 1, outlet: 'top' })).toBe(
      'wrong-configuration',
    );
    expect(code(base, { appliance: 2, receptacle: 4, outlet: 'face' })).toBe('out-of-reach');
    // A plug already in place doesn't count against itself (the load check's `existing`).
    expect(
      checkPlugInsert(world(pluggedIn), CATALOG, { appliance: 2, receptacle: 1, outlet: 'top' }, { existing: true }),
    ).toBeNull();
  });

  it('refuses a plug that would close a cycle through mounts, entries or plugs', () => {
    // Strip 1 is plugged into strip 2: strip 2 can't plug into strip 1 (a strip into a strip into the first).
    const strips = [plugged(1, STRIP, 0, 2, 'socket-1'), entity(2, STRIP, 300)];
    expect(code(strips, { appliance: 2, receptacle: 1, outlet: 'socket-1' })).toBe('plug-cycle');
    // A chain is fine: strip 2 into a wall receptacle.
    expect(code([...strips, entity(3, DUPLEX, 600)], { appliance: 2, receptacle: 3, outlet: 'top' })).toBeNull();
  });

  it('plugReach measures the squared straight line from the cord exit to the outlet face', () => {
    const w = world(base);
    const [receptacle, kettle] = w.entities;
    expect(plugReach(CATALOG, kettle, receptacle, 'bottom')).toStrictEqual({
      distanceSquaredMm2: 600 * 600 + 40 * 40,
      cordLengthSquaredMm2: 1000 * 1000,
      reaches: true,
    });
    expect(plugReach(CATALOG, kettle, receptacle, 'side')).toBeNull();
    expect(plugReach(CATALOG, receptacle, receptacle, 'top')).toBeNull();
  });
});

describe('the world v4 load check: markings, areas and directory keys', () => {
  const conductor = (marking: Connection['marking']): Connection => ({
    id: 1,
    ref: { id: 'conductor.fixture-thhn-14', version: 1 },
    a: null,
    b: null,
    cable: null,
    route: [
      { kind: 'free', positionMm: at(0), entity: null, fixture: null, tool: null },
      { kind: 'free', positionMm: at(100), entity: null, fixture: null, tool: null },
    ],
    lengthMm: 200,
    colour: { base: 'white', stripe: null },
    label: null,
    state: {},
    sim: {},
    extensions: {},
    marking,
  });

  it('tape is a colour-table id and never bare (whatever the conductor’s ref)', () => {
    expect(check(world([], { connections: [conductor({ a: 'black', b: 'red' })] }))).toStrictEqual([]);
    expect(messages(world([], { connections: [conductor({ a: 'bare', b: 'mauve' })] }))).toStrictEqual([
      'connections[0].marking.a: Bare is not a tape colour',
      'connections[0].marking.b: Not in the colour table',
    ]);
  });

  it('an area’s use is a row of AREA_USES', () => {
    const area = (id: string, use: string) => ({ id, use, minMm: at(0), maxMm: at(1, 1, 1) });
    expect(check(world([], { areas: [area('hall', 'hall'), area('loft', 'crawlSpace')] }))).toStrictEqual([]);
    expect(messages(world([], { areas: [area('ballroom', 'ballroom')] }))).toStrictEqual([
      'areas[0].use: Not an area use (AREA_USES)',
    ]);
  });

  it('a load centre’s directory keys above its spaces stay null', () => {
    const directory = Object.fromEntries(
      Array.from({ length: MAX_PANEL_SPACES }, (_, i) => [`directory${i + 1}`, null]),
    );
    const panel = (state: Record<string, unknown>) =>
      entity(1, PANEL, 0, { state: { openEntries: 0, ...directory, ...state } as Entity['state'] });
    expect(check(world([panel({ directory1: 'KITCHEN', directory4: 'BATH' })]))).toStrictEqual([]);
    expect(messages(world([panel({ directory5: 'SPARE', directory42: 'X' })]))).toStrictEqual([
      "entities[0].state.directory42: Space 42 is above the panel's 4: it stays null",
      "entities[0].state.directory5: Space 5 is above the panel's 4: it stays null",
    ]);
    // A device with no spaces keeps every directory key null; a kind without them has none to check.
    const notPanel = CATALOG.device(DUPLEX);
    if (!notPanel) throw new Error('missing');
    expect(directoryKeyProblems(KINDS['test.loadCentre'], notPanel, { directory1: 'A' })).toHaveLength(1);
    expect(directoryKeyProblems(KINDS['test.device'], notPanel, { directory1: 'A' })).toStrictEqual([]);
  });
});

describe('mountedOn resolves through offeredMounts (a host need not be an enclosure)', () => {
  it('a bulb on a lampholder’s hostMounts socket loads, and checkMount accepts it', () => {
    const w = world([entity(1, HOLDER), entity(2, BULB, 0, { mountedOn: { entity: 1, mount: 'socket' } })]);
    expect(check(w)).toStrictEqual([]);
    expect(checkMount(w, CATALOG, BULB, at(0), Z, { entity: 1, mount: 'socket' }, 2)).toBeNull();
    const wrong = world([entity(1, HOLDER), entity(2, BULB, 0, { mountedOn: { entity: 1, mount: 'yoke' } })]);
    expect(messages(wrong)).toStrictEqual(["entities[1].mountedOn.mount: Not a mount of the host's catalogue entry"]);
    expect(checkMount(w, CATALOG, BULB, at(5), Z, { entity: 1, mount: 'socket' }, 2)?.code).toBe('off-mount');
    // A second bulb on the single socket finds no room.
    expect(checkMount(w, CATALOG, BULB, at(0), Z, { entity: 1, mount: 'socket' }, null)?.code).toBe('mount-full');
  });
});

describe('plug occupancy in the P3 entity commands', () => {
  const registry = createWorldRegistry({ catalog: CATALOG });
  const start = () => world([entity(1, DUPLEX), plugged(2, KETTLE, 600, 1)]);

  it('a plugged appliance can’t move or turn; a receptacle holding a plug can’t move or turn', () => {
    const bus = createWorldBus(start(), registry);
    expect(bus.exec('entity.move', { id: 2, positionMm: at(700) })).toMatchObject({
      ok: false,
      error: { code: 'plugged' },
    });
    expect(bus.exec('entity.rotate', { id: 2, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'plugged' },
    });
    expect(bus.exec('entity.move', { id: 1, positionMm: at(10) })).toMatchObject({
      ok: false,
      error: { code: 'occupied' },
    });
    expect(bus.exec('entity.rotate', { id: 1, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'occupied' },
    });
  });

  it('deleting a plugged appliance takes its plug with it; undo restores the relation exactly', () => {
    const initial = start();
    const bus = createWorldBus(initial, registry);
    expect(bus.exec('entity.delete', { id: 2 })).toMatchObject({ ok: true });
    expect(World.safeParse(bus.state).success).toBe(true);
    expect(bus.state.entities.map((e) => e.id)).toStrictEqual([1]);
    expect(bus.exec('edit.undo', {})).toMatchObject({ ok: true });
    expect(bus.state).toStrictEqual(initial);
  });

  it('entity.place makes an unplugged entity', () => {
    const bus = createWorldBus(world([]), registry);
    expect(bus.exec('entity.place', { ref: KETTLE, positionMm: at(0) })).toMatchObject({ ok: true });
    expect(bus.state.entities[0].pluggedInto).toBeNull();
  });
});
