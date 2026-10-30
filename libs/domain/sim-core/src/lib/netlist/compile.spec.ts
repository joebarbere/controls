import { BUILTIN_CATALOG, leadResistanceOhm, type LeadParams } from '@controls/catalog';
import { createWorld, World } from '@controls/save-format';
import {
  AC_SOURCE,
  BATTERY,
  benchBus,
  benchLamp,
  CRATE,
  end,
  FUSE,
  LAMP,
  LEAD,
  origin,
  run,
  SPST,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
  UNKNOWN,
} from '../../testing/bench';
import { compileNetlist, isEmptyNetlist, NetlistCompiler } from './compile';
import { formatNetlist } from './format';
import { BUILTIN_NETLIST_MODELS, type NetlistModels } from './models';
import type { Netlist } from './types';

/** The hand-calculated resistance of the built-in 1 m test lead (see the first test). */
const LEAD_OHM = 0.04094815541017536;

const compile = (world: World) => compileNetlist(world, BUILTIN_CATALOG);

/** Each node's members as `entity:terminal` strings. */
const partition = (netlist: Netlist) => netlist.nodes.map((n) => n.members.map((m) => `${m.entity}:${m.terminal}`));

describe('compileNetlist: the bench lamp', () => {
  it('compiles each lead to one resistive branch: ρ·L/A plus a contact resistance at each end', () => {
    // Hand calculation (ADR 0013, catalogue entry lead.quillfern-test-1m):
    //   ρ₀ = 1.724137931034483e-8 Ω·m (IACS, 20 °C), L = 1 m, A = 8.2305e-7 m² (18 AWG)
    //   R_conductor = ρ₀ · L / A = 1.724137931034483e-8 / 8.2305e-7 = 0.020948155 Ω
    //   at the 20 °C bench (T = T₀) the α term is zero: R(T) = R_conductor
    //   R_lead = R_conductor + 2 × 0.01 Ω (clip contacts) = 0.040948155 Ω
    const netlist = compile(benchLamp(true));
    const leads = netlist.branches.filter((b) => b.element.kind === 'connection');
    expect(leads).toHaveLength(3);
    for (const lead of leads) {
      expect(lead).toMatchObject({ kind: 'resistor', model: 'lead', source: null });
      expect(lead.values['resistanceOhm']).toBeCloseTo(0.040948155, 9);
      expect(lead.values['resistanceOhm']).toBe(LEAD_OHM);
    }
    const params = BUILTIN_CATALOG.device(LEAD)?.model.params as LeadParams;
    expect(LEAD_OHM).toBe(leadResistanceOhm(params, 293.15));
  });

  it('a closed switch merges its terminals into one node with no branch', () => {
    const netlist = compile(benchLamp(true));
    expect(partition(netlist)).toStrictEqual([['1:neg'], ['1:pos'], ['2:a', '2:b'], ['3:a'], ['3:b']]);
    expect(netlist.branches.map((b) => [b.element, b.a, b.b])).toStrictEqual([
      [{ kind: 'entity', entity: 1, part: 'cell' }, 0, 1],
      [{ kind: 'entity', entity: 3, part: 'filament' }, 3, 4],
      [{ kind: 'connection', connection: 1 }, 1, 2],
      [{ kind: 'connection', connection: 2 }, 2, 3],
      [{ kind: 'connection', connection: 3 }, 4, 0],
    ]);
    expect(netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === 2)).toBe(false);
    expect(netlist.islands).toStrictEqual([
      { index: 0, kind: 'dc', nodes: [0, 1, 2, 3, 4], branches: [0, 1, 2, 3, 4] },
    ]);
    expect(netlist.devices).toStrictEqual([
      { entity: 1, kind: 'battery' },
      { entity: 2, kind: 'switch.spst' },
      { entity: 3, kind: 'lamp.incandescent' },
    ]);
    expect(netlist.diagnostics).toStrictEqual([]);
  });

  it('an open switch drops its branch: its terminals are separate nodes', () => {
    const netlist = compile(benchLamp(false));
    expect(partition(netlist)).toStrictEqual([['1:neg'], ['1:pos'], ['2:a'], ['2:b'], ['3:a'], ['3:b']]);
    expect(netlist.branches).toHaveLength(5);
    expect(netlist.branches.map((b) => [b.a, b.b])).toStrictEqual([
      [0, 1],
      [4, 5],
      [1, 2],
      [3, 4],
      [5, 0],
    ]);
  });

  it('formats deterministically (golden)', () => {
    expect(formatNetlist(compile(benchLamp(true)))).toBe(
      [
        'netlist 5 nodes, 5 branches, 1 island',
        `topology ${compile(benchLamp(true)).topologyHash}`,
        'island 0 dc nodes 0 1 2 3 4 branches 0 1 2 3 4',
        'node 0 island 0: 1:neg',
        'node 1 island 0: 1:pos',
        'node 2 island 0: 2:a 2:b',
        'node 3 island 0: 3:a',
        'node 4 island 0: 3:b',
        'branch 0 e1.cell vsource battery dc 0 -> 1 island 0 internalResistanceOhm=0.023 nominalVoltageV=12',
        'branch 1 e3.filament resistor lamp.incandescent 3 -> 4 island 0 ratedPowerW=5 ratedVoltageV=12',
        `branch 2 c1 resistor lead 1 -> 2 island 0 resistanceOhm=${LEAD_OHM}`,
        `branch 3 c2 resistor lead 2 -> 3 island 0 resistanceOhm=${LEAD_OHM}`,
        `branch 4 c3 resistor lead 4 -> 0 island 0 resistanceOhm=${LEAD_OHM}`,
        '',
      ].join('\n'),
    );
  });
});

