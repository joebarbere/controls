import { DeviceStateBag, Int, SimSolutionV2, type World } from '@controls/save-format';
import { z } from 'zod';

/*
 * Materialisation (ADR 0011 §1, ADR 0013 "Materialisation"): the world document a save writes, and
 * the one `world.hash` hashes, is the bus world with the engine's sim-owned state written in. The bus
 * world's own `sim` bags and solution record are inert during play; only this puts live values there.
 */

/**
 * The engine's sim-owned state at one tick (ADR 0011 §4): what a save needs beyond the commanded
 * world. Both persisted shapes are the save-format schemas' (ADR 0004).
 */
export const SimStateExport = z.strictObject({
  /** The tick it describes: the state after every command logged at it, before its cadence solve. */
  tick: Int.min(0),
  /**
   * Every entity the engine netlisted, ascending by id, with its whole sim bag (every sim key of its
   * model kind, absent values `null`).
   */
  entities: z.array(z.strictObject({ id: Int.min(1), state: DeviceStateBag })),
  /** The last electrical solution (ADR 0011 §9.6), or `null` when the netlist is empty (ADR 0013). */
  solution: SimSolutionV2.nullable(),
});
export type SimStateExport = z.infer<typeof SimStateExport>;

/** An export that doesn't fit the world it is materialised into: a desync or an engine bug. */
export class MaterialiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialiseError';
  }
}

/**
 * The world as a save writes it and `world.hash` hashes it: `busWorld` with the `sim` bag of every
 * entity in `exported` replaced by the engine's, and `WorldV2.sim` set to its solution. **Only those
 * are written**: every other bag (props, unknown refs, devices the engine didn't netlist, and every
 * commanded `state` bag) is the bus world's, unchanged, and so is every other field. Entities whose
 * bag is unchanged keep their objects.
 *
 * The export is parsed with the save-format schemas first (finite numbers, `-0` normalised to `+0`,
 * bag key grammar). Throws a {@link MaterialiseError} if it fails to parse, is for another tick, names
 * an entity the world doesn't hold, isn't sorted, or carries a solution for a later tick than its own.
 */
export function materialiseWorld(busWorld: World, exported: SimStateExport): World {
  const parsed = SimStateExport.safeParse(exported);
  if (!parsed.success) throw new MaterialiseError("The engine's export doesn't match the save-format schemas");
  const state = parsed.data;
  if (state.tick !== busWorld.tick) {
    throw new MaterialiseError(`The export is for tick ${state.tick}, the world is at tick ${busWorld.tick}`);
  }
  const solution = state.solution;
  if (solution !== null) {
    if (solution.lastSolveTick > state.tick) throw new MaterialiseError('The solution is from after the export');
    if (solution.nodes.length % 2 !== 0 || solution.branches.length % 2 !== 0) {
      throw new MaterialiseError('The solution must hold re, im pairs');
    }
  }
  const bags = new Map<number, DeviceStateBag>();
  let previous = 0;
  for (const { id, state: bag } of state.entities) {
    if (id <= previous) throw new MaterialiseError('The exported entities must be sorted by ascending id');
    previous = id;
    bags.set(id, bag);
  }
  let found = 0;
  const entities = busWorld.entities.map((entity) => {
    const bag = bags.get(entity.id);
    if (bag === undefined) return entity;
    found++;
    return { ...entity, sim: bag };
  });
  if (found !== bags.size) throw new MaterialiseError('The export names an entity the world does not hold');
  return { ...busWorld, entities, sim: solution };
}
