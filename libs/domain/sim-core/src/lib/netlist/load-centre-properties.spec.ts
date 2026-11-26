import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import {
  GROUND_BAR_X,
  LOAD_CENTRE_REFS as LC,
  LOAD_CENTRE_SPACES,
  MAIN_X,
  MBJ_X,
  spaceMount,
  spacePositionMm,
} from '@controls/world-model/testing';
import fc from 'fast-check';
import { benchBus, LEAD } from '../../testing/bench';
import { ENGINE_TEST_CATALOG, ENGINE_TEST_MODELS, RESISTOR_12, SERVICE } from '../../testing/engine';
import { compileNetlist, NetlistCompiler } from './compile';
import { computeTopologyHash } from './hash';
import type { Netlist } from './types';
import { wiringGraph } from './wiring-graph';

/*
 * Properties of the load centre's netlist models (P4 PR 14a) over random panels built and edited with
 * the real world commands on world-model's TEST-ONLY entries: a main breaker or main lugs on `mainFeed`,
 * one- and two-pole breakers on random spaces (slid between them), the jumper and the ground bar kit,
 * resistors and the service, leads between any two terminals (bars included), handles, deletes, undo
 * and redo.
 *
 * - incremental recompiles equal from-scratch ones; permuting entities and connections changes nothing;
 *   `topologyHash` is the hash of the netlist's own structure;
 * - `wiringGraph` agrees with the compiler (every pair in one node is joined, and both ends of every
 *   connection and contact), and the can and the neutral bar are joined only through a mounted jumper
 *   or a conductor: with neither they never are.
 */

type Op =
  | { kind: 'breaker'; poles: 1 | 2; space: number }
  | { kind: 'feed'; lugs: boolean }
  | { kind: 'bond'; which: 0 | 1 }
  | { kind: 'free'; which: 0 | 1; slot: number }
  | { kind: 'slide'; pick: number; space: number }
  | { kind: 'connect'; a: number; b: number }
  | { kind: 'handle'; pick: number; value: boolean }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const pick = fc.nat({ max: 255 });
