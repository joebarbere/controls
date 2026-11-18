import type { World } from '@controls/save-format';
import { engineBus, ENGINE_TEST_CATALOG } from '../../testing/engine';
import { GFCI_20 } from '../../testing/plug-on';
import { compileNetlist, MAX_SIM_TOPOLOGY_KEYS, NetlistCompiler, simTopologyFlag } from './compile';
import { BUILTIN_NETLIST_MODELS, type NetlistModels } from './models';

/*
 * The non-allocating structure code for sim topology keys (ADR 0019 "Sim and commanded state keys",
 * ADR 0021 part 2): the compiler reads each of a model's `simTopologyKeys` through `simValue` (no bag
 * built) and projects it to a boolean, so a since-tick is "null or not". Equal codes, equal topology.
 */

function gfciWorld(): World {
  const bus = engineBus(11);
  bus.exec('entity.place', { ref: GFCI_20, positionMm: { x: 0, y: 0, z: 0 } });
  bus.exec('device.operate', { id: 1, control: 'on', value: true });
  return bus.state;
}

const parts = (world: World, compiler: NetlistCompiler, sim: Record<string, unknown>) =>
  compiler
    .compile(world, { simValue: (_entity, key) => (key in sim ? (sim[key] as never) : null) })
    .branches.map((b) => (b.element.kind === 'entity' ? b.element.part : '?'));

describe('the sim topology structure code (engine 8)', () => {
  it('projects a value to a boolean: false, null and a missing key are false; anything else true', () => {
    expect([false, null, undefined].map(simTopologyFlag)).toStrictEqual([false, false, false]);
    expect([true, 0, 41_200, 'arcing'].map(simTopologyFlag)).toStrictEqual([true, true, true, true]);
  });

  it('a held test is "held or not": moving its since-tick changes nothing, holding or letting go recompiles', () => {
    const world = gfciWorld();
    const compiler = new NetlistCompiler(ENGINE_TEST_CATALOG);
    expect(parts(world, compiler, { tripped: false, testHeldSinceTick: null })).toStrictEqual(['neutral', 'pole']);
    const held = compiler.compile(world, {
      simValue: (_e, key) => (key === 'testHeldSinceTick' ? 5 : false),
    });
    expect(held.branches.map((b) => (b.element.kind === 'entity' ? b.element.part : '?'))).toStrictEqual([
      'neutral',
      'pole',
      'test',
    ]);
    // Another tick of the same hold: the same netlist object (nothing the netlist holds changed).
    const again = compiler.compile(world, { simValue: (_e, key) => (key === 'testHeldSinceTick' ? 900 : false) });
    expect(again).toBe(held);
    expect(parts(world, compiler, { tripped: true, testHeldSinceTick: 7 })).toStrictEqual(['neutral', 'test']);
  });

  it('simValue undefined reads the world’s own bag (no live state), as `sim` returning undefined does', () => {
    const world = gfciWorld();
    const withBag: World = {
      ...world,
      entities: world.entities.map((e) => ({ ...e, sim: { ...e.sim, testHeldSinceTick: 3 } })),
    };
    const viaValue = compileNetlist(withBag, ENGINE_TEST_CATALOG, { simValue: () => undefined });
    const viaBag = compileNetlist(withBag, ENGINE_TEST_CATALOG, { sim: () => undefined });
    expect(viaValue).toStrictEqual(viaBag);
    expect(viaValue.branches).toHaveLength(3);
  });

  it(`refuses a model with more than ${MAX_SIM_TOPOLOGY_KEYS} sim topology keys`, () => {
    const keys = Array.from({ length: MAX_SIM_TOPOLOGY_KEYS + 1 }, (_, k) => `k${k}`);
    const models: NetlistModels = {
      ...BUILTIN_NETLIST_MODELS,
      devices: {
        ...BUILTIN_NETLIST_MODELS.devices,
        'breaker.gfci1p': { ...BUILTIN_NETLIST_MODELS.devices['breaker.gfci1p'], simTopologyKeys: keys },
      },
    };
    expect(() => new NetlistCompiler(ENGINE_TEST_CATALOG, { models }).compile(gfciWorld())).toThrow(/at most 30/);
  });
});
