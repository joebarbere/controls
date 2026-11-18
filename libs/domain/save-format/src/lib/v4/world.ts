import * as z from 'zod';
import {
  AreaId,
  AreaUseId,
  ColourId,
  DeviceStateBagV4,
  Difficulty,
  Extensions,
  Int,
  OutletId,
  RegionId,
} from '../primitives';
import { FixtureV1, PositionMmV1 } from '../v1/world';
import { SimSolutionV2 } from '../v2/world';
import { CableV3, ConnectionV3, EntityV3, type WaypointV3 } from '../v3/world';

/*
 * PROVISIONAL until v0.5.0 ships: schemaVersion 4 (ADR 0019, amended by ADR 0020). Until then it may
 * still change, with its fixtures replaced in the same PR; after that it is frozen like v1–v3, and a
 * change is `v5/world.ts` with a v4 → v5 migration.
 *
 * v4 adds what the residential phase (P4) stores: a cord plug in a receptacle outlet
 * (`EntityV4.pluggedInto`), re-identification tape at each conductor end (`ConnectionV4.marking`) and
 * level areas the inspector reads (`WorldV4.areas`). Bags are v3's, described for catalogue v3's
 * `text` and `counter` key types (`DeviceStateBagV4`). Fixtures, transforms, terminations, routes,
 * cables and the solution record are unchanged and reuse the v1–v3 schemas, so their JSON Schema
 * `$defs` keep their names.
 *
 * Every object is strict and no field is optional (absent is `null`).
 */

/** Most areas one world may hold (game-design: a large house has a few dozen rooms; ADR 0019). */
export const MAX_AREAS = 256;

/**
 * Which receptacle outlet an appliance's cord plug is in (ADR 0019, D1): a relation, not a transform.
 * The appliance stands where it was placed; `outlet` is an id of the receptacle entry's `outlets[]`.
 */
export const PluggedIntoV4 = z.strictObject({ entity: Int.min(1), outlet: OutletId }).meta({ id: 'PluggedIntoV4' });
export type PluggedIntoV4 = z.infer<typeof PluggedIntoV4>;

/**
 * Re-identification tape at each end of a conductor (ADR 0019; NFPA 70 Art. 200.7 by number): a
 * colour-table id or `null` for none. It belongs to the conductor end, not to its termination. Neither
 * the compiler nor the engine reads it.
 */
export const MarkingV4 = z
  .strictObject({ a: ColourId.nullable(), b: ColourId.nullable() })
  .meta({ id: 'MarkingV4', description: 'Re-identification tape at each conductor end: a colour id, or null.' });
export type MarkingV4 = z.infer<typeof MarkingV4>;

/** A connection (v3's, with `marking`, over v4 bags). Ids come from `WorldV4.nextConnectionId`. */
export const ConnectionV4 = z
  .strictObject({
    ...ConnectionV3.shape,
    /** Commanded state: written only by commands; `{}` for every P3 kind. */
    state: DeviceStateBagV4,
    /** Sim-owned state (thermal and contact): written only by `materialiseWorld`. */
    sim: DeviceStateBagV4,
    /** Tape at end `a` and end `b`; `{ a: null, b: null }` on a lead. */
    marking: MarkingV4,
  })
  .meta({ id: 'ConnectionV4' });
export type ConnectionV4 = z.infer<typeof ConnectionV4>;

/** A placed thing in the as-built world (v3's entity plus `pluggedInto`, over v4 bags). */
export const EntityV4 = z
  .strictObject({
    ...EntityV3.shape,
    /** Commanded device state: written only by commands (ADR 0013). */
    state: DeviceStateBagV4,
    /** Sim-owned device state: written only by `materialiseWorld` (ADR 0013). */
    sim: DeviceStateBagV4,
    /**
     * The receptacle outlet this entity's cord plug is in, or `null`. Never with a `mountedOn` or an
     * `inEntry`; at most one entity per outlet.
     */
    pluggedInto: PluggedIntoV4.nullable(),
  })
  .meta({ id: 'EntityV4' });
export type EntityV4 = z.infer<typeof EntityV4>;

