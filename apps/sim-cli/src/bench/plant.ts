import { type EntityV2, type ConnectionV2, World } from '@controls/save-format';
import { deriveStream } from '@controls/world-model';

/*
 * The bench's synthetic plant (plan F2.7, spec §4.5): a seeded world whose netlist has exactly
 * {@link PLANT_NODES} nodes, built only from P2's catalogue (batteries, SPST switches, lamps and test
 * leads), so it compiles with the real netlist models.
 *
 * Shape: {@link PLANT_FEEDERS} feeders, each a battery feeding a random recursive tree of units. A
 * unit is a switch and a lamp: a lead from the parent's switch `b` (or the battery's `pos`) to the
 * switch's `a`, a lead from the switch's `b` to the lamp's `a`, and a lead from the lamp's `b` back to
 * the parent's lamp `b` (or the battery's `neg`), so the return path mirrors the supply tree. Mostly
 * radial: about 1 unit in 50 adds a tie lead between two switches of its feeder, which makes a loop.
 * About 1 switch in 20 is open, which islands its subtree, as a plant with circuits switched off.
 *
 * Node arithmetic: a battery is 2 nodes, a lamp 2, a closed switch 1 (its terminals are joined) and an
 * open one 2. The generator adds units while at least 3 nodes are left, then tops up with a lone lamp
 * (2) or a lone closed switch (1), so the netlist has exactly 2,000 nodes (the bench spec checks).
 *
 * The device mix is what the per-tick case (F2.3a) will step: every lamp's filament temperature and
 * every battery's state of charge. Deterministic: `deriveStream(seed, 'bench:plant')`, sorted ids.
 */

export const PLANT_NODES = 2000;
export const PLANT_FEEDERS = 8;
export const PLANT_SEED = 2000;

const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const SWITCH = { id: 'switch.tessaline-spst-toggle', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };

/** How many of each thing the plant holds. */
export interface PlantMix {
  readonly batteries: number;
  readonly switches: number;
  readonly openSwitches: number;
  readonly lamps: number;
  readonly leads: number;
  readonly ties: number;
}

export interface Plant {
  readonly world: World;
  readonly mix: PlantMix;
  /** A closed switch whose subtree is large, for the toggle case: entity id. */
  readonly toggleSwitch: number;
}

interface Unit {
  readonly switchId: number;
  readonly lampId: number | null;
}

/** Builds the plant. Pure: the same seed gives the same world. */
export function buildPlant(seed: number = PLANT_SEED): Plant {
  const rng = deriveStream(seed, 'bench:plant');
  const entities: EntityV2[] = [];
  const connections: ConnectionV2[] = [];
  let openSwitches = 0;
  let ties = 0;
  const place = (ref: { id: string; version: number }, state: EntityV2['state'] = {}): number => {
    const id = entities.length + 1;
    const position = { x: (id % 100) * 200, y: 0, z: Math.floor(id / 100) * 200 };
    entities.push({
      id,
      ref,
      transform: { positionMm: position, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      state,
      sim: {},
      extensions: {},
    });
    return id;
  };
  const lead = (a: number, at: string, b: number, bt: string) =>
    connections.push({
      id: connections.length + 1,
      ref: LEAD,
      a: { entity: a, terminal: at },
      b: { entity: b, terminal: bt },
      extensions: {},
    });

  const batteries: number[] = [];
  const feeders: Unit[][] = [];
  for (let f = 0; f < PLANT_FEEDERS; f++) {
    batteries.push(place(BATTERY));
    feeders.push([]);
  }
  let remaining = PLANT_NODES - 2 * PLANT_FEEDERS;
  /** Hooks a new switch under a random unit of feeder `f` (or its battery) and returns the parent. */
  const hang = (f: number, switchId: number): Unit | null => {
    const units = feeders[f];
    const parent =
      units.length === 0 || rng.nextInt(0, units.length) === units.length
        ? null
        : units[rng.nextInt(0, units.length - 1)];
    if (parent === null) lead(batteries[f], 'pos', switchId, 'a');
    else lead(parent.switchId, 'b', switchId, 'a');
    return parent;
  };
  const returnTo = (f: number, parent: Unit | null, lampId: number) => {
    if (parent?.lampId != null) lead(lampId, 'b', parent.lampId, 'b');
    else lead(lampId, 'b', batteries[f], 'neg');
  };

  let unitCount = 0;
  while (remaining >= 3) {
    const f = unitCount++ % PLANT_FEEDERS;
    // A feeder's first switch stays closed: it is the toggle case's switch.
    const open = remaining >= 4 && feeders[f].length > 0 && rng.nextInt(0, 19) === 0;
    const switchId = place(SWITCH, { closed: !open });
    const lampId = place(LAMP);
    const parent = hang(f, switchId);
    lead(switchId, 'b', lampId, 'a');
    returnTo(f, parent, lampId);
    feeders[f].push({ switchId, lampId });
    remaining -= open ? 4 : 3;
    if (open) openSwitches++;
    const units = feeders[f];
    if (units.length > 2 && rng.nextInt(0, 49) === 0) {
      const other = units[rng.nextInt(0, units.length - 2)];
      lead(other.switchId, 'b', switchId, 'b');
      ties++;
    }
  }
  // Top up to exactly PLANT_NODES: a lone lamp (2 nodes) or a lone closed switch (1).
  if (remaining === 2) {
    const host = feeders[0][0];
    const lampId = place(LAMP);
    lead(host.switchId, 'b', lampId, 'a');
    lead(lampId, 'b', batteries[0], 'neg');
  } else if (remaining === 1) {
    const switchId = place(SWITCH, { closed: true });
    hang(0, switchId);
  }

  const switches = entities.filter((entity) => entity.ref.id === SWITCH.id);
  const lamps = entities.filter((entity) => entity.ref.id === LAMP.id).length;
  const world = World.parse({
    schemaVersion: 2,
    seed,
    tick: 0,
    nextEntityId: entities.length + 1,
    nextConnectionId: connections.length + 1,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities,
    connections,
    sim: null,
    extensions: {},
  });
  return {
    world,
    mix: {
      batteries: batteries.length,
      switches: switches.length,
      openSwitches,
      lamps,
      leads: connections.length,
      ties,
    },
    // The first unit of feeder 0: the root of the largest subtree there.
    toggleSwitch: feeders[0][0].switchId,
  };
}
