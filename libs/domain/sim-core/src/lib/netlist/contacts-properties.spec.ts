import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import fc from 'fast-check';
import { LEAD, SPST } from '../../testing/bench';
import {
  APPLIANCE_12R,
  BREAKER_1P,
  BREAKER_2P,
  GROUND_BAR,
  LAMP_PLUG,
  MBJ,
  PANEL,
  RECEPTACLE,
  RESIDENTIAL_TEST_CATALOG,
  RESIDENTIAL_TEST_MODELS,
  residentialBus,
  ROD,
  SERVICE,
} from '../../testing/residential';
import { compileNetlist, NetlistCompiler } from './compile';
import { computeTopologyHash } from './hash';
import type { Netlist } from './types';
import { wiringGraph } from './wiring-graph';

/*
 * Engine 8 part 1 properties over random residential worlds built and edited with the real world
 * commands (place, mount on a bus stab or a bond mount, slide a breaker, plug and unplug, connect
 * leads, operate a switch, delete, undo, redo), on the TEST-ONLY residential catalogue:
 *
 * - an incrementally recompiled netlist (relation contacts and the earth node included) equals a
 *   from-scratch compile, compiling only on some steps;
 * - permuting the world's entities and connections gives an identical netlist;
 * - `topologyHash` is the hash of the netlist's own nodes and branches;
 * - `wiringGraph` agrees with the compiler: every two terminals in one electrical node are joined in
 *   the wiring graph, and so are both ends of every connection, mount and plug contact; never through
 *   soil (an earth contact joins nothing: two unconnected rods are not joined) and never through a load;
 *
 * The generator-health test pins floors on how often runs mount, plug and reach earth.
 */

const STABS = 4;
const FREE_REFS = [RECEPTACLE, APPLIANCE_12R, LAMP_PLUG, ROD, SERVICE, SPST];
const LEAD_REFS = [LEAD];