/**
 * A level area (ADR 0019): an axis-aligned box in integer mm, half-open `[minMm, maxMm)` on each
 * axis, with a use from the catalogue's append-only `AREA_USES` registry (checked at load). Level
 * data for the inspector's location rules; no command makes one, and `sim-core` never reads it.
 */
export const AreaV4 = z
  .strictObject({
    id: AreaId,
    use: AreaUseId,
    /** The inclusive corner. */
    minMm: PositionMmV1,
    /** The exclusive corner: strictly greater than `minMm` on every axis. */
    maxMm: PositionMmV1,
  })
  .meta({ id: 'AreaV4' });
export type AreaV4 = z.infer<typeof AreaV4>;

type Issue = (path: (string | number)[], message: string) => void;

const samePosition = (p: WaypointV3['positionMm'], q: WaypointV3['positionMm']): boolean =>
  p.x === q.x && p.y === q.y && p.z === q.z;

/** Checks a route's waypoints among themselves and against the world (ADR 0015 invariant 6, as v3). */
function checkRoute(
  route: readonly WaypointV3[],
  ends: { readonly a: boolean; readonly b: boolean },
  hosts: { readonly entities: ReadonlySet<number>; readonly fixtures: ReadonlySet<string> },
  at: (string | number)[],
  issue: Issue,
): void {
  route.forEach((w, index) => {
    const path = [...at, index];
    if (w.kind === 'free') {
      if (w.entity !== null || w.fixture !== null) issue(path, 'A free waypoint has no host');
    } else if ((w.entity === null) === (w.fixture === null)) {
      issue(path, 'A hosted waypoint names exactly one host: an entity or a fixture');
    }
    if ((w.kind === 'bore') !== (w.tool !== null)) issue([...path, 'tool'], 'A bore names its tool, and only a bore');
    if (w.entity !== null && !hosts.entities.has(w.entity)) issue([...path, 'entity'], 'A waypoint host must exist');
    if (w.fixture !== null && !hosts.fixtures.has(w.fixture)) issue([...path, 'fixture'], 'A waypoint host must exist');
    if (index > 0 && samePosition(route[index - 1].positionMm, w.positionMm)) {
      issue(path, 'Consecutive waypoints must be distinct');
    }
  });
  if (!ends.a && route[0]?.kind !== 'free') issue(at, 'A free end a rests on a first waypoint of kind free');
  if (!ends.b && route.at(-1)?.kind !== 'free') issue(at, 'A free end b rests on a last waypoint of kind free');
  if (route.length + (ends.a ? 1 : 0) + (ends.b ? 1 : 0) < 2) issue(at, 'A route has at least two points');
}

/** The ids an entity's relations name: what it is mounted on, in an entry of, and plugged into. */
const relationTargets = (e: EntityV4): number[] => [
  ...(e.mountedOn === null ? [] : [e.mountedOn.entity]),
  ...(e.inEntry === null ? [] : [e.inEntry.entity]),
  ...(e.pluggedInto === null ? [] : [e.pluggedInto.entity]),
];

/**
 * The world document (`world.json`), schemaVersion 4 (ADR 0019). v3's invariants 1–8 hold unchanged,
 * plus: (9) `pluggedInto` names another entity that exists, at most one entity per outlet, never with
 * `mountedOn` or `inEntry`, and mounts, entries and plugs together form no cycle (one walk over all
 * three); (10) a lead's marking is `{ a: null, b: null }`; (11) areas are sorted by strictly ascending
 * id, no area id is a fixture id, and every box is non-empty. Checks that need the catalogue (outlets,
 * mating, reach, colours, area uses, bag keys, directory keys) are the load check's
 * (`checkWorldReferences` in `world-model`).
 */
