import * as z from 'zod';
import {
  CatalogRef,
  ColourId,
  DeviceStateBag,
  Difficulty,
  EntryId,
  Extensions,
  FiniteNumber,
  Int,
  LabelText,
  MountId,
  RegionId,
  TerminalId,
  TerminationMethodId,
} from '../primitives';
import { FixtureIdV1, FixtureV1, PositionMmV1, TransformV1 } from '../v1/world';
import { SimSolutionV2 } from '../v2/world';

/*
 * PROVISIONAL until v0.4.0 ships: schemaVersion 3 (ADR 0015, as amended by ADR 0016). Until then it
 * may still change, with its fixtures updated in the same PR; after that it is frozen like v1 and v2,
 * and a change is `v4/world.ts` with a v3 → v4 migration.
 *
 * v3 adds real wiring (P3): connections are test leads **and** conductors in one array (nullable
 * ends, typed per-end terminations, a route, a cut length, a colour and a label, and two state bags),
 * cable assemblies that own their conductors, what each device is mounted on and its printed label,
 * and two new id counters. Fixtures, transforms and the solution record are unchanged and reuse the
 * v1 and v2 schemas, so their JSON Schema `$defs` keep their names.
 *
 * Every object is strict and no field is optional (absent is `null`).
 */

/** Most waypoints in one route (game-design: a 1 km run stapled every metre fits; ADR 0015). */
export const MAX_ROUTE_WAYPOINTS = 1024;

/** Longest cut length of a conductor or cable, in mm (game-design: 1 km; ADR 0015). */
export const MAX_CONDUCTOR_LENGTH_MM = 1_000_000;

/** Longest cable tail (or stripped jacket) past an enclosure entry, in mm (ADR 0015). */
export const MAX_CABLE_TAIL_MM = 2000;

/**
 * A termination: the outcome of the tool steps when a conductor end was landed (ADR 0015, D8, D9).
 * What was physically made, never the contact resistance (the engine computes that from it). Its id
 * comes from `WorldV3.nextTerminationId` and keys its PRNG streams (`termination:<id>:…`).
 */
export const TerminationV3 = z
  .strictObject({
    /** Allocated from `WorldV3.nextTerminationId`: the termination's identity and its streams. */
    id: Int.min(1),
    /** The method it was made by: one of the terminal's catalogue methods. */
    method: TerminationMethodId,
    /** Made by `'auto'` (the ideal outcome, Trainee only). Never read by the engine. */
    auto: z.boolean(),
    /** The insulation length stripped (integer mm). */
    stripLengthMm: Int.min(0).max(1000),
    /** The share of the conductor's area lost to the stripper (0 to 1). */
    nickedStrandFraction: FiniteNumber.min(0).max(1),
    /** The clamp torque achieved (N·m, at least 0), or `null` for a method without a clamp torque. */
    torqueNm: FiniteNumber.min(0).nullable(),
    /** A ferrule or lug crimped on (an `accessory` entry), with how well it was crimped (1 = right die, fully closed). */
    accessory: z.strictObject({ ref: CatalogRef, crimpQuality: FiniteNumber.min(0).max(1) }).nullable(),
  })
  .meta({ id: 'TerminationV3' });
export type TerminationV3 = z.infer<typeof TerminationV3>;

/** One end of a connection: a terminal of an entity, and how the conductor was terminated there. */
export const ConnectionEndV3 = z
  .strictObject({
    entity: Int.min(1),
    terminal: TerminalId,
    /** `null` for a lead's clip; never `null` on a landed conductor end. */
    termination: TerminationV3.nullable(),
  })
  .meta({ id: 'ConnectionEndV3' });
export type ConnectionEndV3 = z.infer<typeof ConnectionEndV3>;

/** A conductor's colour: an insulation colour and an optional tracer stripe, both colour-table ids. */
export const ConductorColourV3 = z
  .strictObject({
    base: ColourId,
    /** A tracer stripe, or `null`. Never the base colour itself. */
    stripe: ColourId.nullable(),
  })
  .refine((c) => c.stripe !== c.base, { message: 'A stripe must differ from the base colour', path: ['stripe'] })
  .meta({ id: 'ConductorColourV3' });
export type ConductorColourV3 = z.infer<typeof ConductorColourV3>;

/** A waypoint kind (ADR 0015): free air, or on a duct, a conduit, a staple or through a bore. */
export const WaypointKindV3 = z.enum(['free', 'duct', 'conduit', 'staple', 'bore']);
export type WaypointKindV3 = z.infer<typeof WaypointKindV3>;

