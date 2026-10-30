import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { World } from '@controls/save-format';
import { deepFreeze, rawWorldV2Arb } from '@controls/save-format/testing';
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
 * - an incrementally recompiled netlist equals a from-scratch compile, compiling only on some steps,
 *   so a compiler that is handed several edits at once (an undo then a reconnect that reuses an id)
 *   is checked too;
 * - permuting the input order of entities and connections gives an identical netlist;
 * - the ADR 0011 §7 guarantees and the canonical numbering hold for every reachable world;
 * - `topologyHash` is equal exactly when the structure is, and ignores values.
 *
 * Every run starts from a bench seeded with 3–8 netlistable devices, connects real terminals and
 * blows only fuses that exist, and the generator-health test pins floors on how often the runs
 * produce leads, blows, value changes and AC and mixed islands, so the properties can't go vacuous.
 * Every arbitrary is built once, here at module level (never inside `.chain`): building
 * `fc.stringMatching` in a chain body once made a spec ten times slower.
 */

/** Devices the seed placements use: every one is netlisted. */
const DEVICES = [BATTERY, SPST, LAMP, FUSE, AC_SOURCE, SUPPLY];
/** Later placements may also add a prop or an unknown device (both absent from the netlist). */
const REFS = [...DEVICES, CRATE, UNKNOWN];
const LEADS = [LEAD, LEAD_2M];

type Op =
  | { kind: 'place'; ref: number }
  | { kind: 'connect'; a: number; offset: number; lead: number }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'toggle'; pick: number; value: boolean }
  | { kind: 'setpoint'; pick: number; value: number }
  | { kind: 'delete'; pick: number }
  | { kind: 'move'; pick: number; x: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'blow'; pick: number };