describe('compileNetlist: wired, not drawn', () => {
  it('a lamp placed touching a battery but not connected to it is its own unpowered island', () => {
    const bus = benchBus();
    run(bus, 'entity.place', { ref: BATTERY, positionMm: origin });
    run(bus, 'entity.place', { ref: LAMP, positionMm: origin }); // the very same spot
    const netlist = compile(bus.state);
    expect(partition(netlist)).toStrictEqual([['1:neg'], ['1:pos'], ['2:a'], ['2:b']]);
    expect(netlist.islands.map((i) => [i.kind, i.nodes])).toStrictEqual([
      ['dc', [0, 1]],
      ['empty', [2, 3]],
    ]);
    // No branch joins the battery's island to the lamp's: the lamp carries no current and sits at 0 V.
    expect(netlist.branches.every((b) => netlist.nodes[b.a].island === netlist.nodes[b.b].island)).toBe(true);
  });

  it('moving and rotating entities never changes the netlist', () => {
    const bus = benchBus();
    for (const ref of [BATTERY, SPST, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(3, 'a') });
    const before = compile(bus.state);
    run(bus, 'entity.move', { id: 1, positionMm: { x: 5000, y: 0, z: -300 } });
    run(bus, 'entity.rotate', { id: 3, deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } });
    expect(compile(bus.state)).toStrictEqual(before);
  });

  it('deleting an entity removes its leads in the same change, so none is compiled (and undo restores them)', () => {
    const bus = benchBus();
    for (const ref of [BATTERY, SPST, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    run(bus, 'lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(3, 'a') });
    run(bus, 'lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') });
    const before = compile(bus.state);
    run(bus, 'entity.delete', { id: 2 });
    expect(bus.state.connections.map((c) => c.id)).toStrictEqual([3]);
    const after = compile(bus.state);
    expect(after.branches.map((b) => b.element)).toStrictEqual([
      { kind: 'entity', entity: 1, part: 'cell' },
      { kind: 'entity', entity: 3, part: 'filament' },
      { kind: 'connection', connection: 3 },
    ]);
    expect(after.diagnostics).toStrictEqual([]);
    run(bus, 'edit.undo');
    expect(compile(bus.state)).toStrictEqual(before);
  });
});

