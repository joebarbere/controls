import fc from 'fast-check';
import { assertNoNegativeZero, rawWorldV4Arb } from '../../testing/arbitraries';
import { createWorld, migrateWorld } from '../documents';
import { AREA_ID_PATTERN, AreaId, DeviceStateBagV4, LabelText, MAX_DEVICE_STATE_KEYS } from '../primitives';
import { FIXTURE_ID_PATTERN } from '../v1/world';
import { ConductorColourV3, MAX_ROUTE_WAYPOINTS } from '../v3/world';
import { MAX_AREAS, WorldV4 } from './world';

/*
 * WorldV4 (ADR 0019): v3's invariants (ADR 0015) and v4's (9 plugs, 10 markings, 11 areas), each broken
 * one at a time from a valid world holding a lead, a routed conductor landed at both ends and marked at
 * one, a cable with one conductor landed and one free, a device mounted in a box, an appliance plugged
 * into a receptacle and two areas.
 */

const Z = { yaw: 0, pitch: 0, roll: 0 };
const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const entity = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  ref: { id: 'switch.tessaline-spst-toggle', version: 1 },
  transform: { positionMm: at(id * 100), orientationMdeg: Z },
  state: {},
  sim: {},
  mountedOn: null,
  inEntry: null,
  label: null,
  extensions: {},
  pluggedInto: null,
  ...overrides,
});
const termination = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  method: 'screw',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm: 1.2,
  accessory: null,
  ...overrides,
});
const free = (x: number) => ({ kind: 'free', positionMm: at(x), entity: null, fixture: null, tool: null });
const lead = (id: number, a: [number, string], b: [number, string]) => ({
  id,
  ref: { id: 'lead.quillfern-test-1m', version: 1 },
  a: { entity: a[0], terminal: a[1], termination: null },
  b: { entity: b[0], terminal: b[1], termination: null },
  cable: null,
  route: null,
  lengthMm: null,
  colour: null,
  label: null,
  state: {},
  sim: {},
  extensions: {},
  marking: { a: null, b: null },
});
const conductor = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  ref: { id: 'conductor.fixture-thhn-14', version: 1 },
  a: { entity: 1, terminal: 'a', termination: termination(1) },
  b: { entity: 2, terminal: 'a', termination: termination(2) },
  cable: null,
  route: [{ kind: 'duct', positionMm: at(150, 50), entity: 3, fixture: null, tool: null }],
  lengthMm: 600,
  colour: { base: 'black', stripe: null },
  label: 'L1',
  state: {},
  sim: {},
  extensions: {},
  marking: { a: 'red', b: null },
  ...overrides,
});
const cableConductor = (id: number, index: number, overrides: Record<string, unknown> = {}) =>
  conductor(id, {
    a: null,
    b: null,
    cable: { id: 1, conductor: index },
    route: null,
    lengthMm: 3000,
    label: null,
    ...overrides,
  });
const cable = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  ref: { id: 'cable.fixture-14-2', version: 1 },
  a: { entity: 3, entry: 'ko1' },
  b: null,
  route: [free(900)],
  lengthMm: 3000,
  tailsMm: { a: 200, b: 0 },
  jacketStripMm: { a: 150, b: 0 },
  label: null,
  extensions: {},
  ...overrides,
});

const area = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  use: 'kitchen',
  minMm: at(0),
  maxMm: at(3000, 2400, 4000),
  ...overrides,
});

const world = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 4,
  seed: 42,
  tick: 15,
  nextEntityId: 6,
  nextConnectionId: 5,
  nextCableId: 2,
  nextTerminationId: 4,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [{ id: 'stud-1', ref: { id: 'prop.stud', version: 1 }, transform: entity(1).transform, extensions: {} }],
  areas: [area('hall', { use: 'hall', minMm: at(-500), maxMm: at(0, 2400, 4000) }), area('kitchen')],
  entities: [
    entity(1, { label: 'S1' }),
    entity(2, { mountedOn: { entity: 3, mount: 'yoke' } }),
    entity(3),
    entity(4, { ref: { id: 'receptacle.fixture-duplex-5-15r', version: 1 } }),
    entity(5, { ref: { id: 'appliance.fixture-kettle', version: 1 }, pluggedInto: { entity: 4, outlet: 'top' } }),
  ],
  connections: [
    lead(1, [1, 'b'], [2, 'b']),
    conductor(2),
    cableConductor(3, 0, { a: { entity: 1, terminal: 'b', termination: termination(3) } }),
    cableConductor(4, 1),
  ],
  cables: [cable()],
  sim: null,
  extensions: {},
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = WorldV4.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

