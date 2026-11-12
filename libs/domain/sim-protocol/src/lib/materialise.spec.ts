import { createWorld, LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { compareSimEvents, ISLAND_EVENT_KINDS, type SimEvent, SIM_EVENT_KINDS } from './events';
import { MaterialiseError, materialiseWorld, type SimStateExport } from './materialise';

const transform = { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } };

/** A world at tick 40 with a battery (1), a crate (2), an unknown mod device (3) and a lamp (4). */
function world(): World {
  return World.parse({
    ...createWorld({ seed: 5 }),
    tick: 40,
    nextEntityId: 5,
    entities: [
      {
        id: 1,
        ref: { id: 'battery.ferrovane-12v-7ah', version: 1 },
        transform,
        state: {},
        sim: { stateOfCharge: 1 },
        mountedOn: null,
        label: null,
        extensions: {},
      },
      {
        id: 2,
        ref: { id: 'prop.crate', version: 1 },
        transform,
        state: {},
        sim: {},
        mountedOn: null,
        label: null,
        extensions: {},
      },
      {
        id: 3,
        ref: { id: 'mod.example-relay', version: 1 },
        transform,
        state: { coil: true },
        sim: { hot: 3 },
        mountedOn: null,
        label: null,
        extensions: {},
      },
      {
        id: 4,
        ref: { id: 'lamp.lumivane-12v-5w', version: 1 },
        transform,
        state: {},
        sim: { filamentTempK: null },
        mountedOn: null,
        label: null,
        extensions: {},
      },
    ],
  });
}

const solution = {
  lastSolveTick: 30,
  topologyHash: 'cd'.repeat(32),
  nodes: [0, 0, -0, 0],
  branches: [0.5, 0],
  islands: [{ flags: 0, iterations: 1 }],
};

describe('materialiseWorld (ADR 0011 §1, ADR 0013)', () => {
  it("writes only the exported entities' sim bags and the solution; everything else stays the same object", () => {
    const busWorld = world();
    const exported: SimStateExport = {
      tick: 40,
      entities: [
        { id: 1, state: { stateOfCharge: 0.75 } },
        { id: 4, state: { filamentTempK: 293.15 } },
      ],
      connections: [],
      solution,
    };
    const out = materialiseWorld(busWorld, exported);
    expect(out.entities.map((e) => e.sim)).toStrictEqual([
      { stateOfCharge: 0.75 },
      {},
      { hot: 3 },
      { filamentTempK: 293.15 },
    ]);
    // Props, unknown refs and every commanded bag are the bus world's, untouched.
    expect(out.entities[1]).toBe(busWorld.entities[1]);
    expect(out.entities[2]).toBe(busWorld.entities[2]);
    expect(out.entities[0].state).toBe(busWorld.entities[0].state);
    expect(out.sim).toStrictEqual({ ...solution, nodes: [0, 0, 0, 0] });
    expect(Object.is(out.sim?.nodes[2], 0)).toBe(true); // -0 normalised by the schema
    expect(World.safeParse(out).success).toBe(true);
    const { entities, sim, ...rest } = out;
    const { entities: e0, sim: s0, ...rest0 } = busWorld;
    expect([entities.length, sim === null, e0.length, s0]).toStrictEqual([4, false, 4, null]);
    expect(rest).toStrictEqual(rest0);
  });

  it('writes a null solution (an empty netlist) and leaves the bus world alone', () => {
    const busWorld = world();
    const withSolution = { ...busWorld, sim: solution };
    const out = materialiseWorld(withSolution, { tick: 40, entities: [], connections: [], solution: null });
    expect(out.sim).toBeNull();
    expect(out.entities).toStrictEqual(busWorld.entities);
    expect(withSolution.sim).toBe(solution);
  });

  it('refuses an export for another tick, of an unknown or unsorted entity, or that fails the schemas', () => {
    const busWorld = world();
    const bad: SimStateExport[] = [
      { tick: 41, entities: [], connections: [], solution: null },
      { tick: 40, entities: [{ id: 9, state: {} }], connections: [], solution: null },
      {
        tick: 40,
        entities: [
          { id: 4, state: {} },
          { id: 1, state: {} },
        ],
        connections: [],
        solution: null,
      },
      { tick: 40, entities: [], connections: [], solution: { ...solution, lastSolveTick: 41 } },
      { tick: 40, entities: [], connections: [], solution: { ...solution, nodes: [0, 0, 1] } },
      { tick: 40, entities: [{ id: 1, state: { stateOfCharge: Number.NaN } }], connections: [], solution: null },
      { tick: 40, entities: [], connections: [], solution: { ...solution, branches: [Number.POSITIVE_INFINITY, 0] } },
    ];
    for (const exported of bad) expect(() => materialiseWorld(busWorld, exported)).toThrow(MaterialiseError);
  });

  it("writes the exported connections' sim bags (F3.6 part 1) and refuses an unknown or unsorted one", () => {
    const lead = (id: number) => ({
      id,
      ref: { id: 'lead.quillfern-test-1m', version: 1 },
      a: { entity: 1, terminal: 'pos', termination: null },
      b: { entity: 4, terminal: 'a', termination: null },
      cable: null,
      route: null,
      lengthMm: null,
      colour: null,
      label: null,
      state: {},
      sim: { ...LEAD_SIM_BAG_V3 },
      extensions: {},
    });
    const busWorld = World.parse({ ...world(), nextConnectionId: 3, connections: [lead(1), lead(2)] });
    const bag = { ...LEAD_SIM_BAG_V3, conductorTempK: 300.5 };
    const out = materialiseWorld(busWorld, {
      tick: 40,
      entities: [],
      connections: [{ id: 2, state: bag }],
      solution: null,
    });
    expect(out.connections[0]).toBe(busWorld.connections[0]);
    expect(out.connections[1].sim).toStrictEqual(bag);
    expect(World.safeParse(out).success).toBe(true);
    const unknown = { tick: 40, entities: [], connections: [{ id: 9, state: bag }], solution: null };
    const unsorted = {
      tick: 40,
      entities: [],
      connections: [
        { id: 2, state: bag },
        { id: 1, state: bag },
      ],
      solution: null,
    };
    for (const exported of [unknown, unsorted]) {
      expect(() => materialiseWorld(busWorld, exported)).toThrow(MaterialiseError);
    }
  });
});

describe('sim events (ADR 0011 §4)', () => {
  const event = (tick: number, kind: SimEvent['kind'], entity: number | null, entities: number[] = []): SimEvent => ({
    tick,
    kind,
    entity,
    entities,
    detail: {},
  });

  it('sort by tick, then entity (an island event by its smallest), then kind', () => {
    const events = [
      event(5, 'tripped', 3),
      event(4, 'singular', null, [7, 9]),
      event(4, 'blown', 7),
      event(4, 'overRated', 2),
      event(4, 'nonConverged', null, []),
      event(5, 'blown', 3),
    ];
    expect(
      [...events].sort(compareSimEvents).map((e) => `${e.tick}:${e.kind}:${e.entity ?? e.entities.join('+')}`),
    ).toStrictEqual(['4:nonConverged:', '4:overRated:2', '4:blown:7', '4:singular:7+9', '5:blown:3', '5:tripped:3']);
    expect(compareSimEvents(event(1, 'blown', 1), event(1, 'blown', 1))).toBe(0);
  });

  it('island events are nonConverged and singular', () => {
    expect([...ISLAND_EVENT_KINDS].sort()).toStrictEqual(['nonConverged', 'singular']);
    expect(SIM_EVENT_KINDS).toContain('blown');
  });
});