/**
 * A route waypoint (ADR 0015): integer mm. A `free` waypoint has no host and no tool; every other kind
 * has exactly one host (an entity or a level fixture); a `bore` has the drill bit or hole saw that made
 * the hole, the others none. A hosted waypoint's position is the domain snapper's point on its host's
 * axis.
 */
export const WaypointV3 = z
  .strictObject({
    kind: WaypointKindV3,
    positionMm: PositionMmV1,
    /** The duct, conduit stick or stud entity it is on, or `null`. */
    entity: Int.min(1).nullable(),
    /** Or the level fixture (a stud) it is on, or `null`. */
    fixture: FixtureIdV1.nullable(),
    /** A bore's drill bit or hole saw (a tool entry, one per size); `null` for every other kind. */
    tool: CatalogRef.nullable(),
  })
  .meta({ id: 'WaypointV3' });
export type WaypointV3 = z.infer<typeof WaypointV3>;

/** A route: waypoints ordered from end `a` to end `b`, at most {@link MAX_ROUTE_WAYPOINTS}. */
const RouteV3 = z.array(WaypointV3).max(MAX_ROUTE_WAYPOINTS);

/** A cut length in integer mm, 1 to {@link MAX_CONDUCTOR_LENGTH_MM}. */
const LengthMmV3 = Int.min(1).max(MAX_CONDUCTOR_LENGTH_MM);

/**
 * A two-ended connection (ADR 0015): a test lead (lead-shaped: no cable, route, length, colour or
 * label; both ends landed with clip ends, `termination: null`) or a conductor (a length and a colour,
 * exactly one of its own `route` or a `cable`, and a termination on every landed end). A connection
 * with a `null` end is unlanded and not netlisted. Ids come from `WorldV3.nextConnectionId`.
 */
export const ConnectionV3 = z
  .strictObject({
    id: Int.min(1),
    /** A connection kind's catalogue entry: a `lead` or a conductor. */
    ref: CatalogRef,
    /** `null`: an unlanded end, lying free. */
    a: ConnectionEndV3.nullable(),
    b: ConnectionEndV3.nullable(),
    /** The cable it belongs to and its index in the assembly's `conductors[]`, or `null`. */
    cable: z.strictObject({ id: Int.min(1), conductor: Int.min(0) }).nullable(),
    /** A single conductor's own route; `null` for a lead or a cable conductor (which shares the cable's). */
    route: RouteV3.nullable(),
    /** The cut length (integer mm); `null` for a lead (its length is catalogue data). */
    lengthMm: LengthMmV3.nullable(),
    /** `null` for a lead. */
    colour: ConductorColourV3.nullable(),
    /** A printed sleeve marker, or `null`. */
    label: LabelText.nullable(),
    /** Commanded state: written only by commands; `{}` for every P3 kind. */
    state: DeviceStateBag,
    /** Sim-owned state (thermal and contact): written only by `materialiseWorld`. */
    sim: DeviceStateBag,
    extensions: Extensions,
  })
  .meta({ id: 'ConnectionV3' });
export type ConnectionV3 = z.infer<typeof ConnectionV3>;

/** A cable end: an enclosure entity and one of its catalogue entries (open, with room). */
export const CableEndV3 = z.strictObject({ entity: Int.min(1), entry: EntryId }).meta({ id: 'CableEndV3' });
export type CableEndV3 = z.infer<typeof CableEndV3>;

/** A per-end length past a cable's entry, in integer mm (0 to {@link MAX_CABLE_TAIL_MM}). */
const PerEndMmV3 = z.strictObject({ a: Int.min(0).max(MAX_CABLE_TAIL_MM), b: Int.min(0).max(MAX_CABLE_TAIL_MM) });

/**
 * A cable assembly (ADR 0015): owns one conductor connection per assembly conductor, which share its
 * route and length. A `null` end is free (the cable stops in the open). Ids come from
 * `WorldV3.nextCableId`.
 */
export const CableV3 = z
  .strictObject({
    id: Int.min(1),
    /** A cable assembly's catalogue entry. */
    ref: CatalogRef,
    a: CableEndV3.nullable(),
    b: CableEndV3.nullable(),
    /** From end `a` to end `b`. */
    route: RouteV3,
    /** The cut length (integer mm); every conductor's `lengthMm` equals it. */
    lengthMm: LengthMmV3,
    /** Cable left past each end's entry (into the box), integer mm. */
    tailsMm: PerEndMmV3,
    /** Jacket removed at each end, at most that end's tail. */
    jacketStripMm: PerEndMmV3,
    label: LabelText.nullable(),
    extensions: Extensions,
  })
  .meta({ id: 'CableV3' });
