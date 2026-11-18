import {
  type AnyCommandDef,
  defineCommand,
  entityRefMeta,
  fail,
  ROUTING_STARTED_KEY,
  SELECTION_ENTITY_ID_KEY,
  succeed,
  VIEWPORT_FOCUSED_KEY,
} from '@controls/commands';
import { BUILTIN_CATALOG, type Catalog, CUT_LENGTH_KEY, cutLengthMm, initialBags } from '@controls/catalog';
import {
  CatalogRef,
  EntryId,
  Int,
  MILLIDEGREES_PER_TURN,
  MountId,
  OrientationMdegV1,
  PositionMmV1,
} from '@controls/save-format';
import { checkInEntry } from './wiring/in-entry';
import { checkMount } from './wiring/mounting';
import { checkOverlap } from './wiring/overlap';
import { unlandEnd } from './wiring/wire-commands';
import * as z from 'zod';
import type { Connection, Entity, EntityId, OrientationMdeg, World } from './types';

/*
 * The world document operations (plan F1.2), as undoable commands. Each `run` validates against the
 * current world and returns an apply/invert pair; nothing mutates. Invariants kept (ADR 0007):
 * entities stay sorted by ascending id, ids come from `nextEntityId` (undoing a place restores it),
 * and undoing a delete reinserts the entity with its same id. World v2 (ADR 0013): a placed device
 * starts with its model kind's initial state bags, and deleting an entity removes its connections in
 * the same change (undo restores them with their ids), so no connection ever dangles. Every change
 * keeps `tick` and leaves every other entity's `sim` bag alone (ADR 0011 §1, §3).
 *
 * World v3 (ADR 0015, "Mounting and occupancy"): `entity.place` takes `mountedOn` (default `null`),
 * checked against the catalogue (`checkMount`: the host's mount, the device's fit, the mount frame,
 * its place on the mount and room on it), and a new entity is unlabelled (`entity.label` prints one).
 * An entity something is mounted on, a cable enters or a route is hosted by is `occupied`: it can't
 * move, turn or go. A mounted device can't be rotated, and moves only by sliding along its own mount
 * (re-checked), unless `wired`. An entity with a landed conductor end is `wired`: it can't move or
 * turn (its wires' routes and lengths would be left behind), but deleting it unlands those ends (a
 * rest waypoint where each terminal was) in the same change, so no end dangles; undo restores the
 * entity, its leads and its conductors exactly, terminations included. Test leads behave as in v2.
 *
 * Pre-freeze (ADR 0015 F3.4 part 2 note 4): `entity.place` takes `inEntry` (default `null`): a conduit
 * connector placed in an enclosure entry, checked by `checkInEntry` (an open entry of its trade size,
 * its entry end exactly there, room in the entry). A connector in an entry can't move or turn
 * (`in-entry`), and holds its enclosure (`occupied`).
 *
 * World v4 (ADR 0019 "Occupancy"): `entity.place` makes an unplugged entity (`pluggedInto: null`;
 * plugging is always `plug.insert`); a plugged entity can't move or turn (`plugged`), and a receptacle
 * holding a plug is `occupied` for move and turn. Deleting a receptacle unplugs everything in it, and
 * deleting a plugged appliance takes its plug with it, in the same change; undo restores every relation
 * exactly (P4 PR 8 relaxed PR 7's interim `occupied` delete refusal; refusals aren't logged, so
 * relaxing it changes no log).
 *
 * F3.5: `entity.place`, `entity.move` and `entity.rotate` refuse a body that would overlap another
 * entity's when either is an enclosure or a mounted device (`overlaps`, the `mounting` scope of
 * `wiring/overlap.ts`; pre-v3 logs stack free props, so free bodies among themselves are only kept
 * apart by the placement maths), after the mount checks; a device never overlaps its own host.
 *
 * The argument shapes are persisted in replay logs: changing one is a save-format change.
 */

/** An entity id. The `.meta()` hint only tells generated forms to offer the selection (F1.3). */
const EntityIdArg = Int.min(1).meta({ ...entityRefMeta, title: 'Entity' });