describe('compileNetlist: what is absent', () => {
  it('leaves out props, unknown devices and their connections, with diagnostics for the devices', () => {
    const world = World.parse({
      ...createWorld({ seed: 1 }),
      nextEntityId: 5,
      nextConnectionId: 3,
      entities: [BATTERY, CRATE, UNKNOWN, LAMP].map((ref, i) => ({
        id: i + 1,
        ref,
        transform: { positionMm: origin, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
        state: {},
        sim: ref === BATTERY ? { stateOfCharge: 1 } : ref === LAMP ? { filamentTempK: null } : {},
        extensions: {},
      })),
      connections: [
        { id: 1, ref: LEAD, a: end(3, 'x'), b: end(1, 'pos') },
        { id: 2, ref: LEAD, a: end(1, 'neg'), b: end(4, 'b') },
      ].map((c) => ({ ...c, extensions: {} })),
    });
    const netlist = compile(world);
    expect(netlist.devices.map((d) => d.entity)).toStrictEqual([1, 4]);
    expect(netlist.branches.map((b) => b.element)).toStrictEqual([
      { kind: 'entity', entity: 1, part: 'cell' },
      { kind: 'entity', entity: 4, part: 'filament' },
      { kind: 'connection', connection: 2 },
    ]);
    expect(netlist.diagnostics).toStrictEqual([
      { code: 'unknown-device', entity: 3 },
      { code: 'absent-connection', connection: 1, reason: 'absent-end' },
    ]);
    expect(netlist.nodes.flatMap((n) => n.members.map((m) => m.entity))).not.toContain(2);
  });

  const rawWorld = (connections: object[], entities: object[] = [BATTERY, LAMP]) =>
    World.parse({
      ...createWorld({ seed: 1 }),
      nextEntityId: entities.length + 1,
      nextConnectionId: connections.length + 1,
      entities: entities.map((ref, i) => ({
        id: i + 1,
        ref,
        transform: { positionMm: origin, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
        state: {},
        sim: {},
        extensions: {},
      })),
      connections: connections.map((c, i) => ({ id: i + 1, extensions: {}, ...c })),
    });

  it.each([
    ['an unknown connection ref', { id: 'lead.mod-thing', version: 1 }, 'pos', 'unknown-ref'],
    ['a ref that is not a connection kind', LAMP, 'pos', 'not-a-connection'],
    ['an end on a terminal the device lacks', LEAD, 'plus', 'unknown-terminal'],
  ])('leaves out a connection with %s', (_name, ref, terminal, reason) => {
    const netlist = compile(rawWorld([{ ref, a: end(1, terminal), b: end(2, 'a') }]));
    expect(netlist.branches.filter((b) => b.element.kind === 'connection')).toStrictEqual([]);
    expect(netlist.diagnostics).toStrictEqual([{ code: 'absent-connection', connection: 1, reason }]);
  });

  it('leaves out kinds sim-core has no model for, and connection kinds placed as entities', () => {
    const models: NetlistModels = { devices: {}, connections: {} };
    const world = rawWorld([{ ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }]);
    const netlist = compileNetlist(world, BUILTIN_CATALOG, { models });
    expect(netlist.nodes).toStrictEqual([]);
    expect(netlist.diagnostics).toStrictEqual([
      { code: 'no-model', entity: 1, kind: 'battery' },
      { code: 'no-model', entity: 2, kind: 'lamp.incandescent' },
      { code: 'absent-connection', connection: 1, reason: 'no-model' },
    ]);
    expect(isEmptyNetlist(netlist)).toBe(true);
    // A lead placed as an entity (refused at load, ADR 0013) is never netlisted.
    expect(compile(rawWorld([], [LEAD])).diagnostics).toStrictEqual([{ code: 'no-model', entity: 1, kind: 'lead' }]);
  });

  it('an empty world (or one with only props) has an empty netlist', () => {
    const empty = compile(createWorld({ seed: 3 }));
    expect(isEmptyNetlist(empty)).toBe(true);
    expect(empty).toMatchObject({ nodes: [], branches: [], islands: [], devices: [], diagnostics: [] });
    expect(isEmptyNetlist(compile(rawWorld([], [CRATE])))).toBe(true);
    expect(isEmptyNetlist(compile(benchLamp(true)))).toBe(false);
  });
});

describe('compileNetlist: ADR 0011 §7 guarantees and islands', () => {
  it('a lead across a closed switch is a branch whose ends are the same node', () => {
    const bus = benchBus();
    run(bus, 'entity.place', { ref: SPST, positionMm: origin });
    run(bus, 'device.operate', { id: 1, control: 'closed', value: true });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'b'), b: end(1, 'a') });
    const netlist = compile(bus.state);
    expect(partition(netlist)).toStrictEqual([['1:a', '1:b']]);
    expect(netlist.branches).toMatchObject([{ element: { kind: 'connection', connection: 1 }, a: 0, b: 0 }]);
  });

  it('a connection’s branch runs from its end a to its end b', () => {
    const bus = benchBus();
    for (const ref of [BATTERY, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') });
    const netlist = compile(bus.state);
    const lead = netlist.branches.find((b) => b.element.kind === 'connection');
    expect(netlist.nodes[lead?.a ?? -1].members).toContainEqual(end(2, 'b'));
    expect(netlist.nodes[lead?.b ?? -1].members).toContainEqual(end(1, 'neg'));
  });

  it('classifies islands by their sources, and reports a mixed island', () => {
    const bus = benchBus(TEST_CATALOG);
    for (const ref of [AC_SOURCE, LAMP, SUPPLY, AC_SOURCE, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'l'), b: end(2, 'a') }); // AC + lamp
    run(bus, 'lead.connect', { ref: LEAD, a: end(3, 'pos'), b: end(4, 'n') }); // DC supply + AC source: mixed
    const netlist = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    expect(netlist.islands.map((i) => i.kind)).toStrictEqual(['ac', 'mixed', 'empty']);
    expect(netlist.diagnostics).toStrictEqual([{ code: 'mixed-island', island: 1 }]);
    expect(netlist.branches.find((b) => b.model === 'test.acSource')).toMatchObject({ kind: 'vsource', source: 'ac' });
  });

  it('a sim topology event (a fuse blowing) drops the fuse’s branch; the engine’s state wins over the world’s', () => {
    const bus = benchBus(TEST_CATALOG);
    run(bus, 'entity.place', { ref: FUSE, positionMm: origin });
    const intact = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS });
    expect(intact.branches.map((b) => b.element)).toStrictEqual([{ kind: 'entity', entity: 1, part: 'link' }]);
    const blown = compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS, sim: () => ({ blown: true }) });
    expect(blown.branches).toStrictEqual([]);
    expect(blown.topologyHash).not.toBe(intact.topologyHash);
    // `sim` returning undefined falls back to the world's bag.
    expect(compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS, sim: () => undefined })).toStrictEqual(
      intact,
    );
  });
});

