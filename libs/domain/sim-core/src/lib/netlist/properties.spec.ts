import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { World } from '@controls/save-format';
import { rawWorldV2Arb } from '@controls/save-format/testing';
import fc from 'fast-check';
import {
  AC_SOURCE,
  BATTERY,
  benchBus,
  CRATE,
  FUSE,
  LAMP,
  LEAD,
  LEAD_2M,
  origin,
  SPST,
  SUPPLY,
  TEST_CATALOG,
  TEST_MODELS,
  UNKNOWN,
} from '../../testing/bench';
import { compileNetlist, NetlistCompiler } from './compile';
import { formatNetlist } from './format';
import { computeTopologyHash } from './hash';
import type { Netlist, StateBag } from './types';

/*
 * Plan F2.1 properties over random bench circuits built and edited with the real world commands
 * (place, connect, disconnect, operate, delete, move, undo, redo) plus sim topology events (a test
 * fuse blowing or being restored in the engine's state):
 *
 * - an incrementally recompiled netlist equals a from-scratch compile after every edit;
 * - permuting the input order of entities and connections gives an identical netlist;
 * - the ADR 0011 §7 guarantees and the canonical numbering hold for every reachable world;
 * - `topologyHash` ignores values and changes when a switch toggles.
 *
 * Every arbitrary is built once, here at module level (never inside `.chain`): building
 * `fc.stringMatching` in a chain body once made a spec ten times slower.
 */

const REFS = [BATTERY, SPST, LAMP, FUSE, AC_SOURCE, SUPPLY, CRATE, UNKNOWN];
const LEADS = [LEAD, LEAD_2M];

type Op =
  | { kind: 'place'; ref: number }
  | { kind: 'connect'; a: [number, number]; b: [number, number]; lead: number }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'toggle'; pick: number; value: boolean }
  | { kind: 'setpoint'; pick: number; value: number }
  | { kind: 'delete'; pick: number }
  | { kind: 'move'; pick: number; x: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'blow'; pick: number };

const pick = fc.nat({ max: 12 });
const terminalPick: fc.Arbitrary<[number, number]> = fc.tuple(pick, fc.nat({ max: 3 }));
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('place' as const), ref: fc.nat({ max: REFS.length - 1 }) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('connect' as const),
      a: terminalPick,
      b: terminalPick,
      lead: fc.nat({ max: LEADS.length - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('toggle' as const), pick, value: fc.boolean() }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('setpoint' as const), pick, value: fc.integer({ min: 0, max: 30 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('move' as const), pick, x: fc.integer({ min: -9, max: 9 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('blow' as const), pick }) },
);
const opsArb = fc.array(opArb, { minLength: 1, maxLength: 40 });
/** Sort keys for permuting a world's entities and connections (no `fc.shuffledSubarray` in a chain). */
const permutationArb = fc.array(fc.integer(), { minLength: 64, maxLength: 64 });

/** The engine's sim-owned state, as the engine would hand it to the compiler. */
type SimState = Map<number, StateBag>;

function terminalOf(world: World, [entityPick, terminal]: [number, number]): { entity: number; terminal: string } {
  const entity = world.entities[entityPick % Math.max(world.entities.length, 1)];
  if (!entity) return { entity: 1, terminal: 'a' };
  const terminals = TEST_CATALOG.device(entity.ref)?.terminals ?? [];
  return { entity: entity.id, terminal: terminals.length > 0 ? terminals[terminal % terminals.length].id : 'a' };
}

function entityOfKind(world: World, kind: string, index: number): number {
  const matches = world.entities.filter((e) => TEST_CATALOG.kindOf(e.ref)?.kind === kind);
  return matches.length > 0 ? matches[index % matches.length].id : 999;
}

/** Applies one op. Refused commands are fine: they change nothing, as in play. */
function apply(bus: CommandBus<World>, sim: SimState, op: Op): void {
  const world = bus.state;
  switch (op.kind) {
    case 'place':
      bus.exec('entity.place', { ref: REFS[op.ref], positionMm: origin });
      return;
    case 'connect':
      bus.exec('lead.connect', { ref: LEADS[op.lead], a: terminalOf(world, op.a), b: terminalOf(world, op.b) });
      return;
    case 'disconnect': {
      const connection = world.connections[op.pick % Math.max(world.connections.length, 1)];
      bus.exec('lead.disconnect', { id: connection?.id ?? 1 });
      return;
    }
    case 'toggle':
      bus.exec('device.operate', {
        id: entityOfKind(world, 'switch.spst', op.pick),
        control: 'closed',
        value: op.value,
      });
      return;
    case 'setpoint':
      bus.exec('device.operate', {
        id: entityOfKind(world, 'test.supply', op.pick),
        control: 'setpointV',
        value: op.value,
      });
      return;
    case 'delete':
      bus.exec('entity.delete', { id: world.entities[op.pick % Math.max(world.entities.length, 1)]?.id ?? 1 });
      return;
    case 'move':
      bus.exec('entity.move', {
        id: world.entities[op.pick % Math.max(world.entities.length, 1)]?.id ?? 1,
        positionMm: { x: op.x, y: 0, z: 0 },
      });
      return;
    case 'undo':
      bus.exec('edit.undo');
      return;
    case 'redo':
      bus.exec('edit.redo');
      return;
    case 'blow': {
      // A sim topology event: the engine blows (or, for the test, restores) a fuse. Not a command.
      const id = entityOfKind(world, 'test.fuse', op.pick);
      sim.set(id, { blown: !(sim.get(id)?.['blown'] === true) });
      return;
    }
  }
}

const fromScratch = (world: World, sim: SimState): Netlist =>
  compileNetlist(world, TEST_CATALOG, { models: TEST_MODELS, sim: (id) => sim.get(id) });

/** Runs `ops` on a fresh test bench and returns the world and the engine's sim state. */
function build(ops: readonly Op[]): { world: World; sim: SimState } {
  const bus = benchBus(TEST_CATALOG);
  const sim: SimState = new Map();
  for (const op of ops) apply(bus, sim, op);
  return { world: bus.state, sim };
}

const memberKey = (m: { entity: number; terminal: string }) => [m.entity, m.terminal] as const;
const before = (x: readonly [number, string], y: readonly [number, string]) =>
  x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);