/** A rotation step per axis in integer millidegrees, strictly less than a full turn either way. */
const DeltaMdeg = Int.min(-(MILLIDEGREES_PER_TURN - 1)).max(MILLIDEGREES_PER_TURN - 1);

/** What a placed device is mounted on: an enclosure entity and one of its catalogue mounts (ADR 0015). */
export const MountedOnArg = z.strictObject({
  entity: EntityIdArg.meta({ ...entityRefMeta, title: 'Enclosure' }),
  mount: MountId.meta({ title: 'Mount', description: "A mount id of the enclosure's catalogue entry (rail-1, yoke)" }),
});

/** Which enclosure entry a placed conduit connector is in: an enclosure entity and one of its catalogue entries. */
export const InEntryArg = z.strictObject({
  entity: EntityIdArg.meta({ ...entityRefMeta, title: 'Enclosure' }),
  entry: EntryId.meta({ title: 'Entry', description: "An entry id of the enclosure's catalogue entry (ko-bottom-1)" }),
});

export const EntityPlaceArgs = z.strictObject({
  ref: CatalogRef,
  positionMm: PositionMmV1,
  orientationMdeg: OrientationMdegV1.default(() => ({ yaw: 0, pitch: 0, roll: 0 })),
  /** World v3 (ADR 0015): `null` (the default) places it free-standing. Logged explicitly, as `null` too. */
  mountedOn: MountedOnArg.nullable().default(null).meta({ title: 'Mounted on' }),
  /**
   * World v3 (ADR 0015 F3.4 part 2 note 4): the entry a conduit connector goes in, or `null` (the
   * default). Logged explicitly, as `null` too.
   */
  inEntry: InEntryArg.nullable().default(null).meta({ title: 'In entry' }),
});
export type EntityPlaceArgs = z.infer<typeof EntityPlaceArgs>;

export const EntityMoveArgs = z.strictObject({ id: EntityIdArg, positionMm: PositionMmV1 });
export type EntityMoveArgs = z.infer<typeof EntityMoveArgs>;

export const EntityRotateArgs = z.strictObject({
  id: EntityIdArg,
  deltaMdeg: z.strictObject({ yaw: DeltaMdeg, pitch: DeltaMdeg, roll: DeltaMdeg }),
});
export type EntityRotateArgs = z.infer<typeof EntityRotateArgs>;

export const EntityDeleteArgs = z.strictObject({ id: EntityIdArg });
export type EntityDeleteArgs = z.infer<typeof EntityDeleteArgs>;