type Op =
  | { kind: 'free'; ref: number; slot: number }
  | { kind: 'breaker'; poles: 1 | 2; stab: number }
  | { kind: 'bond'; which: 0 | 1 }
  | { kind: 'slide'; pick: number; stab: number }
  | { kind: 'plug'; a: number; r: number }
  | { kind: 'unplug'; pick: number }
  | { kind: 'connect'; a: number; b: number }
  | { kind: 'switch'; pick: number; value: boolean }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const pick = fc.nat({ max: 63 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('free' as const),
      ref: fc.nat({ max: FREE_REFS.length - 1 }),
      slot: fc.nat({ max: 40 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('breaker' as const),
      poles: fc.constantFrom(1 as const, 2 as const),
      stab: fc.nat({ max: STABS - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('bond' as const), which: fc.constantFrom(0 as const, 1 as const) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('slide' as const), pick, stab: fc.nat({ max: STABS - 1 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('plug' as const), a: pick, r: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('unplug' as const), pick }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('connect' as const), a: pick, b: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('switch' as const), pick, value: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const runArb = fc.array(fc.tuple(opArb, fc.boolean()), { minLength: 4, maxLength: 40 });
const permutationArb = fc.array(fc.integer(), { minLength: 64, maxLength: 64 });

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const compile = (world: World): Netlist =>
  compileNetlist(world, RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });

/** Every terminal of every catalogued entity, in world order. */
function terminals(world: World): { entity: number; terminal: string }[] {
  return world.entities.flatMap((e) =>
    (RESIDENTIAL_TEST_CATALOG.device(e.ref)?.terminals ?? []).map((t) => ({ entity: e.id, terminal: t.id })),
  );
}

const of = (world: World, ids: readonly { id: string }[]) =>
  world.entities.filter((e) => ids.some((r) => r.id === e.ref.id));

/** Applies one op (refused ones are fine: they leave the world as it was). */
function apply(bus: CommandBus<World>, op: Op): void {
  const world = bus.state;
  const exec = (id: string, args: object) => bus.exec(id, args);
  switch (op.kind) {
    case 'free':
      exec('entity.place', { ref: FREE_REFS[op.ref], positionMm: at(op.slot * 100, 0, 1000) });
      return;
    case 'breaker':
      exec('entity.place', {
        ref: op.poles === 1 ? BREAKER_1P : BREAKER_2P,
        positionMm: at(25 * op.stab),
        mountedOn: { entity: 1, mount: 'bus' },
      });
      return;
    case 'bond':
      exec('entity.place', {
        ref: op.which === 0 ? MBJ : GROUND_BAR,
        positionMm: at(op.which === 0 ? 200 : 250),
        mountedOn: { entity: 1, mount: op.which === 0 ? 'mbj' : 'gbar' },
      });
      return;
    case 'slide': {
      const breakers = of(world, [BREAKER_1P, BREAKER_2P]);
      if (breakers.length === 0) return;
      exec('entity.move', { id: breakers[op.pick % breakers.length].id, positionMm: at(25 * op.stab) });
      return;
    }
    case 'plug': {
      const appliances = of(world, [APPLIANCE_12R, LAMP_PLUG]);
      const receptacles = of(world, [RECEPTACLE]);
      if (appliances.length === 0 || receptacles.length === 0) return;
      exec('plug.insert', {
        appliance: appliances[op.a % appliances.length].id,
        receptacle: receptacles[op.r % receptacles.length].id,
        outlet: 'face',
      });

      return;
    }
    case 'unplug': {
      const plugged = world.entities.filter((e) => e.pluggedInto !== null);
      if (plugged.length > 0) exec('plug.remove', { appliance: plugged[op.pick % plugged.length].id });
      return;
    }
    case 'connect': {
      const list = terminals(world);
      if (list.length < 2) return;
      exec('lead.connect', { ref: LEAD_REFS[0], a: list[op.a % list.length], b: list[op.b % list.length] });
      return;
    }
    case 'switch': {
      const switches = of(world, [SPST]);
      if (switches.length > 0) {
        exec('device.operate', { id: switches[op.pick % switches.length].id, control: 'closed', value: op.value });
      }
      return;
    }
    case 'delete':
      if (world.entities.length > 1) exec('entity.delete', { id: world.entities[op.pick % world.entities.length].id });
      return;
    case 'undo':
      exec('edit.undo', {});
      return;
    case 'redo':
      exec('edit.redo', {});
      return;
  }
}

/** A run from a fresh world holding the panel (entity 1), a receptacle and an appliance (at slots 41 and 42). */
function start(): CommandBus<World> {
  const bus = residentialBus();
  bus.exec('entity.place', { ref: PANEL, positionMm: at(0) });
  bus.exec('entity.place', { ref: RECEPTACLE, positionMm: at(4100, 0, 1000) });
  bus.exec('entity.place', { ref: APPLIANCE_12R, positionMm: at(4200, 0, 1000) });
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

describe('residential netlist properties (engine 8 part 1)', () => {
  it('the incremental compiler equals a from-scratch compile; permutation-invariant; hash of its own structure', () => {
    fc.assert(
      fc.property(runArb, permutationArb, (steps, keys) => {
        const bus = start();
        const compiler = new NetlistCompiler(RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });
        for (const [op, compileNow] of steps) {
          apply(bus, op);
          if (!compileNow) continue;
          const fresh = compile(bus.state);
          expect(compiler.compile(bus.state)).toStrictEqual(fresh);
          expect(fresh.topologyHash).toBe(computeTopologyHash(fresh.nodes, fresh.branches));
        }
        const final = compile(bus.state);
        expect(compiler.compile(bus.state)).toStrictEqual(final);
        expect(compile(permuted(bus.state, keys))).toStrictEqual(final);
      }),
      { numRuns: 80 },
    );
  });

  it('wiringGraph joins every pair the compiler puts in one node and both ends of every conductor and contact, never through soil', () => {
    fc.assert(
      fc.property(runArb, (steps) => {
        const bus = start();
        for (const [op] of steps) apply(bus, op);
        const netlist = compile(bus.state);
        const graph = wiringGraph(bus.state, RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });
        for (const node of netlist.nodes) {
          for (const member of node.members) expect(graph.joined(node.members[0], member)).toBe(true);
        }
        const end = (node: number) => netlist.nodes[node].members[0];
        for (const branch of netlist.branches) {
          const element = branch.element;
          if (element.kind === 'contact' && element.relation === 'earth') {
            // An earth link joins nothing, but its device end is earthed.
            expect(graph.earthed(end(branch.a))).toBe(true);
            continue;
          }
          const path =
            element.kind !== 'entity' ||
            branch.model === 'test.plugOn1p' ||
            branch.model === 'test.plugOn2p' ||
            (branch.model === 'service.splitPhase' && element.part === 'dropN');
          if (path) expect(graph.joined(end(branch.a), end(branch.b))).toBe(true);
        }
        // Never through soil: a rod with nothing landed on it is joined to nothing but itself.
        const wired = (id: number) => bus.state.connections.some((c) => [c.a, c.b].some((e) => e?.entity === id));
        const rods = of(bus.state, [ROD]);
        for (const rod of rods) {
          const clamp = { entity: rod.id, terminal: 'clamp' };
          expect(graph.earthed(clamp)).toBe(true);
          if (wired(rod.id)) continue;
          for (const other of netlist.nodes.flatMap((n) => n.members)) {
            if (other.entity !== rod.id) expect(graph.joined(clamp, other)).toBe(false);
          }
        }
        // Never through a load: an appliance's element alone joins nothing.
        for (const appliance of of(bus.state, [APPLIANCE_12R, LAMP_PLUG])) {
          const hot = { entity: appliance.id, terminal: 'pHot' };
          const neutral = { entity: appliance.id, terminal: 'pNeutral' };
          const alone =
            appliance.pluggedInto === null &&
            !bus.state.connections.some((c) => [c.a, c.b].some((end) => end?.entity === appliance.id));
          if (alone) expect(graph.joined(hot, neutral)).toBe(false);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('the open-toggle path (reassemble) equals a full compile with contacts and earth, hash and diagnostics included', () => {
    const masks = fc.array(fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }), { minLength: 2, maxLength: 8 });
    let toggled = 0;
    fc.assert(
      fc.property(runArb, masks, (steps, opens) => {
        const bus = start();
        for (const [op] of steps) apply(bus, op);
        const world = bus.state;
        const compiler = new NetlistCompiler(RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS });
        compiler.compile(world);
        const ids = [...world.connections].map((c) => c.id).sort((x, y) => x - y);
        for (const mask of opens) {
          const open = new Set(ids.filter((_, i) => mask[i % mask.length]));
          const options = {
            connectionSim: (id: number) => (open.has(id) ? { endAState: 'intermittentOpen' } : undefined),
          };
          const before = compiler.stats.structural;
          const got = compiler.compile(world, options);
          if (compiler.stats.structural > before) toggled++;
          const want = compileNetlist(world, RESIDENTIAL_TEST_CATALOG, { models: RESIDENTIAL_TEST_MODELS, ...options });
          expect(got).toStrictEqual(want);
          expect(got.topologyHash).toBe(computeTopologyHash(got.nodes, got.branches));
        }
      }),
      { numRuns: 60 },
    );
    // Not vacuous: the toggle path re-assembled many times.
    expect(toggled).toBeGreaterThan(30);
  });

  it('generator health: runs mount, slide, plug and reach earth often enough (fixed seed)', () => {
    let mounted = 0;
    let plugged = 0;
    let earthed = 0;
    let absent = 0;
    for (const steps of fc.sample(runArb, { seed: 20261118, numRuns: 60 })) {
      const bus = start();
      for (const [op] of steps) apply(bus, op);
      const netlist = compile(bus.state);
      const contacts = netlist.branches.filter((b) => b.element.kind === 'contact');
      if (contacts.some((b) => b.element.kind === 'contact' && b.element.relation === 'mount')) mounted++;
      if (contacts.some((b) => b.element.kind === 'contact' && b.element.relation === 'plug')) plugged++;
      if (netlist.nodes[0]?.members[0]?.entity === 0) earthed++;
      if (netlist.diagnostics.some((d) => d.code === 'absent-contact')) absent++;
    }
    expect(mounted).toBeGreaterThan(20);
    expect(plugged).toBeGreaterThan(5);
    expect(earthed).toBeGreaterThan(10);
    // No contact here is ever absent: every test kind is netlisted (absence has its own example spec).
    expect(absent).toBe(0);
  });
});