/** The ADR 0011 §7 netlist guarantees and the canonical numbering (plan F2.1). */
function checkInvariants(world: World, netlist: Netlist, catalog: Catalog = TEST_CATALOG): void {
  // Every catalogue terminal of every netlisted entity is in exactly one node; every node has a member.
  const seen = new Map<string, number>();
  netlist.nodes.forEach((node, index) => {
    expect(node.index).toBe(index);
    expect(node.members.length).toBeGreaterThan(0);
    node.members.forEach((m, i) => {
      expect(seen.has(`${m.entity}:${m.terminal}`)).toBe(false);
      seen.set(`${m.entity}:${m.terminal}`, index);
      if (i > 0) expect(before(memberKey(node.members[i - 1]), memberKey(m))).toBe(true);
    });
    // Numbered by the smallest member, in canonical order.
    if (index > 0)
      expect(before(memberKey(netlist.nodes[index - 1].members[0]), memberKey(node.members[0]))).toBe(true);
  });
  for (const device of netlist.devices) {
    const entity = world.entities.find((e) => e.id === device.entity);
    for (const terminal of catalog.device(entity?.ref ?? UNKNOWN)?.terminals ?? []) {
      expect(seen.has(`${device.entity}:${terminal.id}`)).toBe(true);
    }
  }
  expect(seen.size).toBe(
    netlist.devices.reduce(
      (n, d) =>
        n + (catalog.kindOf(world.entities.find((e) => e.id === d.entity)?.ref ?? UNKNOWN)?.terminals.length ?? 0),
      0,
    ),
  );

  // Each netlisted connection is exactly one branch from its a's node to its b's node; the rest are diagnosed.
  const absent = new Set(netlist.diagnostics.flatMap((d) => (d.code === 'absent-connection' ? [d.connection] : [])));
  for (const connection of world.connections) {
    const branches = netlist.branches.filter(
      (b) => b.element.kind === 'connection' && b.element.connection === connection.id,
    );
    if (absent.has(connection.id)) {
      expect(branches).toStrictEqual([]);
    } else {
      expect(branches).toHaveLength(1);
      expect(branches[0].a).toBe(seen.get(`${connection.a.entity}:${connection.a.terminal}`));
      expect(branches[0].b).toBe(seen.get(`${connection.b.entity}:${connection.b.terminal}`));
    }
  }

  // Branches and islands are consistent and canonically numbered.
  netlist.branches.forEach((branch, index) => {
    expect(branch.index).toBe(index);
    expect(netlist.nodes[branch.a].island).toBe(branch.island);
    expect(netlist.nodes[branch.b].island).toBe(branch.island);
  });
  const islandNodes = netlist.islands.flatMap((island, index) => {
    expect(island.index).toBe(index);
    if (index > 0) expect(netlist.islands[index - 1].nodes[0]).toBeLessThan(island.nodes[0]);
    for (const node of island.nodes) expect(netlist.nodes[node].island).toBe(index);
    for (const branch of island.branches) expect(netlist.branches[branch].island).toBe(index);
    const sources = new Set(island.branches.map((b) => netlist.branches[b].source).filter((s) => s !== null));
    expect(island.kind).toBe(sources.size === 2 ? 'mixed' : sources.size === 1 ? [...sources][0] : 'empty');
    return island.nodes;
  });
  expect(islandNodes.sort((x, y) => x - y)).toStrictEqual(netlist.nodes.map((n) => n.index));
  expect(netlist.topologyHash).toBe(computeTopologyHash(netlist.nodes, netlist.branches));
}