/** Index of entity `id` in the sorted `entities`, or -1. Binary search. */
export function findEntityIndex(entities: readonly Entity[], id: EntityId): number {
  let lo = 0;
  let hi = entities.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midId = entities[mid].id;
    if (midId === id) return mid;
    if (midId < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function findEntity(world: Pick<World, 'entities'>, id: EntityId): Entity | undefined {
  const index = findEntityIndex(world.entities, id);
  return index < 0 ? undefined : world.entities[index];
}

/** A copy of `items` with `item` inserted at its sorted position by id (its id must be absent). */
export function insertSorted<T extends { readonly id: number }>(items: readonly T[], item: T): T[] {
  let index = 0;
  while (index < items.length && items[index].id < item.id) index++;
  return [...items.slice(0, index), item, ...items.slice(index)];
}

/** Whether a connection has a landed end on entity `id`. */
export function touchesEntity(connection: Connection, id: EntityId): boolean {
  return connection.a?.entity === id || connection.b?.entity === id;
}

/** Whether `connection` is a test lead (lead-shaped: no length; ADR 0015). */
export function isLead(connection: Connection): boolean {
  return connection.lengthMm === null;
}

/**
 * Whether entity `id` is occupied (ADR 0015): a device is mounted on it, a connector or a cable end is
 * in one of its entries, a route waypoint names it, or (world v4, ADR 0019) a cord is plugged into one
 * of its outlets. An occupied entity can't move or turn; it can't be deleted either, unless only plugs
 * hold it (`entity.delete` unplugs what a receptacle holds; `plugs: false` leaves plugs out).
 */
export function entityOccupied(
  world: Pick<World, 'entities' | 'cables' | 'connections'>,
  id: EntityId,
  { plugs = true }: { readonly plugs?: boolean } = {},
): boolean {
  if (
    world.entities.some(
      (e) => e.mountedOn?.entity === id || e.inEntry?.entity === id || (plugs && e.pluggedInto?.entity === id),
    )
  ) {
    return true;
  }
  if (world.cables.some((c) => c.a?.entity === id || c.b?.entity === id || c.route.some((w) => w.entity === id))) {
    return true;
  }
  return world.connections.some((c) => c.route?.some((w) => w.entity === id) ?? false);
}

/** Whether a conductor end is landed on entity `id` (`wired`: it can't move or turn). */
export function entityWired(world: Pick<World, 'connections'>, id: EntityId): boolean {
  return world.connections.some((c) => !isLead(c) && touchesEntity(c, id));
}

/**
 * What stops entity `id` being picked up to move (world v4, ADR 0019), or `null`: its own cord is
 * plugged in (`plugged`: unplug it first), or it is occupied (see {@link entityOccupied}: a receptacle
 * holding a plug, a host with a device mounted on it, …). The UI refuses at pick-up with it.
 */
export function moveBlocker(
  world: Pick<World, 'entities' | 'cables' | 'connections'>,
  id: EntityId,
): 'plugged' | 'occupied' | null {
  if ((findEntity(world, id)?.pluggedInto ?? null) !== null) return 'plugged';
  if (entityOccupied(world, id)) return 'occupied';
  return null;
}

/**
 * Why entity `id` can't move or turn, or `null`: `plugged` or `occupied` (see {@link moveBlocker}), or
 * `wired` (see {@link entityWired}).
 */
export function entityHold(
  world: Pick<World, 'entities' | 'cables' | 'connections'>,
  id: EntityId,
): 'plugged' | 'occupied' | 'wired' | null {
  const blocker = moveBlocker(world, id);
  if (blocker !== null) return blocker;
  if (entityWired(world, id)) return 'wired';
  return null;
}

function holdFailure(hold: 'plugged' | 'occupied' | 'wired', id: EntityId) {
  switch (hold) {
    case 'plugged':
      return fail('plugged', `Entity ${id} is plugged in: unplug it first`);
    case 'occupied':
      return fail('occupied', `Entity ${id} holds a mounted device, a connector, a cable end, a route or a plug`);
    case 'wired':
      return fail('wired', `Entity ${id} has a conductor landed on it: unland it first`);
  }
}

/** A copy of `connections` with each of `restored` (absent ids) put back at its sorted position. */
function insertAllSorted(connections: readonly Connection[], restored: readonly Connection[]): Connection[] {
  return restored.reduce<Connection[]>((list, connection) => insertSorted(list, connection), [...connections]);
}

function withoutEntity(entities: readonly Entity[], id: EntityId): Entity[] {
  return entities.filter((e) => e.id !== id);
}

function withEntity(entities: readonly Entity[], id: EntityId, update: (e: Entity) => Entity): Entity[] {
  return entities.map((e) => (e.id === id ? update(e) : e));
}

/** A plugged entity can't move or turn (world v4, ADR 0019): unplug it first. */
function pluggedFailure(entity: Entity) {
  return fail('plugged', `Entity ${entity.id} is plugged into entity ${entity.pluggedInto?.entity}: unplug it first`);
}

function inEntryFailure(entity: Entity) {
  const at = entity.inEntry;
  return fail(
    'in-entry',
    `Entity ${entity.id} is in entry "${at?.entry}" of entity ${at?.entity}: it can't move or turn`,
  );
}

function notFound(id: EntityId) {
  return fail('not-found', `No entity with id ${id}`);
}

/** Adds two angles modulo a full turn, into [0, 360000). */
export function addAngleMdeg(angle: number, delta: number): number {
  return (((angle + delta) % MILLIDEGREES_PER_TURN) + MILLIDEGREES_PER_TURN) % MILLIDEGREES_PER_TURN;
}

function rotateBy(o: OrientationMdeg, d: OrientationMdeg, sign: 1 | -1): OrientationMdeg {
  return {
    yaw: addAngleMdeg(o.yaw, sign * d.yaw),
    pitch: addAngleMdeg(o.pitch, sign * d.pitch),
    roll: addAngleMdeg(o.roll, sign * d.roll),
  };
}

/**
 * `entity.place`: adds an entity by catalogue reference. Its id is the world's `nextEntityId`,
 * which then increments; undo removes the entity and restores the counter. A catalogue device starts
 * with its model kind's initial bags (`initialBags`); a built-in prop, or a ref the catalogue doesn't
 * know, starts with empty ones. A connection kind (a test lead) can't be placed: `lead.connect` makes it.
 * A cut-to-length raceway (F3.5 part 2) starts at its entry's `defaultLengthMm` (`raceway.cut`
 * changes it), so its body is that long for the mount and overlap checks.
 */
export function entityPlaceCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EntityPlaceArgs, World>({
    id: 'entity.place',
    title: 'Place object',
    category: 'Entity',
    args: EntityPlaceArgs,
    undoable: true,
    run: ({ state }, args) => {
      const id = state.nextEntityId;
      if (!Number.isSafeInteger(id + 1)) return fail('ids-exhausted', 'No entity ids left in this world');
      const kind = catalog.kindOf(args.ref);
      if (kind?.placement === 'connection') {
        return fail('not-placeable', `${args.ref.id} is a connection: make it with lead.connect`);
      }
      if (args.inEntry !== null) {
        if (args.mountedOn !== null) {
          return fail('mount-mismatch', 'A connector in an entry is not also mounted: give mountedOn or inEntry');
        }
        const transform = { positionMm: args.positionMm, orientationMdeg: args.orientationMdeg };
        const refused = checkInEntry(state, catalog, args.ref, transform, null, args.inEntry, null);
        if (refused) return refused;
      }
      if (args.mountedOn !== null) {
        const refused = checkMount(
          state,
          catalog,
          args.ref,
          args.positionMm,
          args.orientationMdeg,
          args.mountedOn,
          null,
        );
        if (refused) return refused;
      }
      const transform = { positionMm: args.positionMm, orientationMdeg: args.orientationMdeg };
      const overlaps = checkOverlap(state, catalog, args.ref, transform, args.mountedOn, null);
      if (overlaps) return overlaps;
      const bags = kind ? initialBags(kind) : { state: {}, sim: {} };
      const device = catalog.device(args.ref);
      const cut = device ? cutLengthMm(device, null) : null;
      if (cut !== null) bags.state[CUT_LENGTH_KEY] = cut;
      const entity: Entity = {
        id,
        ref: { ...args.ref },
        transform: { positionMm: { ...args.positionMm }, orientationMdeg: { ...args.orientationMdeg } },
        state: bags.state,
        sim: bags.sim,
        mountedOn: args.mountedOn && { ...args.mountedOn },
        inEntry: args.inEntry && { ...args.inEntry },
        label: null,
        extensions: {},
        // World v4: a placed appliance is unplugged; plugging is always `plug.insert` (ADR 0019).
        pluggedInto: null,
      };
      return succeed({
        // The new id is above every existing one, so appending keeps the order.
        apply: (w) => ({ ...w, nextEntityId: id + 1, entities: [...w.entities, entity] }),
        invert: (w) => ({ ...w, nextEntityId: id, entities: withoutEntity(w.entities, id) }),
      });
    },
  });
}

/**
 * `entity.move`: sets an entity's position (absolute, integer mm). Undo restores the old one. A
 * mounted device only slides along its own mount (`off-mount`, `mount-full` re-checked); a connector
 * in an entry doesn't move (`in-entry`); nothing may move into another entity's body (`overlaps`).
 */
export function entityMoveCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EntityMoveArgs, World>({
    id: 'entity.move',
    title: 'Move object',
    category: 'Entity',
    args: EntityMoveArgs,
    undoable: true,
    run: ({ state }, { id, positionMm }) => {
      const entity = findEntity(state, id);
      if (!entity) return notFound(id);
      if (entity.inEntry !== null) return inEntryFailure(entity);
      if (entity.pluggedInto !== null) return pluggedFailure(entity);
      const hold = entityHold(state, id);
      if (hold !== null) return holdFailure(hold, id);
      if (entity.mountedOn !== null) {
        const { orientationMdeg } = entity.transform;
        const { ref, mountedOn } = entity;
        const refused = checkMount(state, catalog, ref, positionMm, orientationMdeg, mountedOn, id, entity.state);
        if (refused) return refused;
      }
      const moved = { positionMm, orientationMdeg: entity.transform.orientationMdeg };
      const overlaps = checkOverlap(state, catalog, entity.ref, moved, entity.mountedOn, id, entity.state);
      if (overlaps) return overlaps;
      const before = entity.transform.positionMm;
      const after = { ...positionMm };
      const setPosition = (position: typeof after) => (w: World) => ({
        ...w,
        entities: withEntity(w.entities, id, (e) => ({ ...e, transform: { ...e.transform, positionMm: position } })),
      });
      return succeed({ apply: setPosition(after), invert: setPosition(before) });
    },
  });
}