export const WorldV4 = z
  .strictObject({
    schemaVersion: z.literal(4),
    /** World PRNG seed, an unsigned 32-bit integer (ADR 0007). */
    seed: Int.min(0).max(0xffff_ffff),
    /** Integer sim tick: 1 tick = 1 ms of sim time (ADR 0011 §2). */
    tick: Int.min(0),
    /** The next entity id to allocate. */
    nextEntityId: Int.min(1),
    /** The next connection id to allocate (leads and conductors, one id space). */
    nextConnectionId: Int.min(1),
    /** The next cable id to allocate. */
    nextCableId: Int.min(1),
    /** The next termination id to allocate (each landed conductor end takes one). */
    nextTerminationId: Int.min(1),
    regionId: RegionId,
    difficulty: Difficulty,
    /** Set once a cheat command has run; never cleared. */
    assisted: z.boolean(),
    /** Fixed level geometry, sorted by strictly ascending `id` (UTF-16 code units). */
    fixtures: z.array(FixtureV1),
    /** Level areas, sorted by strictly ascending `id` (UTF-16 code units), at most {@link MAX_AREAS}. */
    areas: z.array(AreaV4).max(MAX_AREAS),
    entities: z.array(EntityV4),
    /** Leads and conductors, sorted by strictly ascending `id`. */
    connections: z.array(ConnectionV4),
    /** Cable assemblies, sorted by strictly ascending `id` (unchanged from v3). */
    cables: z.array(CableV3),
    /** The last electrical solution, or `null` (unchanged from v2; ADR 0011 §9.6). */
    sim: SimSolutionV2.nullable(),
    extensions: Extensions,
  })
  .superRefine((world, ctx) => {
    const issue: Issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });

    // 1. Sorted ids below their counters; termination ids unique and below theirs.
    world.fixtures.forEach((fixture, index) => {
      if (index > 0 && !(world.fixtures[index - 1].id < fixture.id)) {
        issue(['fixtures', index, 'id'], 'Fixture ids must be unique and sorted in ascending order');
      }
    });
    const ascending = (items: readonly { id: number }[], name: string, label: string, counter: number) => {
      let previous = 0;
      items.forEach((item, index) => {
        if (item.id <= previous)
          issue([name, index, 'id'], `${label} ids must be unique and sorted in ascending order`);
        if (item.id >= counter) issue([name, index, 'id'], `${label} id must be below its counter`);
        previous = item.id;
      });
    };
    ascending(world.entities, 'entities', 'Entity', world.nextEntityId);
    ascending(world.connections, 'connections', 'Connection', world.nextConnectionId);
    ascending(world.cables, 'cables', 'Cable', world.nextCableId);

    const entities = new Map(world.entities.map((e) => [e.id, e]));
    const fixtureIds = new Set(world.fixtures.map((f) => f.id));
    const hosts = { entities: new Set(entities.keys()), fixtures: fixtureIds };
    const cableIds = new Set(world.cables.map((c) => c.id));

    // 2. mountedOn names another entity that exists.
    world.entities.forEach((entity, index) => {
      if (entity.mountedOn === null) return;
      if (entity.mountedOn.entity === entity.id) {
        issue(['entities', index, 'mountedOn', 'entity'], 'An entity is not mounted on itself');
      } else if (!entities.has(entity.mountedOn.entity)) {
        issue(['entities', index, 'mountedOn', 'entity'], 'An entity is mounted on an entity that exists');
      }
    });

    // 2b. inEntry names another entity that exists; one entity per entry; never with mountedOn.
    const entryHolders = new Set<string>();
    world.entities.forEach((entity, index) => {
      if (entity.inEntry === null) return;
      const at = ['entities', index, 'inEntry'];
      if (entity.mountedOn !== null) issue(at, 'An entity is either mounted or in an entry, not both');
      if (entity.inEntry.entity === entity.id) {
        issue([...at, 'entity'], 'An entity is not in an entry of itself');
      } else if (!entities.has(entity.inEntry.entity)) {
        issue([...at, 'entity'], 'An entity is in an entry of an entity that exists');
      }
      const key = `${entity.inEntry.entity}\u0000${entity.inEntry.entry}`;
      if (entryHolders.has(key)) issue(at, 'At most one entity is in each entry');
      entryHolders.add(key);
    });

    // 9. pluggedInto names another entity that exists; one plug per outlet; never with the others.
    const outletHolders = new Set<string>();
    world.entities.forEach((entity, index) => {
      if (entity.pluggedInto === null) return;
      const at = ['entities', index, 'pluggedInto'];
      if (entity.mountedOn !== null || entity.inEntry !== null) {
        issue(at, 'A plugged entity is neither mounted nor in an entry');
      }
      if (entity.pluggedInto.entity === entity.id) {
        issue([...at, 'entity'], 'An entity is not plugged into itself');
      } else if (!entities.has(entity.pluggedInto.entity)) {
        issue([...at, 'entity'], 'An entity is plugged into an entity that exists');
      }
      const key = `${entity.pluggedInto.entity}\u0000${entity.pluggedInto.outlet}`;
      if (outletHolders.has(key)) issue(at, 'At most one plug is in each outlet');
      outletHolders.add(key);
    });

    // 9. Mounts, entries and plugs together form no cycle: one walk over all three relations (it
    // replaces v3's two). An entity whose own relation names itself or a missing entity is reported
    // above, not here; a cycle through the others is still found from them.
    const inCycle = (start: EntityV4): boolean => {
      const seen = new Set<number>();
      const stack = relationTargets(start);
      while (stack.length > 0) {
        const id = stack.pop() as number;
        if (id === start.id) return true;
        const host = entities.get(id);
        if (!host || seen.has(id)) continue;
        seen.add(id);
        stack.push(...relationTargets(host));
      }
      return false;
    };
    world.entities.forEach((entity, index) => {
      const targets = relationTargets(entity);
      if (targets.length === 0 || targets.some((id) => id === entity.id || !entities.has(id))) return;
      if (inCycle(entity)) issue(['entities', index], 'Mounts, entries and plugs must not form a cycle');
    });

    // 3–6, 10. Connections: ends, shapes, markings, cables and routes.
    const terminations = new Set<number>();
    const cableConductors = new Map<number, { index: number; at: number; lengthMm: number | null }[]>();
    world.connections.forEach((connection, index) => {
      const at = ['connections', index];
      for (const end of ['a', 'b'] as const) {
        const value = connection[end];
        if (value === null) continue;
        if (!entities.has(value.entity)) issue([...at, end, 'entity'], 'A connection end names an entity that exists');
        const termination = value.termination;
        if (termination !== null) {
          if (termination.id >= world.nextTerminationId) {
            issue([...at, end, 'termination', 'id'], 'Termination id must be below nextTerminationId');
          }
          if (terminations.has(termination.id)) {
            issue([...at, end, 'termination', 'id'], 'Termination ids must be unique in the world');
          }
          terminations.add(termination.id);
        }
      }
      const { a, b } = connection;
      if (a !== null && b !== null && a.entity === b.entity && a.terminal === b.terminal) {
        issue([...at, 'b'], 'A connection must join two different terminals');
      }
      if (connection.lengthMm === null) {
        // A lead: no cable, route, colour or label; both ends landed on clips.
        const leadShaped =
          connection.cable === null &&
          connection.route === null &&
          connection.colour === null &&
          connection.label === null &&
          a !== null &&
          b !== null &&
          a.termination === null &&
          b.termination === null;
        if (!leadShaped) {
          issue(at, 'A connection without lengthMm is a lead: no cable, route, colour or label, two clip ends');
        }
        // 10. A lead stays lead-shaped: no tape on its ends.
        if (connection.marking.a !== null || connection.marking.b !== null) {
          issue([...at, 'marking'], 'A lead carries no marking: { a: null, b: null }');
        }
        return;
      }
      if (connection.colour === null) issue([...at, 'colour'], 'A conductor has a colour');
      if ((connection.route === null) === (connection.cable === null)) {
        issue(at, 'A conductor has exactly one of its own route and a cable');
      }
      for (const end of ['a', 'b'] as const) {
        if (connection[end] !== null && connection[end].termination === null) {
          issue([...at, end, 'termination'], 'A landed conductor end has a termination');
        }
      }
      if (connection.cable !== null) {
        if (!cableIds.has(connection.cable.id)) {
          issue([...at, 'cable', 'id'], 'A conductor names a cable that exists');
        } else {
          const list = cableConductors.get(connection.cable.id) ?? [];
          list.push({ index: connection.cable.conductor, at: index, lengthMm: connection.lengthMm });
          cableConductors.set(connection.cable.id, list);
        }
      }
      if (connection.route !== null) {
        checkRoute(connection.route, { a: a !== null, b: b !== null }, hosts, [...at, 'route'], issue);
      }
    });

    // 5, 7. Cables: their conductors, ends, tails and routes.
    world.cables.forEach((cable, index) => {
      const at = ['cables', index];
      const conductors = (cableConductors.get(cable.id) ?? []).slice().sort((x, y) => x.index - y.index);
      if (conductors.length === 0) issue(at, 'A cable owns at least one conductor');
      conductors.forEach((conductor, i) => {
        if (conductor.index !== i) {
          issue(['connections', conductor.at, 'cable', 'conductor'], "A cable's conductor indices are 0 … n − 1");
        }
        if (conductor.lengthMm !== cable.lengthMm) {
          issue(['connections', conductor.at, 'lengthMm'], "A cable conductor's lengthMm equals its cable's");
        }
      });
      for (const end of ['a', 'b'] as const) {
        const value = cable[end];
        if (value !== null && !entities.has(value.entity)) {
          issue([...at, end, 'entity'], 'A cable end names an entity that exists');
        }
        if (cable.jacketStripMm[end] > cable.tailsMm[end]) {
          issue([...at, 'jacketStripMm', end], 'A cable end is stripped at most to its tail');
        }
      }
      if (
        cable.a !== null &&
        cable.b !== null &&
        cable.a.entity === cable.b.entity &&
        cable.a.entry === cable.b.entry
      ) {
        issue([...at, 'b'], 'A cable must join two different entries');
      }
      if (cable.tailsMm.a + cable.tailsMm.b >= cable.lengthMm) {
        issue([...at, 'tailsMm'], "A cable's tails are shorter than its length");
      }
      checkRoute(cable.route, { a: cable.a !== null, b: cable.b !== null }, hosts, [...at, 'route'], issue);
    });

    // 8. The solution record, as in v2.
    if (world.sim !== null) {
      if (world.sim.lastSolveTick > world.tick) issue(['sim', 'lastSolveTick'], 'lastSolveTick must not be after tick');
      if (world.sim.nodes.length % 2 !== 0) issue(['sim', 'nodes'], 'nodes holds re, im pairs');
      if (world.sim.branches.length % 2 !== 0) issue(['sim', 'branches'], 'branches holds re, im pairs');
    }

    // 11. Areas: sorted ids, none a fixture id, non-empty half-open boxes.
    world.areas.forEach((area, index) => {
      const at = ['areas', index];
      if (index > 0 && !(world.areas[index - 1].id < area.id)) {
        issue([...at, 'id'], 'Area ids must be unique and sorted in ascending order');
      }
      if (fixtureIds.has(area.id)) issue([...at, 'id'], 'An area id is not a fixture id');
      for (const axis of ['x', 'y', 'z'] as const) {
        if (!(area.minMm[axis] < area.maxMm[axis])) {
          issue([...at, 'maxMm', axis], 'An area’s maxMm is greater than its minMm on every axis');
        }
      }
    });
  })
  .meta({
    title: 'Controls world document, schemaVersion 4',
    description:
      'world.json in a .ctrl save (ADR 0004, ADR 0007, ADR 0013, ADR 0015, ADR 0019). Zod in @controls/save-format is authoritative; this JSON Schema omits the cross-field rules (sorted unique ids below their counters, unique termination ids, mounts, entries and plugs naming other entities that exist, one entity per entry and per outlet, a plugged entity neither mounted nor in an entry, an entity in an entry not mounted, no cycle through mounts, entries and plugs, ends, cables and route hosts that exist, lead and conductor shapes, no marking on a lead, cable conductor indices and lengths, rest waypoints, distinct consecutive waypoints, tails, sim solution pairs and tick, areas sorted by id, not named like a fixture, with non-empty boxes), string well-formedness, a stripe differing from its base, and the per-model-kind state keys (json-schema/device-state.<kind>.schema.json and connection-state.<kind>.schema.json in @controls/catalog).',
  });
export type WorldV4 = z.infer<typeof WorldV4>;