describe('device netlist models are checked', () => {
  const bus = benchBus();
  run(bus, 'entity.place', { ref: SPST, positionMm: origin });
  const withSwitch = (topology: NetlistModels['devices'][string]['topology']): NetlistModels => ({
    devices: { 'switch.spst': { kind: 'switch.spst', simTopologyKeys: [], topology } },
    connections: BUILTIN_NETLIST_MODELS.connections,
  });

  it.each([
    ['an unknown terminal in a join', () => ({ joins: [['a', 'z']], elements: [] })],
    [
      'an unknown terminal in an element',
      () => ({
        joins: [],
        elements: [{ part: 'x', kind: 'resistor' as const, source: null, a: 'a', b: 'q', values: {} }],
      }),
    ],
    [
      'a bad part name',
      () => ({
        joins: [],
        elements: [{ part: 'Bad part', kind: 'resistor' as const, source: null, a: 'a', b: 'b', values: {} }],
      }),
    ],
    [
      'a repeated part',
      () => ({
        joins: [],
        elements: ['p', 'p'].map((part) => ({
          part,
          kind: 'resistor' as const,
          source: null,
          a: 'a',
          b: 'b',
          values: {},
        })),
      }),
    ],
  ])('a model with %s throws (a programming error, never a world error)', (_name, topology) => {
    expect(() => compileNetlist(bus.state, BUILTIN_CATALOG, { models: withSwitch(topology) })).toThrow(/Netlist model/);
  });

  it('sorts elements by part and values by key', () => {
    const netlist = compileNetlist(bus.state, BUILTIN_CATALOG, {
      models: withSwitch(() => ({
        joins: [],
        elements: ['zeta', 'alpha'].map((part) => ({
          part,
          kind: 'resistor' as const,
          source: null,
          a: 'a',
          b: 'b',
          values: { z: 1, a: 2 },
        })),
      })),
    });
    expect(netlist.branches.map((b) => (b.element.kind === 'entity' ? b.element.part : ''))).toStrictEqual([
      'alpha',
      'zeta',
    ]);
    expect(Object.keys(netlist.branches[0].values)).toStrictEqual(['a', 'z']);
  });
});

describe('NetlistCompiler (incremental)', () => {
  it('returns the very same netlist when nothing it holds changed, and counts how it answered', () => {
    const compiler = new NetlistCompiler(BUILTIN_CATALOG);
    const bus = benchBus();
    for (const ref of [BATTERY, SPST, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    const first = compiler.compile(bus.state);
    run(bus, 'entity.move', { id: 2, positionMm: { x: 1, y: 2, z: 3 } });
    expect(compiler.compile(bus.state)).toBe(first);
    run(bus, 'device.operate', { id: 2, control: 'closed', value: false }); // the same value, a new bag
    expect(compiler.compile(bus.state)).toBe(first);
    run(bus, 'device.operate', { id: 2, control: 'closed', value: true });
    const closed = compiler.compile(bus.state);
    expect(closed).not.toBe(first);
    expect(closed).toStrictEqual(compile(bus.state));
    expect(compiler.stats).toStrictEqual({ structural: 2, valuesOnly: 0, unchanged: 2 });
  });

  it('a value-only change rebuilds only the branch values: same nodes, islands and hash', () => {
    const compiler = new NetlistCompiler(TEST_CATALOG, { models: TEST_MODELS });
    const bus = benchBus(TEST_CATALOG);
    for (const ref of [SUPPLY, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
    run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
    const before = compiler.compile(bus.state);
    run(bus, 'device.operate', { id: 1, control: 'setpointV', value: 5 });
    const after = compiler.compile(bus.state);
    expect(after.topologyHash).toBe(before.topologyHash);
    expect(after.nodes).toBe(before.nodes);
    expect(after.islands).toBe(before.islands);
    expect(after.branches[0].values).toStrictEqual({ setpointV: 5 });
    expect(after.branches[1]).toBe(before.branches[1]);
    expect(after).toStrictEqual(compileNetlist(bus.state, TEST_CATALOG, { models: TEST_MODELS }));
    expect(compiler.stats).toStrictEqual({ structural: 1, valuesOnly: 1, unchanged: 0 });
  });
});
