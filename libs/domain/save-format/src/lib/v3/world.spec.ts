import fc from 'fast-check';
import { assertNoNegativeZero, rawWorldV3Arb } from '../../testing/arbitraries';
import { createWorld, migrateWorld } from '../documents';
import { LabelText } from '../primitives';
import { ConductorColourV3, MAX_ROUTE_WAYPOINTS, WorldV3 } from './world';

/*
 * WorldV3 (ADR 0015): every schema invariant, broken one at a time from a valid world holding a lead,
 * a routed conductor landed at both ends, a cable with one conductor landed and one free, and a device
 * mounted in a box.
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
  label: null,
  extensions: {},
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

const world = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 3,
  seed: 42,
  tick: 15,
  nextEntityId: 4,
  nextConnectionId: 5,
  nextCableId: 2,
  nextTerminationId: 4,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [{ id: 'stud-1', ref: { id: 'prop.stud', version: 1 }, transform: entity(1).transform, extensions: {} }],
  entities: [entity(1, { label: 'S1' }), entity(2, { mountedOn: { entity: 3, mount: 'yoke' } }), entity(3)],
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
  const result = WorldV3.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

/** The base world with one connection replaced. */
const withConnection = (index: number, connection: unknown) => {
  const connections: unknown[] = [...world().connections];
  connections[index] = connection;
  return world({ connections });
};

describe('WorldV3', () => {
  it('accepts a world with a lead, a routed conductor, a cable and a mounted device', () => {
    expect(issuesOf(world())).toStrictEqual([]);
    expect(WorldV3.parse(world())).toStrictEqual(world());
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
        entities: [],
        connections: [],
        cables: [],
      }),
    );
    expect(() => createWorld({ seed: 2 ** 32 })).toThrow();
  });

  it('1: ids sorted and below their counters; termination ids unique and below nextTerminationId', () => {
    expect(issuesOf(world({ nextEntityId: 3 }))).toContain('Entity id must be below its counter');
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
      'Mounting must not form a cycle',
    );
    expect(issuesOf(world({ entities: [entity(1), mounted(2, 1), mounted(3, 1)] }))).toStrictEqual([]);
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
  });

  it('round-trips any valid world losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawWorldV3Arb, (raw) => {
        const w = WorldV3.parse(raw);
        assertNoNegativeZero(w);
        const text = JSON.stringify(w);
        const again = WorldV3.parse(JSON.parse(text));
        expect(again).toStrictEqual(w);
        expect(JSON.stringify(again)).toBe(text);
        expect(migrateWorld(JSON.parse(text))).toStrictEqual({ ok: true, value: w, fromVersion: 3 });
      }),
      { numRuns: 200 },
    );
  });

  it('the arbitrary reaches every shape (generator health)', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(rawWorldV3Arb, (raw) => {
        const w = WorldV3.parse(raw);
        for (const c of w.connections) {
          seen.add(c.lengthMm === null ? 'lead' : c.cable === null ? 'routed' : 'in-cable');
          if (c.a === null || c.b === null) seen.add('unlanded end');
          for (const wp of c.route ?? []) seen.add(wp.kind);
        }
        if (w.cables.length > 0) seen.add('cable');
        if (w.entities.some((e) => e.mountedOn !== null)) seen.add('mounted');
      }),
      { numRuns: 300 },
    );
    expect([...seen].sort()).toStrictEqual(
      [
        'bore',
        'cable',
        'conduit',
        'duct',
        'free',
        'in-cable',
        'lead',
        'mounted',
        'routed',
        'staple',
        'unlanded end',
      ].sort(),
    );
  });

  it('numbers survive JSON bit for bit: identical under Object.is (property)', () => {
    const numbersOf = (w: WorldV3) => [
      ...w.entities.flatMap((e) => [...Object.values(e.state), ...Object.values(e.sim)]),
      ...w.connections.flatMap((c) => [
        ...Object.values(c.sim),
        ...[c.a, c.b].flatMap((end) =>
          end?.termination ? [end.termination.nickedStrandFraction, end.termination.torqueNm] : [],
        ),
      ]),
    ];
    fc.assert(
      fc.property(rawWorldV3Arb, (raw) => {
        const w = WorldV3.parse(raw);
        const before = numbersOf(w);
        const after = numbersOf(WorldV3.parse(JSON.parse(JSON.stringify(w))));
        expect(after).toHaveLength(before.length);
        before.forEach((value, index) => expect(Object.is(after[index], value), String(value)).toBe(true));
      }),
      { numRuns: 100 },
    );
  });
});
