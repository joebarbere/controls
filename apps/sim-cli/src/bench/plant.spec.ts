import { BUILTIN_CATALOG } from '@controls/catalog';
import { compileNetlist } from '@controls/sim-core';
import { buildPlant, PLANT_FEEDERS, PLANT_NODES } from './plant';
import { BENCH_CASES } from './cases';

/*
 * The bench's 2,000-node plant (F2.7, spec §4.5). Built once: compiling it is the bench's workload,
 * a few ms; the spec only checks its shape.
 */

const plant = buildPlant();
const netlist = compileNetlist(plant.world, BUILTIN_CATALOG);

describe('the bench plant', () => {
  it('compiles to exactly 2,000 nodes, with no diagnostics', () => {
    expect(netlist.nodes).toHaveLength(PLANT_NODES);
    expect(netlist.diagnostics).toStrictEqual([]);
  });

  it('is one island per feeder, each a DC island', () => {
    expect(netlist.islands.map((island) => island.kind)).toStrictEqual(Array(PLANT_FEEDERS).fill('dc'));
  });

  it('is mostly radial with some loops: a few ties and a few open switches', () => {
    const { mix } = plant;
    expect(mix.batteries).toBe(PLANT_FEEDERS);
    expect(mix.ties).toBeGreaterThan(0);
    expect(mix.ties).toBeLessThan(mix.switches / 20);
    expect(mix.openSwitches).toBeGreaterThan(0);
    expect(mix.openSwitches).toBeLessThan(mix.switches / 10);
    // Each unit is three leads (supply, lamp feed, return), plus ties and a top-up.
    expect(mix.leads).toBeGreaterThanOrEqual(3 * mix.lamps - 3);
    expect(netlist.branches).toHaveLength(mix.leads + mix.lamps + mix.batteries);
  });

  it('is deterministic, and another seed gives another plant', () => {
    expect(buildPlant().world).toStrictEqual(plant.world);
    expect(buildPlant(1).world).not.toStrictEqual(plant.world);
    expect(compileNetlist(buildPlant(1).world, BUILTIN_CATALOG).nodes).toHaveLength(PLANT_NODES);
  });

  it("the toggle case's switch changes the topology and back", () => {
    const toggle = BENCH_CASES.find((c) => c.name === 'plant-recompile-toggle');
    const [opened, closed] = (toggle?.run() ?? '').split('/');
    expect(closed).toBe(`${PLANT_NODES}:${netlist.branches.length}:${netlist.islands.length}:${netlist.topologyHash}`);
    expect(opened).not.toBe(closed);
    expect(toggle?.run()).toBe(`${opened}/${closed}`);
  });
});
