import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import type { World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';

/*
 * The `cable-add-worst-command` bench case's rig (plan F3.4 part 1, switched to real content by F3.1
 * part 2): the 2,000-node plant and the `cable.add` args of the largest real assembly the real cutter
 * can cut, on the built-in catalogue. The largest assemblies by conductor count are the /3 NM-B cables
 * with ground (four conductors); of those, 8/3 is the thickest the diagonal cutters
 * (`tool.veltmark-dc-8`, cut up to 8 AWG) accept, and 6/3 would be refused (`beyond-tool-capacity`).
 * No real enclosure exists before F3.5 part 1, so both ends are free (a null end is legal), 100 m
 * beyond the plant; an entry end would add only the entry checks.
 */

/** The bench's assembly: the largest real one by conductor count that the real cutter cuts. */
export const CABLE_ADD_BENCH_CABLE = { id: 'cable.sorrelby-nmb-8-3', version: 1 } as const;
/** Its conductor count (three insulated and the bare EGC). */
export const CABLE_ADD_BENCH_CONDUCTORS = 4;

const CUTTER = { id: 'tool.veltmark-dc-8', version: 1 };
/** The cable lies this far beyond the plant (whose entities lie within about 20 m of the origin). */
const CABLE_Z_MM = 100_000;
const CABLE_SPAN_MM = 5_000;

const free = (x: number, y: number, z: number) => ({
  kind: 'free' as const,
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});

export interface CableAddBench {
  readonly catalog: Catalog;
  /** The plant the cable is added beside. */
  readonly world: World;
  /** A fresh bus on {@link world} (no history), for one run. */
  bus(): CommandBus<World>;
  /** The timed command's args. */
  readonly args: Record<string, unknown>;
  readonly conductors: number;
}

/** Builds the rig on `plant` (the bench's closed 2,000-node plant). */
export function cableAddBench(plant: World): CableAddBench {
  const catalog = BUILTIN_CATALOG;
  const registry = createWorldRegistry({ catalog });
  const route = [free(0, 600, CABLE_Z_MM), free(CABLE_SPAN_MM, 600, CABLE_Z_MM)];
  const args = {
    ref: CABLE_ADD_BENCH_CABLE,
    a: null,
    b: null,
    route,
    lengthMm: 8_000,
    tailsMm: { a: 300, b: 300 },
    tool: CUTTER,
  };
  return {
    catalog,
    world: plant,
    bus: () => createWorldBus(plant, registry),
    args,
    conductors: catalog.cable(CABLE_ADD_BENCH_CABLE)?.conductors.length ?? 0,
  };
}