describe('netlist properties (plan F2.1)', () => {
  it('incremental recompile equals a from-scratch compile after every edit and sim topology event', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const bus = benchBus(TEST_CATALOG);
        const sim: SimState = new Map();
        const compiler = new NetlistCompiler(TEST_CATALOG, { models: TEST_MODELS });
        for (const op of ops) {
          apply(bus, sim, op);
          expect(compiler.compile(bus.state, { sim: (id) => sim.get(id) })).toStrictEqual(fromScratch(bus.state, sim));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('every reachable world compiles to a netlist that keeps the ADR 0011 §7 guarantees', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const { world, sim } = build(ops);
        checkInvariants(world, fromScratch(world, sim));
      }),
      { numRuns: 150 },
    );
  });

  it('permuting the order of entities and connections gives an identical netlist', () => {
    fc.assert(
      fc.property(opsArb, permutationArb, (ops, keys) => {
        const { world, sim } = build(ops);
        const permute = <T>(items: readonly T[]) =>
          items
            .map((item, i) => ({ item, key: keys[i % keys.length] + i / 1000 }))
            .sort((x, y) => x.key - y.key)
            .map(({ item }) => item);
        const shuffled = { ...world, entities: permute(world.entities), connections: permute(world.connections) };
        const netlist = fromScratch(shuffled, sim);
        expect(netlist).toStrictEqual(fromScratch(world, sim));
        expect(formatNetlist(netlist)).toBe(formatNetlist(fromScratch(world, sim)));
      }),
      { numRuns: 100 },
    );
  });

  it('topologyHash ignores values: other lead types and setpoints keep the hash', () => {
    fc.assert(
      fc.property(opsArb, fc.integer({ min: 0, max: 30 }), (ops, setpoint) => {
        const { world, sim } = build(ops);
        const revalued: World = {
          ...world,
          connections: world.connections.map((c) => ({ ...c, ref: c.ref.id === LEAD.id ? LEAD_2M : LEAD })),
          entities: world.entities.map((e) =>
            TEST_CATALOG.kindOf(e.ref)?.kind === 'test.supply' ? { ...e, state: { setpointV: setpoint } } : e,
          ),
        };
        const original = fromScratch(world, sim);
        const changed = fromScratch(revalued, sim);
        expect(changed.topologyHash).toBe(original.topologyHash);
        expect(changed.nodes).toStrictEqual(original.nodes);
      }),
      { numRuns: 100 },
    );
  });

  it('toggling a switch always changes topologyHash', () => {
    fc.assert(
      fc.property(opsArb, pick, (ops, which) => {
        const { world, sim } = build([...ops, { kind: 'place', ref: REFS.indexOf(SPST) }]);
        const id = entityOfKind(world, 'switch.spst', which);
        const toggled: World = {
          ...world,
          entities: world.entities.map((e) =>
            e.id === id ? { ...e, state: { closed: e.state['closed'] !== true } } : e,
          ),
        };
        expect(fromScratch(toggled, sim).topologyHash).not.toBe(fromScratch(world, sim).topologyHash);
      }),
      { numRuns: 100 },
    );
  });

  it('any valid world document compiles without throwing (unknown refs and props are absent)', () => {
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const world = World.parse(raw);
        const netlist = compileNetlist(world, BUILTIN_CATALOG);
        checkInvariants(world, netlist, BUILTIN_CATALOG);
      }),
      { numRuns: 100 },
    );
  });
});