export type CableV3 = z.infer<typeof CableV3>;

/** What a device is mounted on (D11): a relation, not a transform parent. */
export const MountedOnV3 = z.strictObject({ entity: Int.min(1), mount: MountId }).meta({ id: 'MountedOnV3' });
export type MountedOnV3 = z.infer<typeof MountedOnV3>;

/** A placed thing in the as-built world (v2's entity plus `mountedOn` and `label`). */
export const EntityV3 = z
  .strictObject({
    /** Allocated from `WorldV3.nextEntityId`; never from `crypto.randomUUID` (ADR 0007). */
    id: Int.min(1),
    ref: CatalogRef,
    /** Absolute, even when mounted: nothing inherits it (D11). */
    transform: TransformV1,
    /** Commanded device state: written only by commands (ADR 0013). */
    state: DeviceStateBag,
    /** Sim-owned device state: written only by `materialiseWorld` (ADR 0013). */
    sim: DeviceStateBag,
    /** The enclosure (or enclosure part) and the catalogue mount holding it, or `null`. */
    mountedOn: MountedOnV3.nullable(),
    /** The text of a printed label on the device (`TB1`), or `null`. */
    label: LabelText.nullable(),
    extensions: Extensions,
  })
  .meta({ id: 'EntityV3' });
export type EntityV3 = z.infer<typeof EntityV3>;

type Issue = (path: (string | number)[], message: string) => void;

const samePosition = (p: WaypointV3['positionMm'], q: WaypointV3['positionMm']): boolean =>
  p.x === q.x && p.y === q.y && p.z === q.z;

/** Checks a route's waypoints among themselves and against the world (ADR 0015 invariant 6). */
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

/**
 * The world document (`world.json`), schemaVersion 3 (ADR 0015). Fixtures, entities, connections and
 * cables are each sorted by strictly ascending id, below their counters; termination ids are unique
 * and below `nextTerminationId`; nothing dangles (mounts, ends, cables and route hosts name things
 * that exist); leads and conductors have their shapes. Checks that need the catalogue (terminals,
 * methods, colours, mounts, entries, lengths against geometry, bag keys) are the load check's
 * (`checkWorldReferences` in `world-model`).
 */
export const WorldV3 = z
  .strictObject({
    schemaVersion: z.literal(3),
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
    entities: z.array(EntityV3),
    /** Leads and conductors, sorted by strictly ascending `id`. */
    connections: z.array(ConnectionV3),
    /** Cable assemblies, sorted by strictly ascending `id`. */
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
    const hosts = { entities: new Set(entities.keys()), fixtures: new Set(world.fixtures.map((f) => f.id)) };
    const cableIds = new Set(world.cables.map((c) => c.id));

    // 2. mountedOn names another entity that exists, with no cycle.
    const hostOf = (entity: EntityV3): EntityV3 | undefined =>
      entity.mountedOn === null ? undefined : entities.get(entity.mountedOn.entity);
    world.entities.forEach((entity, index) => {
      if (entity.mountedOn === null) return;
      if (entity.mountedOn.entity === entity.id) {
        issue(['entities', index, 'mountedOn', 'entity'], 'An entity is not mounted on itself');
      } else if (!entities.has(entity.mountedOn.entity)) {
        issue(['entities', index, 'mountedOn', 'entity'], 'An entity is mounted on an entity that exists');
      } else {
        const seen = new Set<number>([entity.id]);
        for (let host = entities.get(entity.mountedOn.entity); host; host = hostOf(host)) {
          if (seen.has(host.id)) {
            issue(['entities', index, 'mountedOn'], 'Mounting must not form a cycle');
            break;
          }
          seen.add(host.id);
        }
      }
    });

    // 3–6. Connections: ends, shapes, cables and routes.
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
  })
  .meta({
    title: 'Controls world document, schemaVersion 3',
    description:
      'world.json in a .ctrl save (ADR 0004, ADR 0007, ADR 0013, ADR 0015). Zod in @controls/save-format is authoritative; this JSON Schema omits the cross-field rules (sorted unique ids below their counters, unique termination ids, mounts without cycles, ends, cables and route hosts that exist, lead and conductor shapes, cable conductor indices and lengths, rest waypoints, distinct consecutive waypoints, tails, sim solution pairs and tick), string well-formedness, a stripe differing from its base, and the per-model-kind state keys (json-schema/device-state.<kind>.schema.json and connection-state.<kind>.schema.json in @controls/catalog).',
  });
export type WorldV3 = z.infer<typeof WorldV3>;