const pick = fc.nat({ max: 63 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('place' as const), ref: fc.nat({ max: REFS.length - 1 }) }) },
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('connect' as const),
      a: pick,
      offset: pick,
      lead: fc.nat({ max: LEADS.length - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('toggle' as const), pick, value: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('setpoint' as const), pick, value: fc.integer({ min: 0, max: 30 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('move' as const), pick, x: fc.integer({ min: -9, max: 9 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('blow' as const), pick }) },
);

/** A run: the seed bench, then edits, each flagged with whether to compile after it. */
interface Run {
  readonly seed: readonly number[];
  readonly withFuse: boolean;
  readonly steps: readonly (readonly [Op, boolean])[];
}
const runArb: fc.Arbitrary<Run> = fc.record({
  seed: fc.array(fc.nat({ max: DEVICES.length - 1 }), { minLength: 3, maxLength: 8 }),
  withFuse: fc.boolean(),
  steps: fc.array(fc.tuple(opArb, fc.boolean()), { minLength: 1, maxLength: 40, size: 'max' }),
});
/** Two runs, how to derive the second world, one more op and a setpoint (the hash-equivalence property). */
const pairArb = fc.tuple(runArb, runArb, fc.nat({ max: 2 }), opArb, fc.integer({ min: 0, max: 30 }));
/** Sort keys for permuting a world's entities and connections (no `fc.shuffledSubarray` in a chain). */
const permutationArb = fc.array(fc.integer(), { minLength: 64, maxLength: 64 });

/** The engine's sim-owned state, as the engine would hand it to the compiler. */
type SimState = Map<number, StateBag>;

/** What a run did, for the generator-health test. */
interface Tally {
  connects: number;
  acceptedConnects: number;
  effectiveBlows: number;
  valueChanges: number;
}

/** Every terminal of every entity whose device the catalogue knows, in world order. */
function terminals(world: World): { entity: number; terminal: string }[] {
  return world.entities.flatMap((e) =>
    (TEST_CATALOG.device(e.ref)?.terminals ?? []).map((t) => ({ entity: e.id, terminal: t.id })),
  );
}

function entitiesOfKind(world: World, kind: string): World['entities'] {
  return world.entities.filter((e) => TEST_CATALOG.kindOf(e.ref)?.kind === kind);
}

const nth = <T>(items: readonly T[], index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

/** Applies one op. Refused commands are fine (they change nothing, as in play), but rare by design. */
function apply(bus: CommandBus<World>, sim: SimState, op: Op, tally: Tally): void {
  const world = bus.state;
  switch (op.kind) {
    case 'place':
      bus.exec('entity.place', { ref: REFS[op.ref], positionMm: origin });
      return;
    case 'connect': {
      // Real terminals of existing devices, and b is never a.
      const all = terminals(world);
      if (all.length < 2) return;
      const ia = op.a % all.length;
      const ib = (ia + 1 + (op.offset % (all.length - 1))) % all.length;
      tally.connects++;
      if (bus.exec('lead.connect', { ref: LEADS[op.lead], a: all[ia], b: all[ib] }).ok) tally.acceptedConnects++;
      return;
    }
    case 'disconnect': {
      const connection = nth(world.connections, op.pick);
      if (connection) bus.exec('lead.disconnect', { id: connection.id });
      return;
    }
    case 'toggle': {
      const target = nth(entitiesOfKind(world, 'switch.spst'), op.pick);
      if (target) bus.exec('device.operate', { id: target.id, control: 'closed', value: op.value });
      return;
    }
    case 'setpoint': {
      const target = nth(entitiesOfKind(world, 'test.supply'), op.pick);
      if (!target) return;
      const changed = target.state['setpointV'] !== op.value;
      if (bus.exec('device.operate', { id: target.id, control: 'setpointV', value: op.value }).ok && changed) {
        tally.valueChanges++;
      }
      return;
    }
    case 'delete': {
      const target = nth(world.entities, op.pick);
      if (target) bus.exec('entity.delete', { id: target.id });
      return;
    }
    case 'move': {
      const target = nth(world.entities, op.pick);
      if (target) bus.exec('entity.move', { id: target.id, positionMm: { x: op.x, y: 0, z: 0 } });
      return;
    }
    case 'undo':
      bus.exec('edit.undo');
      return;
    case 'redo':
      bus.exec('edit.redo');
      return;
    case 'blow': {
      // A sim topology event: the engine blows (or, for the test, restores) a fuse. Not a command.
      const fuse = nth(entitiesOfKind(world, 'test.fuse'), op.pick);
      if (!fuse) return;
      sim.set(fuse.id, deepFreeze({ blown: !(sim.get(fuse.id)?.['blown'] === true) }));
      tally.effectiveBlows++;
      return;
    }
  }
}

const fromScratch = (world: World, sim: SimState): Netlist =>
  compileNetlist(world, TEST_CATALOG, { models: TEST_MODELS, sim: (id) => sim.get(id) });

/** A fresh test bench with the run's seed devices placed. */
function seeded(run: Run): CommandBus<World> {
  const bus = benchBus(TEST_CATALOG);
  const refs = [...run.seed.map((i) => DEVICES[i]), ...(run.withFuse ? [FUSE] : [])];
  for (const ref of refs) bus.exec('entity.place', { ref, positionMm: origin });
  return bus;
}

/** Runs every step and returns the world, the engine's sim state and what happened. */
function build(run: Run): { world: World; sim: SimState; tally: Tally } {
  const bus = seeded(run);
  const sim: SimState = new Map();
  const tally: Tally = { connects: 0, acceptedConnects: 0, effectiveBlows: 0, valueChanges: 0 };
  for (const [op] of run.steps) apply(bus, sim, op, tally);
  return { world: bus.state, sim, tally };
}

/** The structure `topologyHash` covers: the partition and each branch without its values. */
const projection = (netlist: Netlist): string =>
  JSON.stringify([
    netlist.nodes.map((n) => n.members),
    netlist.branches.map(({ element, kind, model, source, a, b }) => [element, kind, model, source, a, b]),
  ]);

/** The world with every lead swapped for the other length and every supply at `setpointV`. */
const revalued = (world: World, setpointV: number): World => ({
  ...world,
  connections: world.connections.map((c) => ({ ...c, ref: c.ref.id === LEAD.id ? LEAD_2M : LEAD })),
  entities: world.entities.map((e) =>
    TEST_CATALOG.kindOf(e.ref)?.kind === 'test.supply' ? { ...e, state: { setpointV } } : e,
  ),
});

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
    expect(Object.isFrozen(branch.values)).toBe(true);
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
  // `mixed-island` diagnostics name exactly the mixed islands.
  expect(netlist.diagnostics.flatMap((d) => (d.code === 'mixed-island' ? [d.island] : []))).toStrictEqual(
    netlist.islands.filter((i) => i.kind === 'mixed').map((i) => i.index),
  );
  expect(netlist.topologyHash).toBe(computeTopologyHash(netlist.nodes, netlist.branches));
}

/**
 * Raw world documents with most entities mapped to built-in devices and most connections to the
 * built-in lead between real terminals (some left bogus or unknown), so the robustness property
 * compiles real circuits, not only absent refs.
 */
const BUILTIN_DEVICES = [BATTERY, SPST, LAMP];
const mappedWorldArb = rawWorldV2Arb.map((raw) => {
  const world = World.parse(raw);
  const entities = world.entities.map((e) => (e.id % 4 === 0 ? e : { ...e, ref: BUILTIN_DEVICES[e.id % 3] }));
  const realTerminal = (end: { entity: number; terminal: string }, salt: number) => {
    const entity = entities.find((e) => e.id === end.entity);
    const device = entity && BUILTIN_CATALOG.device(entity.ref);
    return device && salt % 7 !== 0 ? { ...end, terminal: device.terminals[salt % 2].id } : end;
  };
  const connections = world.connections.map((c) => {
    const mapped = {
      ...c,
      ref: c.id % 5 === 0 ? c.ref : LEAD,
      a: realTerminal(c.a, c.id),
      b: realTerminal(c.b, c.id + 1),
    };
    const same = mapped.a.entity === mapped.b.entity && mapped.a.terminal === mapped.b.terminal;
    return same ? { ...mapped, a: c.a, b: c.b } : mapped;
  });
  return World.parse({ ...world, entities, connections });
});

describe('netlist properties (plan F2.1)', () => {
  it('incremental recompile equals a from-scratch compile, compiling only on flagged steps', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const bus = seeded(run);
        const sim: SimState = new Map();
        const tally: Tally = { connects: 0, acceptedConnects: 0, effectiveBlows: 0, valueChanges: 0 };
        const compiler = new NetlistCompiler(TEST_CATALOG, { models: TEST_MODELS });
        compiler.compile(deepFreeze(bus.state));
        for (const [op, compile] of run.steps) {
          apply(bus, sim, op, tally);
          if (!compile) continue;
          // Frozen inputs: the compiler must never mutate the world or the engine's state.
          const world = deepFreeze(bus.state);
          const incremental = compiler.compile(world, { sim: (id) => sim.get(id) });
          expect(incremental).toStrictEqual(fromScratch(world, sim));
          for (const branch of incremental.branches) expect(Object.isFrozen(branch.values)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('every reachable world compiles to a netlist that keeps the ADR 0011 §7 guarantees', () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { world, sim } = build(run);
        checkInvariants(world, fromScratch(world, sim));
      }),
      { numRuns: 120 },
    );
  });

  it('permuting the order of entities and connections gives an identical netlist', () => {
    fc.assert(
      fc.property(runArb, permutationArb, (run, keys) => {
        const { world, sim } = build(run);
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
      { numRuns: 150 },
    );
  });

  it('topologyHash ignores values: other lead types and setpoints keep the hash', () => {
    fc.assert(
      fc.property(runArb, fc.integer({ min: 0, max: 30 }), (run, setpoint) => {
        const { world, sim } = build(run);
        const original = fromScratch(world, sim);
        const changed = fromScratch(revalued(world, setpoint), sim);
        expect(changed.topologyHash).toBe(original.topologyHash);
        expect(projection(changed)).toBe(projection(original));
      }),
      { numRuns: 150 },
    );
  });

  it('topologyHash is equal exactly when the structural projection is, over pairs of reachable worlds', () => {
    fc.assert(
      fc.property(pairArb, ([run, other, how, op, setpoint]) => {
        const first = build(run);
        // The second world: an unrelated one, the same one revalued, or the same one plus one more edit.
        let second = first;
        if (how === 0) second = build(other);
        else if (how === 1) second = { ...first, world: revalued(first.world, setpoint) };
        else second = build({ ...run, steps: [...run.steps, [op, true]] });
        const x = fromScratch(first.world, first.sim);
        const y = fromScratch(second.world, second.sim);
        expect(x.topologyHash === y.topologyHash).toBe(projection(x) === projection(y));
      }),
      { numRuns: 150 },
    );
  });

  it('toggling a switch always changes topologyHash', () => {
    fc.assert(
      fc.property(runArb, pick, (run, which) => {
        const { world, sim } = build({
          ...run,
          steps: [...run.steps, [{ kind: 'place', ref: REFS.indexOf(SPST) }, true]],
        });
        const target = nth(entitiesOfKind(world, 'switch.spst'), which);
        const toggled: World = {
          ...world,
          entities: world.entities.map((e) =>
            e.id === target?.id ? { ...e, state: { closed: e.state['closed'] !== true } } : e,
          ),
        };
        expect(fromScratch(toggled, sim).topologyHash).not.toBe(fromScratch(world, sim).topologyHash);
      }),
      { numRuns: 150 },
    );
  });

  it('any valid world document compiles without throwing and keeps the guarantees', () => {
    fc.assert(
      fc.property(mappedWorldArb, (world) => {
        checkInvariants(world, compileNetlist(world, BUILTIN_CATALOG), BUILTIN_CATALOG);
      }),
      { numRuns: 100 },
    );
  });
});

describe('generator health (the properties above are not vacuous)', () => {
  it('runs build real circuits: leads, blows, value changes, AC and mixed islands', () => {
    const runs = fc.sample(runArb, { seed: 20261030, numRuns: 200 });
    let withLeads = 0;
    let withBlow = 0;
    let withValueChange = 0;
    let withAc = 0;
    let withMixed = 0;
    let revaluedChangesValues = 0;
    let connects = 0;
    let accepted = 0;
    for (const run of runs) {
      const { world, sim, tally } = build(run);
      const netlist = fromScratch(world, sim);
      connects += tally.connects;
      accepted += tally.acceptedConnects;
      if (netlist.branches.filter((b) => b.element.kind === 'connection').length >= 3) withLeads++;
      if (tally.effectiveBlows > 0) withBlow++;
      if (tally.valueChanges > 0) withValueChange++;
      if (netlist.islands.some((i) => i.kind === 'ac' || i.kind === 'mixed')) withAc++;
      if (netlist.islands.some((i) => i.kind === 'mixed')) withMixed++;
      const changed = fromScratch(revalued(world, 7), sim);
      if (changed.branches.some((b, i) => JSON.stringify(b.values) !== JSON.stringify(netlist.branches[i].values))) {
        revaluedChangesValues++;
      }
    }
    const share = (n: number) => n / runs.length;
    expect(share(withLeads)).toBeGreaterThanOrEqual(0.5);
    expect(share(withBlow)).toBeGreaterThanOrEqual(0.3);
    expect(share(withValueChange)).toBeGreaterThanOrEqual(0.2);
    expect(share(withAc)).toBeGreaterThanOrEqual(0.3);
    expect(share(withMixed)).toBeGreaterThanOrEqual(0.1);
    expect(share(revaluedChangesValues)).toBeGreaterThanOrEqual(0.5);
    expect(accepted / connects).toBeGreaterThanOrEqual(0.5);
  });

  it('the robustness property’s worlds mostly hold netlisted devices and leads', () => {
    const worlds = fc.sample(mappedWorldArb, { seed: 20261030, numRuns: 200 });
    const netlists = worlds.map((world) => compileNetlist(world, BUILTIN_CATALOG));
    const withDevice = netlists.filter((n) => n.devices.length > 0).length;
    const withLead = netlists.filter((n) => n.branches.some((b) => b.element.kind === 'connection')).length;
    expect(withDevice / worlds.length).toBeGreaterThanOrEqual(0.4);
    expect(withLead / worlds.length).toBeGreaterThanOrEqual(0.2);
  });
});