/** The base world with one connection replaced. */
const withConnection = (index: number, connection: unknown) => {
  const connections: unknown[] = [...world().connections];
  connections[index] = connection;
  return world({ connections });
};

describe('WorldV4', () => {
  it('accepts a world with a lead, a marked conductor, a cable, a mounted device, a plug and areas', () => {
    expect(issuesOf(world())).toStrictEqual([]);
    expect(WorldV4.parse(world())).toStrictEqual(world());
  });

  it('createWorld builds an empty, never-solved world with every counter at 1', () => {
    expect(createWorld({ seed: 7 })).toStrictEqual(
      world({
        seed: 7,
        tick: 0,
        nextEntityId: 1,
        nextConnectionId: 1,
        nextCableId: 1,
        nextTerminationId: 1,
        fixtures: [],
        areas: [],
        entities: [],
        connections: [],
        cables: [],
      }),
    );
    expect(() => createWorld({ seed: 2 ** 32 })).toThrow();
  });

  it('1: ids sorted and below their counters; termination ids unique and below nextTerminationId', () => {
    expect(issuesOf(world({ nextEntityId: 5 }))).toContain('Entity id must be below its counter');
    expect(issuesOf(world({ nextConnectionId: 4 }))).toContain('Connection id must be below its counter');
    expect(issuesOf(world({ nextCableId: 1 }))).toContain('Cable id must be below its counter');
    expect(issuesOf(world({ nextTerminationId: 3 }))).toContain('Termination id must be below nextTerminationId');
    expect(issuesOf(world({ cables: [cable(), cable()], nextCableId: 2 }))).toContain(
      'Cable ids must be unique and sorted in ascending order',
    );
    const connections = world().connections;
    expect(issuesOf(world({ connections: [connections[1], connections[0], ...connections.slice(2)] }))).toContain(
      'Connection ids must be unique and sorted in ascending order',
    );
    const twice = conductor(2, { b: { entity: 2, terminal: 'a', termination: termination(1) } });
    expect(issuesOf(withConnection(1, twice))).toContain('Termination ids must be unique in the world');
  });

  it('2: mountedOn names another entity that exists, with no cycle', () => {
    const mounted = (id: number, on: number) => entity(id, { mountedOn: { entity: on, mount: 'm' } });
    expect(issuesOf(world({ entities: [entity(1), mounted(2, 2), entity(3)] }))).toContain(
      'An entity is not mounted on itself',
    );
    expect(issuesOf(world({ entities: [entity(1), mounted(2, 9), entity(3)] }))).toContain(
      'An entity is mounted on an entity that exists',
    );
    expect(issuesOf(world({ entities: [mounted(1, 3), mounted(2, 1), mounted(3, 2)] }))).toContain(
      'Mounts, entries and plugs must not form a cycle',
    );
    expect(issuesOf(world({ entities: [entity(1), mounted(2, 1), mounted(3, 1)] }))).toStrictEqual([]);
  });

  it('2b: inEntry names another entity that exists, one entity per entry, never with mountedOn', () => {
    const inEntry = (id: number, on: number, entry = 'ko-1', overrides: Record<string, unknown> = {}) =>
      entity(id, { inEntry: { entity: on, entry }, ...overrides });
    expect(issuesOf(world({ entities: [entity(1), inEntry(2, 2), entity(3)] }))).toContain(
      'An entity is not in an entry of itself',
    );
    expect(issuesOf(world({ entities: [entity(1), inEntry(2, 9), entity(3)] }))).toContain(
      'An entity is in an entry of an entity that exists',
    );
    expect(issuesOf(world({ entities: [entity(1), inEntry(2, 1), inEntry(3, 1)] }))).toContain(
      'At most one entity is in each entry',
    );
    const both = inEntry(2, 1, 'ko-1', { mountedOn: { entity: 3, mount: 'm' } });
    expect(issuesOf(world({ entities: [entity(1), both, entity(3)] }))).toContain(
      'An entity is either mounted or in an entry, not both',
    );
    expect(issuesOf(world({ entities: [entity(1), inEntry(2, 1, 'ko-1'), inEntry(3, 1, 'ko-2')] }))).toStrictEqual([]);
  });

  it('9: mounts, entries and plugs together form no cycle (one walk, one message)', () => {
    const cycle = 'Mounts, entries and plugs must not form a cycle';
    const plugged = (id: number, on: number) => entity(id, { pluggedInto: { entity: on, outlet: 'top' } });
    const inEntry = (id: number, on: number) => entity(id, { inEntry: { entity: on, entry: 'ko-1' } });
    const mounted = (id: number, on: number) => entity(id, { mountedOn: { entity: on, mount: 'm' } });
    // A in an entry of B, B in an entry of A.
    expect(issuesOf(world({ entities: [inEntry(1, 2), inEntry(2, 1), entity(3)] }))).toContain(cycle);
    // B mounted on A while A is in an entry of B.
    expect(issuesOf(world({ entities: [inEntry(1, 2), mounted(2, 1), entity(3)] }))).toContain(cycle);
    // Three long: 1 in 2, 2 on 3, 3 in 1.
    expect(issuesOf(world({ entities: [inEntry(1, 2), mounted(2, 3), inEntry(3, 1)] }))).toContain(cycle);
    // A mount-only cycle has the same message (v3's two walks are one).
    expect(issuesOf(world({ entities: [mounted(1, 3), mounted(2, 1), mounted(3, 2)] }))).toContain(cycle);
    // A strip plugged into a strip plugged into the first.
    expect(issuesOf(world({ entities: [plugged(1, 2), plugged(2, 1), entity(3)] }))).toContain(cycle);
    // Through all three: 1 plugged into 2, 2 mounted on 3, 3 in an entry of 1.
    expect(issuesOf(world({ entities: [plugged(1, 2), mounted(2, 3), inEntry(3, 1)] }))).toContain(cycle);
    // A self-relation is reported by its own rule, not as a cycle.
    const self = issuesOf(world({ entities: [plugged(1, 1), entity(2), entity(3)] }));
    expect(self).toContain('An entity is not plugged into itself');
    expect(self).not.toContain(cycle);
    // Chains are fine: 1 in an entry of 2, 2 mounted on 3; 1 plugged into 3 beside 2 mounted on 3.
    expect(issuesOf(world({ entities: [inEntry(1, 2), mounted(2, 3), entity(3)] }))).toStrictEqual([]);
    expect(issuesOf(world({ entities: [plugged(1, 3), mounted(2, 3), entity(3)] }))).toStrictEqual([]);
  });

  it('9: pluggedInto names another entity that exists, one plug per outlet, never mounted or in an entry', () => {
    const plugged = (id: number, on: number, outlet = 'top', overrides: Record<string, unknown> = {}) =>
      entity(id, { pluggedInto: { entity: on, outlet }, ...overrides });
    expect(issuesOf(world({ entities: [entity(1), plugged(2, 2), entity(3)] }))).toContain(
      'An entity is not plugged into itself',
    );
    expect(issuesOf(world({ entities: [entity(1), plugged(2, 9), entity(3)] }))).toContain(
      'An entity is plugged into an entity that exists',
    );
    expect(issuesOf(world({ entities: [entity(1), plugged(2, 1), plugged(3, 1)] }))).toContain(
      'At most one plug is in each outlet',
    );
    expect(issuesOf(world({ entities: [entity(1), plugged(2, 1, 'top'), plugged(3, 1, 'bottom')] }))).toStrictEqual([]);
    const mounted = plugged(2, 1, 'top', { mountedOn: { entity: 3, mount: 'm' } });
    expect(issuesOf(world({ entities: [entity(1), mounted, entity(3)] }))).toContain(
      'A plugged entity is neither mounted nor in an entry',
    );
    const inEntry = plugged(2, 1, 'top', { inEntry: { entity: 3, entry: 'ko-1' } });
    expect(issuesOf(world({ entities: [entity(1), inEntry, entity(3)] }))).toContain(
      'A plugged entity is neither mounted nor in an entry',
    );
    expect(issuesOf(world({ entities: [entity(1), plugged(2, 1, 'top:1'), entity(3)] }))).not.toHaveLength(0);
  });

  it('10: a lead carries no marking; a conductor may be marked at either end with a colour id', () => {
    expect(issuesOf(withConnection(0, { ...lead(1, [1, 'b'], [2, 'b']), marking: { a: 'red', b: null } }))).toContain(
      'A lead carries no marking: { a: null, b: null }',
    );
    expect(issuesOf(withConnection(1, conductor(2, { marking: { a: 'red', b: 'blue' } })))).toStrictEqual([]);
    expect(issuesOf(withConnection(1, conductor(2, { marking: { a: 'Red', b: null } })))).not.toHaveLength(0);
    expect(issuesOf(withConnection(1, conductor(2, { marking: { a: null } })))).not.toHaveLength(0);
    // The schema checks the grammar only: `bare` (not a tape colour) is the load check's.
    expect(issuesOf(withConnection(1, conductor(2, { marking: { a: 'bare', b: null } })))).toStrictEqual([]);
  });

  it('11: areas sorted by id, never a fixture id, non-empty boxes, at most MAX_AREAS', () => {
    expect(issuesOf(world({ areas: [area('kitchen'), area('hall')] }))).toContain(
      'Area ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ areas: [area('hall'), area('hall')] }))).toContain(
      'Area ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ areas: [area('stud-1')] }))).toContain('An area id is not a fixture id');
    for (const axis of ['x', 'y', 'z'] as const) {
      const flat = area('kitchen', { maxMm: { ...at(3000, 2400, 4000), [axis]: 0 } });
      expect(issuesOf(world({ areas: [flat] })), axis).toContain(
        'An area’s maxMm is greater than its minMm on every axis',
      );
    }
    // Overlapping areas are allowed: a point in two has both uses.
    expect(issuesOf(world({ areas: [area('a-room'), area('b-room', { use: 'bathroom' })] }))).toStrictEqual([]);
    expect(issuesOf(world({ areas: [area('entity-1')] }))).not.toHaveLength(0);
    expect(issuesOf(world({ areas: [area('kitchen', { use: 'Kitchen' })] }))).not.toHaveLength(0);
    const many = Array.from({ length: MAX_AREAS + 1 }, (_, i) => area(`room-${String(i).padStart(3, '0')}`));
    expect(issuesOf(world({ areas: many }))).not.toHaveLength(0);
    expect(issuesOf(world({ areas: many.slice(0, MAX_AREAS) }))).toStrictEqual([]);
  });

  it('AreaId is the fixture-id grammar, never starting with entity-', () => {
    expect(AREA_ID_PATTERN.source).toBe(FIXTURE_ID_PATTERN.source);
    for (const good of ['kitchen', 'bath-1', 'a'.repeat(64)]) expect(AreaId.safeParse(good).success, good).toBe(true);
    for (const bad of ['', 'Kitchen', 'bath--1', '-a', 'a'.repeat(65), 'entity-3', 'bath_1']) {
      expect(AreaId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("a load centre's commanded bag (on, coverOn, openEntries and directory1 … directory42) fits a bag", () => {
    const bag: Record<string, unknown> = { on: false, coverOn: true, openEntries: 0 };
    for (let n = 1; n <= 42; n++) bag[`directory${n}`] = n % 2 === 0 ? null : 'KITCHEN 20A GFCI';
    expect(Object.keys(bag)).toHaveLength(45);
    expect(Object.keys(bag).length).toBeLessThanOrEqual(MAX_DEVICE_STATE_KEYS);
    expect(DeviceStateBagV4.safeParse(bag).success).toBe(true);
    const full = { ...bag, ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`extra${i}`, 0])) };
    expect(DeviceStateBagV4.safeParse(full).success).toBe(false);
  });

  it('3: a landed end names an entity that exists; two landed ends are different terminals', () => {
    expect(issuesOf(withConnection(0, lead(1, [1, 'b'], [9, 'b'])))).toContain(
      'A connection end names an entity that exists',
    );
    expect(issuesOf(withConnection(0, lead(1, [1, 'b'], [1, 'b'])))).toContain(
      'A connection must join two different terminals',
    );
    // A jumper between two terminals of one device is fine.
    expect(issuesOf(withConnection(0, lead(1, [1, 'a'], [1, 'b'])))).toStrictEqual([]);
  });

  it('4: a lead is lead-shaped; a conductor has a colour, exactly one of route and cable, and terminations', () => {
    const base = lead(1, [1, 'b'], [2, 'b']);
    for (const bad of [
      { ...base, label: 'L1' },
      { ...base, colour: { base: 'black', stripe: null } },
      { ...base, route: [] },
      { ...base, a: null },
      { ...base, a: { ...base.a, termination: termination(9) } },
    ]) {
      expect(issuesOf(withConnection(0, bad))).toContain(
        'A connection without lengthMm is a lead: no cable, route, colour or label, two clip ends',
      );
    }
    expect(issuesOf(withConnection(1, conductor(2, { colour: null })))).toContain('A conductor has a colour');
    expect(issuesOf(withConnection(1, conductor(2, { route: null })))).toContain(
      'A conductor has exactly one of its own route and a cable',
    );
    expect(issuesOf(withConnection(1, conductor(2, { cable: { id: 1, conductor: 2 } })))).toContain(
      'A conductor has exactly one of its own route and a cable',
    );
    expect(issuesOf(withConnection(1, conductor(2, { a: { entity: 1, terminal: 'a', termination: null } })))).toContain(
      'A landed conductor end has a termination',
    );
  });

  it('5: cable conductors name a cable that exists, with indices 0 … n − 1 and its length', () => {
    expect(issuesOf(withConnection(3, cableConductor(4, 1, { cable: { id: 7, conductor: 1 } })))).toContain(
      'A conductor names a cable that exists',
    );
    expect(issuesOf(withConnection(3, cableConductor(4, 2)))).toContain("A cable's conductor indices are 0 … n − 1");
    expect(issuesOf(withConnection(3, cableConductor(4, 0)))).toContain("A cable's conductor indices are 0 … n − 1");
    expect(issuesOf(withConnection(3, cableConductor(4, 1, { lengthMm: 2999 })))).toContain(
      "A cable conductor's lengthMm equals its cable's",
    );
    const noConductors = world({ connections: world().connections.slice(0, 2) });
    expect(issuesOf(noConductors)).toContain('A cable owns at least one conductor');
  });

  it('6: routes have hosts and tools by kind, hosts that exist, rest waypoints, distinct points', () => {
    const route = (waypoints: unknown[]) => withConnection(1, conductor(2, { route: waypoints }));
    const wp = (overrides: Record<string, unknown>) => ({ ...free(10), ...overrides });
    expect(issuesOf(route([wp({ entity: 3 })]))).toContain('A free waypoint has no host');
    expect(issuesOf(route([wp({ kind: 'duct' })]))).toContain(
      'A hosted waypoint names exactly one host: an entity or a fixture',
    );
    expect(issuesOf(route([wp({ kind: 'duct', entity: 3, fixture: 'stud-1' })]))).toContain(
      'A hosted waypoint names exactly one host: an entity or a fixture',
    );
    expect(issuesOf(route([wp({ kind: 'staple', fixture: 'stud-1' })]))).toStrictEqual([]);
    expect(issuesOf(route([wp({ kind: 'bore', fixture: 'stud-1' })]))).toContain(
      'A bore names its tool, and only a bore',
    );
    expect(
      issuesOf(route([wp({ kind: 'bore', fixture: 'stud-1', tool: { id: 'tool.bit-19mm', version: 1 } })])),
    ).toStrictEqual([]);
    expect(issuesOf(route([wp({ tool: { id: 'tool.bit-19mm', version: 1 } })]))).toContain(
      'A bore names its tool, and only a bore',
    );
    expect(issuesOf(route([wp({ kind: 'duct', entity: 9 })]))).toContain('A waypoint host must exist');
    expect(issuesOf(route([wp({ kind: 'staple', fixture: 'stud-9' })]))).toContain('A waypoint host must exist');
    expect(issuesOf(route([free(10), free(10)]))).toContain('Consecutive waypoints must be distinct');
    expect(issuesOf(route(Array.from({ length: MAX_ROUTE_WAYPOINTS + 1 }, (_, i) => free(i))))).not.toHaveLength(0);

    // A free end rests on a free first (a) or last (b) waypoint; a route has at least two points.
    const unlanded = (a: unknown, b: unknown, waypoints: unknown[]) =>
      withConnection(1, conductor(2, { a, b, route: waypoints }));
    const landedA = conductor(2).a;
    const duct = { kind: 'duct', positionMm: at(5), entity: 3, fixture: null, tool: null };
    expect(issuesOf(unlanded(landedA, null, [duct]))).toContain('A free end b rests on a last waypoint of kind free');
    expect(issuesOf(unlanded(null, landedA, [duct]))).toContain('A free end a rests on a first waypoint of kind free');
    expect(issuesOf(unlanded(landedA, null, [duct, free(9)]))).toStrictEqual([]);
    expect(issuesOf(unlanded(null, null, [free(9)]))).toContain('A route has at least two points');
    expect(issuesOf(unlanded(null, null, [free(9), free(8)]))).toStrictEqual([]);
    expect(issuesOf(unlanded(landedA, conductor(2).b, []))).toStrictEqual([]);
  });

  it('7: cable ends exist and differ; jackets stripped within tails; tails shorter than the cable', () => {
    expect(issuesOf(world({ cables: [cable({ a: { entity: 9, entry: 'ko1' } })] }))).toContain(
      'A cable end names an entity that exists',
    );
    expect(issuesOf(world({ cables: [cable({ b: { entity: 3, entry: 'ko1' }, route: [] })] }))).toContain(
      'A cable must join two different entries',
    );
    expect(issuesOf(world({ cables: [cable({ jacketStripMm: { a: 201, b: 0 } })] }))).toContain(
      'A cable end is stripped at most to its tail',
    );
    expect(
      issuesOf(world({ cables: [cable({ tailsMm: { a: 2000, b: 1000 }, jacketStripMm: { a: 0, b: 0 } })] })),
    ).toContain("A cable's tails are shorter than its length");
    expect(issuesOf(world({ cables: [cable({ route: [] })] }))).toContain(
      'A free end b rests on a last waypoint of kind free',
    );
  });

  it('8: the solution record as in v2', () => {
    const sim = { lastSolveTick: 16, topologyHash: 'a'.repeat(64), nodes: [], branches: [], islands: [] };
    expect(issuesOf(world({ sim }))).toContain('lastSolveTick must not be after tick');
  });

  it('labels are printable ASCII, 1 to 32, no leading or trailing space', () => {
    for (const good of ['TB1', 'L1 (hot)', 'x', '~!', 'a'.repeat(32)])
      expect(LabelText.safeParse(good).success).toBe(true);
    for (const bad of ['', ' TB1', 'TB1 ', 'a'.repeat(33), 'Ω1', 'TB\t1', 'é']) {
      expect(LabelText.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a stripe differs from its base colour', () => {
    expect(ConductorColourV3.safeParse({ base: 'green', stripe: 'yellow' }).success).toBe(true);
    expect(ConductorColourV3.safeParse({ base: 'green', stripe: 'green' }).success).toBe(false);
    expect(ConductorColourV3.safeParse({ base: 'Green', stripe: null }).success).toBe(false);
  });

  it('has no optional fields and refuses unknown keys', () => {
    for (const key of Object.keys(world())) {
      const partial: Record<string, unknown> = world();
      delete partial[key];
      expect(issuesOf(partial), key).not.toHaveLength(0);
    }
    expect(issuesOf(world({ wires: [] }))).not.toHaveLength(0);
    expect(issuesOf(withConnection(1, { ...conductor(2), gauge: 14 }))).not.toHaveLength(0);
    expect(issuesOf(world({ entities: [{ ...entity(1), parent: 2 }, entity(2), entity(3)] }))).not.toHaveLength(0);
    expect(issuesOf(world({ areas: [{ ...area('hall'), label: 'Hall' }] }))).not.toHaveLength(0);
    expect(issuesOf(withConnection(1, conductor(2, { marking: { a: null, b: null, c: null } })))).not.toHaveLength(0);
  });

  it('round-trips any valid world losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawWorldV4Arb, (raw) => {
        const w = WorldV4.parse(raw);
        assertNoNegativeZero(w);
        const text = JSON.stringify(w);
        const again = WorldV4.parse(JSON.parse(text));
        expect(again).toStrictEqual(w);
        expect(JSON.stringify(again)).toBe(text);
        expect(migrateWorld(JSON.parse(text))).toStrictEqual({ ok: true, value: w, fromVersion: 4 });
      }),
      { numRuns: 200 },
    );
    // Generous: 200 arbitrary v4 worlds (routes, cables, terminations) each validated twice; CI's
    // Windows and macOS runners took it past the 5 s default while every project tested in parallel.
  }, 60_000);

  it('the arbitrary reaches every shape (generator health)', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(rawWorldV4Arb, (raw) => {
        const w = WorldV4.parse(raw);
        for (const c of w.connections) {
          seen.add(c.lengthMm === null ? 'lead' : c.cable === null ? 'routed' : 'in-cable');
          if (c.a === null || c.b === null) seen.add('unlanded end');
          for (const wp of c.route ?? []) seen.add(wp.kind);
        }
        if (w.cables.length > 0) seen.add('cable');
        if (w.entities.some((e) => e.mountedOn !== null)) seen.add('mounted');
        if (w.entities.some((e) => e.inEntry !== null)) seen.add('in entry');
        if (w.entities.some((e) => e.pluggedInto !== null)) seen.add('plugged');
        if (w.connections.some((c) => c.marking.a !== null || c.marking.b !== null)) seen.add('marked');
        if (w.areas.length > 0) seen.add('area');
      }),
      { numRuns: 300 },
    );
    expect([...seen].sort()).toStrictEqual(
      [
        'area',
        'bore',
        'cable',
        'conduit',
        'duct',
        'free',
        'in entry',
        'in-cable',
        'lead',
        'marked',
        'mounted',
        'plugged',
        'routed',
        'staple',
        'unlanded end',
      ].sort(),
    );
  });

  it('numbers survive JSON bit for bit: identical under Object.is (property)', () => {
    const numbersOf = (w: WorldV4) => [
      ...w.entities.flatMap((e) => [...Object.values(e.state), ...Object.values(e.sim)]),
      ...w.connections.flatMap((c) => [
        ...Object.values(c.sim),
        ...[c.a, c.b].flatMap((end) =>
          end?.termination ? [end.termination.nickedStrandFraction, end.termination.torqueNm] : [],
        ),
      ]),
    ];
    fc.assert(
      fc.property(rawWorldV4Arb, (raw) => {
        const w = WorldV4.parse(raw);
        const before = numbersOf(w);
        const after = numbersOf(WorldV4.parse(JSON.parse(JSON.stringify(w))));
        expect(after).toHaveLength(before.length);
        before.forEach((value, index) => expect(Object.is(after[index], value), String(value)).toBe(true));
      }),
      { numRuns: 100 },
    );
  });
});
