import { BUILTIN_CATALOG } from '@controls/catalog';
import { compileNetlist } from '@controls/sim-core';
import { BENCH_CASES } from './cases';
import { TICK_WIRED_CASE, TOGGLED_CONNECTION, WIRED_START, wiredPlantWorld } from './wired';
import { buildWiredPlant, WIRED_LOOPS, WIRED_PARALLEL } from './wired-plant';

/*
 * F3.6 part 1's wired bench (plan P3 "Budgets"): the plant's shape and the cases' workloads. Timings
 * are the Nx `bench` target's business; this checks the cases measure what they say.
 */

describe('the wired bench plant', () => {
  const world = buildWiredPlant();
  const netlist = compileNetlist(world, BUILTIN_CATALOG);

  it('holds 1,000 catalogue devices and 2,000 landed conductors, every one netlisted', () => {
    expect(world.entities).toHaveLength(1000);
    const conductors = world.connections.filter((c) => c.ref.id.startsWith('conductor.'));
    expect(conductors).toHaveLength(WIRED_LOOPS * (1 + WIRED_PARALLEL));
    expect(conductors).toHaveLength(2000);
    expect(conductors.every((c) => c.a?.termination != null && c.b?.termination != null)).toBe(true);
    expect(netlist.diagnostics).toStrictEqual([]);
    expect(netlist.branches.filter((b) => b.model === 'conductor')).toHaveLength(2000);
    expect(netlist.islands.every((island) => island.kind === 'dc')).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildWiredPlant()).toStrictEqual(world);
  });
});

describe('tick-wired-plant', () => {
  it('times a cadence tick whose solve ran before the timer, and a warm bank with no re-solve', () => {
    expect(WIRED_START % 10).toBe(0);
    const materialised = wiredPlantWorld();
    expect(materialised.tick).toBe(WIRED_START);
    const warm = materialised.connections.filter((c) => (c.sim['conductorTempK'] as number) > 293.15);
    expect(warm.length).toBe(materialised.connections.length);
    TICK_WIRED_CASE.prepare?.();
    const first = TICK_WIRED_CASE.run();
    const digest = TICK_WIRED_CASE.checksum?.();
    expect(first).toBe(`${WIRED_START + 1}:${WIRED_START}:0:0:${2000 + 600 + 400 + 200}`);
    TICK_WIRED_CASE.prepare?.();
    expect(TICK_WIRED_CASE.run()).toBe(first);
    expect(TICK_WIRED_CASE.checksum?.()).toBe(digest);
    expect(digest?.startsWith('2600:')).toBe(true);
  });

  it('is gated at 0.3 ms with an allocation invariant; the wired re-solve is calibrated at 2 ms', () => {
    expect(TICK_WIRED_CASE).toMatchObject({ budgetMs: 0.3 });
    expect(TICK_WIRED_CASE.invariant).toBeDefined();
    const resolve = BENCH_CASES.find((c) => c.name === 'plant-resolve-topology-change-wired');
    expect(resolve).toMatchObject({ budgetMs: 2 });
    resolve?.prepare?.();
    const first = resolve?.run();
    resolve?.prepare?.();
    expect(resolve?.run()).toBe(first);
  });
});

describe('intermittent-toggle-wired (F3.6 part 2)', () => {
  it('times one end opening on the wired plant: its branch dropped, the plant recompiled and re-solved', () => {
    const toggle = BENCH_CASES.find((c) => c.name === 'intermittent-toggle-wired');
    expect(toggle).toMatchObject({ budgetMs: 2 });
    expect(toggle?.calibration).toBeDefined();
    const closed = compileNetlist(wiredPlantWorld(), BUILTIN_CATALOG);
    toggle?.prepare?.();
    const first = toggle?.run() ?? '';
    const [nodes, branches, islands, hash] = first.split(':');
    // One branch fewer, the same nodes and islands (the opened loop is still one chain), a new hash.
    expect(Number(nodes)).toBe(closed.nodes.length);
    expect(Number(branches)).toBe(closed.branches.length - 1);
    expect(Number(islands)).toBe(closed.islands.length);
    expect(hash).not.toBe(closed.topologyHash);
    const open = compileNetlist(wiredPlantWorld(), BUILTIN_CATALOG, {
      connectionSim: (id) =>
        id === TOGGLED_CONNECTION ? { endAState: 'intermittentOpen', endBState: 'ok' } : undefined,
    });
    expect(hash).toBe(open.topologyHash);
    toggle?.prepare?.();
    expect(toggle?.run()).toBe(first);
  });
});