/** `entity.move` against the built-in catalogue. */
export const entityMove = entityMoveCommand();

/**
 * `entity.rotate`: turns an entity by a per-axis delta, composed by modular integer addition
 * (ADR 0007), about its own origin (`transform.positionMm`, which doesn't change). Undo subtracts the
 * same delta, which restores the triple exactly. A mounted device (`mounted`) or a connector in an
 * entry (`in-entry`) can't turn, and nothing may turn into another entity's body (`overlaps`, the
 * `mounting` scope `entity.move` uses; decided before the v3 freeze, ADR 0015 F3.5 part 1 note 1).
 */
export function entityRotateCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EntityRotateArgs, World>({
    id: 'entity.rotate',
    title: 'Rotate object',
    category: 'Entity',
    args: EntityRotateArgs,
    undoable: true,
    run: ({ state }, { id, deltaMdeg }) => {
      const entity = findEntity(state, id);
      if (!entity) return notFound(id);
      if (entity.mountedOn !== null) return fail('mounted', `Entity ${id} is mounted: it can't be rotated`);
      if (entity.inEntry !== null) return inEntryFailure(entity);
      if (entity.pluggedInto !== null) return pluggedFailure(entity);
      const hold = entityHold(state, id);
      if (hold !== null) return holdFailure(hold, id);
      const turned = {
        positionMm: entity.transform.positionMm,
        orientationMdeg: rotateBy(entity.transform.orientationMdeg, deltaMdeg, 1),
      };
      const overlaps = checkOverlap(state, catalog, entity.ref, turned, entity.mountedOn, id, entity.state);
      if (overlaps) return overlaps;
      const turn = (sign: 1 | -1) => (w: World) => ({
        ...w,
        entities: withEntity(w.entities, id, (e) => ({
          ...e,
          transform: { ...e.transform, orientationMdeg: rotateBy(e.transform.orientationMdeg, deltaMdeg, sign) },
        })),
      });
      return succeed({ apply: turn(1), invert: turn(-1) });
    },
  });
}