const space = fc.integer({ min: 1, max: LOAD_CENTRE_SPACES });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('breaker' as const),
      poles: fc.constantFrom(1 as const, 2 as const),
      space,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('feed' as const), lugs: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('bond' as const), which: fc.constantFrom(0 as const, 1 as const) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('free' as const),
      which: fc.constantFrom(0 as const, 1 as const),
      slot: fc.nat({ max: 30 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('slide' as const), pick, space }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('connect' as const), a: pick, b: pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('handle' as const), pick, value: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const runArb = fc.array(fc.tuple(opArb, fc.boolean()), { minLength: 4, maxLength: 40 });
const permutationArb = fc.array(fc.integer(), { minLength: 64, maxLength: 64 });

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const models = ENGINE_TEST_MODELS;
const compile = (world: World): Netlist => compileNetlist(world, ENGINE_TEST_CATALOG, { models });
const BREAKERS = [LC.branch20, LC.branch2p30];
const HANDLED = [LC.branch20, LC.branch2p30, LC.main];

function terminals(world: World): { entity: number; terminal: string }[] {
  return world.entities.flatMap((e) =>
    (ENGINE_TEST_CATALOG.terminalIds(e.ref) ?? []).map((terminal) => ({ entity: e.id, terminal })),
  );
}
const of = (world: World, refs: readonly { id: string }[]) =>
  world.entities.filter((e) => refs.some((r) => r.id === e.ref.id));

function apply(bus: CommandBus<World>, op: Op): void {
  const world = bus.state;
  const exec = (id: string, args: object) => bus.exec(id, args);
  switch (op.kind) {
    case 'breaker':
      exec('entity.place', {
        ref: BREAKERS[op.poles - 1],
        positionMm: spacePositionMm(op.space),
        mountedOn: { entity: 1, mount: spaceMount(op.space) },
      });
      return;
    case 'feed':
      exec('entity.place', {
        ref: op.lugs ? LC.mainLugs : LC.main,
        positionMm: at(MAIN_X),
        mountedOn: { entity: 1, mount: 'main' },
      });
      return;
    case 'bond':
      exec('entity.place', {
        ref: op.which === 0 ? LC.mbj : LC.groundBar,
        positionMm: at(op.which === 0 ? MBJ_X : GROUND_BAR_X),
        mountedOn: { entity: 1, mount: op.which === 0 ? 'mbj' : 'groundBar' },
      });
      return;
    case 'free':
      exec('entity.place', { ref: op.which === 0 ? RESISTOR_12 : SERVICE, positionMm: at(op.slot * 100, 0, 3000) });
      return;
    case 'slide': {
      const breakers = of(world, BREAKERS);
      if (breakers.length > 0) {
        exec('entity.move', { id: breakers[op.pick % breakers.length].id, positionMm: spacePositionMm(op.space) });
      }
      return;
    }
    case 'connect': {
      const list = terminals(world);
      if (list.length >= 2)
        exec('lead.connect', { ref: LEAD, a: list[op.a % list.length], b: list[op.b % list.length] });
      return;
    }
    case 'handle': {
      const handled = of(world, HANDLED);
      if (handled.length > 0) {
        exec('device.operate', { id: handled[op.pick % handled.length].id, control: 'on', value: op.value });
      }
      return;
    }
    case 'delete':
      // Never the load centre itself (entity 1): a run keeps its panel.
      if (world.entities.length > 1) {
        const others = world.entities.filter((e) => e.id !== 1);
        exec('entity.delete', { id: others[op.pick % others.length].id });
      }
      return;
    case 'undo':
      exec('edit.undo', {});
      return;
    case 'redo':
      exec('edit.redo', {});
      return;
  }
}

function start(): CommandBus<World> {
  const bus = benchBus(ENGINE_TEST_CATALOG);
  bus.exec('entity.place', { ref: LC.loadCentre, positionMm: at(0) });
  return bus;
}

function permuted(world: World, keys: readonly number[]): World {
  const order = <T>(items: readonly T[]) =>
    items
      .map((item, i) => [keys[i % keys.length] + i / 1000, item] as const)
      .sort((x, y) => x[0] - y[0])
      .map(([, item]) => item);
  return { ...world, entities: order(world.entities), connections: order(world.connections) };
}

describe('load-centre netlist properties (P4 PR 14a)', () => {
  it('the incremental compiler equals a from-scratch compile; permutation-invariant; hash of its own structure', () => {
    fc.assert(
      fc.property(runArb, permutationArb, (steps, keys) => {
        const bus = start();
        const compiler = new NetlistCompiler(ENGINE_TEST_CATALOG, { models });
        for (const [op, compileNow] of steps) {
          apply(bus, op);
          if (!compileNow) continue;
          const fresh = compile(bus.state);
          expect(compiler.compile(bus.state)).toStrictEqual(fresh);
          expect(fresh.topologyHash).toBe(computeTopologyHash(fresh.nodes, fresh.branches));
        }
        const final = compile(bus.state);
        expect(final.diagnostics).toStrictEqual([]);
        expect(compiler.compile(bus.state)).toStrictEqual(final);
        expect(compile(permuted(bus.state, keys))).toStrictEqual(final);
      }),
      { numRuns: 60 },
    );
  });

  it('wiringGraph agrees with the compiler; the neutral bar and the can meet only through a jumper or a conductor', () => {
    fc.assert(
      fc.property(runArb, (steps) => {
        const bus = start();
        for (const [op] of steps) apply(bus, op);
        const netlist = compile(bus.state);
        const graph = wiringGraph(bus.state, ENGINE_TEST_CATALOG, { models });
        for (const node of netlist.nodes) {
          for (const member of node.members) expect(graph.joined(node.members[0], member)).toBe(true);
        }
        const end = (node: number) => netlist.nodes[node].members[0];
        for (const branch of netlist.branches) {
          const element = branch.element;
          if (element.kind === 'contact' && element.relation === 'earth') continue;
          if (element.kind !== 'entity') expect(graph.joined(end(branch.a), end(branch.b))).toBe(true);
        }
        const jumper = of(bus.state, [LC.mbj]).length > 0;
        // With every conductor removed, the neutral bar and the can are joined exactly when a jumper is mounted.
        const bare = wiringGraph({ ...bus.state, connections: [] }, ENGINE_TEST_CATALOG, { models });
        expect(bare.joined({ entity: 1, terminal: 'neutral' }, { entity: 1, terminal: 'chassis' })).toBe(jumper);
        if (!jumper && bus.state.connections.length === 0) {
          expect(graph.joined({ entity: 1, terminal: 'neutral' }, { entity: 1, terminal: 'chassis' })).toBe(false);
        }
        if (jumper) expect(graph.joined({ entity: 1, terminal: 'n20' }, { entity: 1, terminal: 'chassis' })).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('generator health: runs feed the bus, bond, mount breakers and land leads on the bars (fixed seed)', () => {
    let fed = 0;
    let bonded = 0;
    let breakers = 0;
    let onBars = 0;
    for (const steps of fc.sample(runArb, { seed: 20261118, numRuns: 60 })) {
      const bus = start();
      for (const [op] of steps) apply(bus, op);
      const world = bus.state;
      if (world.entities.some((e) => e.mountedOn?.mount === 'main')) fed++;
      if (of(world, [LC.mbj]).length > 0) bonded++;
      if (of(world, BREAKERS).length > 1) breakers++;
      if (world.connections.some((c) => [c.a, c.b].some((e) => e?.entity === 1))) onBars++;
    }
    expect(fed).toBeGreaterThan(10);
    expect(bonded).toBeGreaterThan(10);
    expect(breakers).toBeGreaterThan(20);
    expect(onBars).toBeGreaterThan(10);
  });
});
