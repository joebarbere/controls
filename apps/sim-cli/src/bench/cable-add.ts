import { type Catalog, catalogOrThrow } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
// Bench-only: no real conductor, cable or box exists before F3.1 part 2 and F3.5 part 1, so the
// single-command gate runs on world-model's TEST-ONLY wiring catalogue plus one synthetic assembly.
import { BOX, CABLE, CUTTER, SCREWDRIVER, WIRING_TEST_CATALOG, WIRING_TEST_KINDS } from '@controls/world-model/testing';

/*
 * The `cable-add-worst-command` bench case's rig (plan F3.4 part 1): the 2,000-node plant with two
 * boxes 100 m beyond it, both top entries opened, and the `cable.add` args of the largest assembly the
 * catalogue format allows (16 conductors, `CableDefinition`), a **synthetic, bench-only** entry built
 * from the test catalogue's 14/2 assembly. Every value is `game-design: test` like the catalogue it
 * extends. When F3.1 part 2 ships real cables, the case switches to the largest real assembly.
 */

/** The most conductors a cable assembly may have (`CableDefinition.conductors`): the worst case. */
export const CABLE_ADD_BENCH_CONDUCTORS = 16;

const BENCH_CABLE = { id: 'cable.bench-16', version: 1 };
/** The boxes sit this far beyond the plant (whose entities lie within about 20 m of the origin). */
const BOX_Z_MM = 100_000;
const BOX_SPAN_MM = 5_000;

const ROLES = ['ungrounded', 'grounded', 'egc'] as const;
const COLOURS = [
  { base: 'black', stripe: null },
  { base: 'white', stripe: null },
  { base: 'green', stripe: 'yellow' },
] as const;

/** The test catalogue plus the synthetic 16-conductor assembly. */
function benchCatalog(): Catalog {
  const template = WIRING_TEST_CATALOG.cable(CABLE);
  if (!template) throw new Error('cable-add bench: the test catalogue has no 14/2 assembly');
  const conductors = Array.from({ length: CABLE_ADD_BENCH_CONDUCTORS }, (_, index) => ({
    index,
    conductor: template.conductors[0].conductor,
    role: ROLES[index % 3],
    insulated: true,
    colour: COLOURS[index % 3],
  }));
  const cable = {
    ...template,
    ...BENCH_CABLE,
    title: 'Bench-only 16-conductor assembly',
    conductors,
    jacket: { ...template.jacket, widthMm: 20, heightMm: 20 },
  };
  return catalogOrThrow(
    WIRING_TEST_CATALOG.version,
    {
      devices: WIRING_TEST_CATALOG.devices,
      cables: [...WIRING_TEST_CATALOG.cables, cable],
      tools: WIRING_TEST_CATALOG.tools,
      accessories: WIRING_TEST_CATALOG.accessories,
      tables: WIRING_TEST_CATALOG.tables,
    },
    WIRING_TEST_KINDS,
  );
}

const free = (x: number, y: number, z: number) => ({
  kind: 'free' as const,
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});

export interface CableAddBench {
  readonly catalog: Catalog;
  /** The plant with both boxes placed and opened. */
  readonly world: World;
  /** A fresh bus on {@link world} (no history), for one run. */
  bus(): CommandBus<World>;
  /** The timed command's args. */
  readonly args: Record<string, unknown>;
  readonly conductors: number;
}

/** Builds the rig on `plant` (the bench's closed 2,000-node plant). */
export function cableAddBench(plant: World): CableAddBench {
  const catalog = benchCatalog();
  const registry = createWorldRegistry({ catalog });
  const setup = createWorldBus(plant, registry);
  const a = plant.nextEntityId;
  const steps: [string, Record<string, unknown>][] = [
    ['entity.place', { ref: BOX, positionMm: { x: 0, y: 0, z: BOX_Z_MM } }],
    ['entity.place', { ref: BOX, positionMm: { x: BOX_SPAN_MM, y: 0, z: BOX_Z_MM } }],
    ['enclosure.openEntry', { id: a, entry: 'top', tool: SCREWDRIVER }],
    ['enclosure.openEntry', { id: a + 1, entry: 'top', tool: SCREWDRIVER }],
  ];
  for (const [id, args] of steps) {
    const result = setup.exec(id, args);
    if (!result.ok) throw new Error(`cable-add bench: ${id} failed: ${result.error.message}`);
  }
  const world = setup.state;
  // Up from box a's top entry, across and down into box b's: entries at (25, 75, 30) in each box.
  const route = [free(25, 600, BOX_Z_MM + 30), free(BOX_SPAN_MM + 25, 600, BOX_Z_MM + 30)];
  const args = {
    ref: BENCH_CABLE,
    a: { entity: a, entry: 'top' },
    b: { entity: a + 1, entry: 'top' },
    route,
    lengthMm: 8_000,
    tailsMm: { a: 300, b: 300 },
    tool: CUTTER,
  };
  return {
    catalog,
    world,
    bus: () => createWorldBus(world, registry),
    args,
    conductors: catalog.cable(BENCH_CABLE)?.conductors.length ?? 0,
  };
}