/** `entity.rotate` against the built-in catalogue. */
export const entityRotate = entityRotateCommand();

/** Binding id of the Delete key: `entity.delete` with `id` taken from the selection (F1.7). */
export const ENTITY_DELETE_SELECTION_BINDING = 'entity.delete.selection';

/**
 * `entity.delete`: removes an entity and every test lead with an end on it (plan F2.1: deleting
 * never leaves a lead in the world to be silently compiled), and unlands every conductor end on it
 * (ADR 0015: a free rest waypoint where the terminal was, for a single conductor), in the same change.
 * World v4: a receptacle's plugs come out with it (each plugged entity's `pluggedInto` becomes `null`),
 * and an appliance's own plug goes with it. Otherwise an occupied entity can't go (`occupied`).
 * `nextEntityId` is untouched, so the id is never handed out again while undo can bring the entity
 * back; undo reinserts it, its leads and its conductors with the same ids and data, terminations
 * included, and plugs back in what it unplugged. Delete (or Backspace) in the viewport deletes the selected
 * entity: the binding takes `id` from the `selection.entityId` context key, so the log holds the
 * concrete id.
 */
export function entityDeleteCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EntityDeleteArgs, World>({
    id: 'entity.delete',
    title: 'Delete object',
    category: 'Entity',
    args: EntityDeleteArgs,
    undoable: true,
    bindings: [
      {
        id: ENTITY_DELETE_SELECTION_BINDING,
        title: 'Delete the selected object',
        category: 'Entity',
        target: { kind: 'command', command: 'entity.delete', args: {}, contextArgs: { id: SELECTION_ENTITY_ID_KEY } },
        defaults: ['Delete', 'Backspace'],
        // Not while a route is started (F3.2 part 3): there Backspace is `routing.back`, and the
        // selection is the device being wired. With a spool merely armed, Delete still deletes.
        when: `${VIEWPORT_FOCUSED_KEY} && ${SELECTION_ENTITY_ID_KEY} && !${ROUTING_STARTED_KEY}`,
      },
    ],
    run: ({ state }, { id }) => {
      const entity = findEntity(state, id);
      if (!entity) return notFound(id);
      // A receptacle holding plugs isn't held by them: deleting it unplugs each (world v4, ADR 0019).
      if (entityOccupied(state, id, { plugs: false })) return holdFailure('occupied', id);
      const unplugged = state.entities.filter((e) => e.pluggedInto?.entity === id);
      const unpluggedIds = new Set(unplugged.map((e) => e.id));
      const unplug = (entities: readonly Entity[]) =>
        unplugged.length === 0
          ? [...entities]
          : entities.map((e) => (unpluggedIds.has(e.id) ? { ...e, pluggedInto: null } : e));
      const replug = (entities: readonly Entity[]) =>
        unplugged.length === 0
          ? [...entities]
          : entities.map((e) => {
              const was = unplugged.find((u) => u.id === e.id);
              return was ? { ...e, pluggedInto: was.pluggedInto } : e;
            });
      const leads = state.connections.filter((c) => isLead(c) && touchesEntity(c, id));
      const wired = state.connections.filter((c) => !isLead(c) && touchesEntity(c, id));
      const unlanded = new Map<number, Connection>();
      for (const wire of wired) {
        let next: Connection | null = wire;
        for (const end of ['a', 'b'] as const) {
          if (next !== null && next[end]?.entity === id) next = unlandEnd(state, catalog, next, end);
        }
        if (next === null)
          return fail('wired', `The catalogue can't place where wire ${wire.id} lands on entity ${id}`);
        unlanded.set(wire.id, next);
      }
      const leadIds = new Set(leads.map((c) => c.id));
      const untouched = leads.length === 0 && unlanded.size === 0;
      const restored = new Map(wired.map((c) => [c.id, c]));
      return succeed({
        apply: (w) => ({
          ...w,
          entities: unplug(withoutEntity(w.entities, id)),
          connections: untouched
            ? w.connections
            : w.connections.filter((c) => !leadIds.has(c.id)).map((c) => unlanded.get(c.id) ?? c),
        }),
        invert: (w) => ({
          ...w,
          entities: insertSorted(replug(w.entities), entity),
          connections: untouched
            ? w.connections
            : insertAllSorted(
                w.connections.map((c) => restored.get(c.id) ?? c),
                leads,
              ),
        }),
      });
    },
  });
}

/** `entity.delete` against the built-in catalogue. */
export const entityDelete = entityDeleteCommand();

/** The entity commands, in a fixed order, resolving refs against `catalog`. */
export function entityCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [
    entityPlaceCommand(catalog),
    entityMoveCommand(catalog),
    entityRotateCommand(catalog),
    entityDeleteCommand(catalog),
  ];
}
