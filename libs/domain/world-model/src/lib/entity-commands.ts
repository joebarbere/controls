import {
  type AnyCommandDef,
  defineCommand,
  entityRefMeta,
  fail,
  SELECTION_ENTITY_ID_KEY,
  succeed,
  VIEWPORT_FOCUSED_KEY,
} from '@controls/commands';
import { BUILTIN_CATALOG, type Catalog, initialBags } from '@controls/catalog';
import {
  CatalogRef,
  Int,
  MILLIDEGREES_PER_TURN,
  MountId,
  OrientationMdegV1,
  PositionMmV1,
} from '@controls/save-format';
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
 * World v3 (ADR 0015): `entity.place` takes `mountedOn` (default `null`) and a new entity is unmounted
 * and unlabelled. Until the world v3 commands land (P3 PR 8: mount checks, sliding along a mount,
 * unlanding on delete), anything that would leave a v3 world invalid is refused instead: a non-null
 * `mountedOn` (`mounting-unavailable` once the host and mount check out), moving, rotating or
 * deleting an entity something is mounted on, a cable enters or a route is hosted by (`occupied`),
 * moving or rotating a mounted device (`mounted`), and moving, rotating or deleting an entity with a
 * landed conductor end (`wired`). Test leads behave exactly as in v2.
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

export const EntityPlaceArgs = z.strictObject({
  ref: CatalogRef,
  positionMm: PositionMmV1,
  orientationMdeg: OrientationMdegV1.default(() => ({ yaw: 0, pitch: 0, roll: 0 })),
  /** World v3 (ADR 0015): `null` (the default) places it free-standing. Logged explicitly, as `null` too. */
  mountedOn: MountedOnArg.nullable().default(null).meta({ title: 'Mounted on' }),
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

export function findEntity(world: World, id: EntityId): Entity | undefined {
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
 * Why entity `id` can't move, turn or go (until P3 PR 8's wiring commands refine these), or `null`:
 * `occupied` (a device is mounted on it, a cable end is in one of its entries, or a route waypoint
 * names it), `wired` (a conductor end is landed on it).
 */
export function entityHold(world: World, id: EntityId): 'occupied' | 'wired' | null {
  if (world.entities.some((e) => e.mountedOn?.entity === id)) return 'occupied';
  if (world.cables.some((c) => c.a?.entity === id || c.b?.entity === id || c.route.some((w) => w.entity === id))) {
    return 'occupied';
  }
  if (world.connections.some((c) => c.route?.some((w) => w.entity === id))) return 'occupied';
  if (world.connections.some((c) => !isLead(c) && touchesEntity(c, id))) return 'wired';
  return null;
}

function holdFailure(hold: 'occupied' | 'wired', id: EntityId) {
  return hold === 'occupied'
    ? fail('occupied', `Entity ${id} holds a mounted device, a cable end or a route`)
    : fail('wired', `Entity ${id} has a conductor landed on it: unland it first`);
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
      if (args.mountedOn !== null) {
        const mountedOn = args.mountedOn;
        const host = findEntity(state, mountedOn.entity);
        if (!host) return notFound(mountedOn.entity);
        const mount = catalog.device(host.ref)?.enclosure?.mounts.find((m) => m.id === mountedOn.mount);
        if (!mount) return fail('unknown-mount', `Entity ${mountedOn.entity} has no mount "${mountedOn.mount}"`);
        if (!catalog.device(args.ref)?.mounts.some((m) => m.type === mount.type)) {
          return fail('mount-mismatch', `${args.ref.id} does not fit a ${mount.type} mount`);
        }
        return fail('mounting-unavailable', 'Mounting on an enclosure arrives with the world v3 commands');
      }
      const bags = kind ? initialBags(kind) : { state: {}, sim: {} };
      const entity: Entity = {
        id,
        ref: { ...args.ref },
        transform: { positionMm: { ...args.positionMm }, orientationMdeg: { ...args.orientationMdeg } },
        state: bags.state,
        sim: bags.sim,
        mountedOn: null,
        label: null,
        extensions: {},
      };
      return succeed({
        // The new id is above every existing one, so appending keeps the order.
        apply: (w) => ({ ...w, nextEntityId: id + 1, entities: [...w.entities, entity] }),
        invert: (w) => ({ ...w, nextEntityId: id, entities: withoutEntity(w.entities, id) }),
      });
    },
  });
}

/** `entity.move`: sets an entity's position (absolute, integer mm). Undo restores the old one. */
export const entityMove = defineCommand<EntityMoveArgs, World>({
  id: 'entity.move',
  title: 'Move object',
  category: 'Entity',
  args: EntityMoveArgs,
  undoable: true,
  run: ({ state }, { id, positionMm }) => {
    const entity = findEntity(state, id);
    if (!entity) return notFound(id);
    if (entity.mountedOn !== null) return fail('mounted', `Entity ${id} is mounted: it can't leave its mount`);
    const hold = entityHold(state, id);
    if (hold !== null) return holdFailure(hold, id);
    const before = entity.transform.positionMm;
    const after = { ...positionMm };
    const setPosition = (position: typeof after) => (w: World) => ({
      ...w,
      entities: withEntity(w.entities, id, (e) => ({ ...e, transform: { ...e.transform, positionMm: position } })),
    });
    return succeed({ apply: setPosition(after), invert: setPosition(before) });
  },
});

/**
 * `entity.rotate`: turns an entity by a per-axis delta, composed by modular integer addition
 * (ADR 0007). Undo subtracts the same delta, which restores the triple exactly.
 */
export const entityRotate = defineCommand<EntityRotateArgs, World>({
  id: 'entity.rotate',
  title: 'Rotate object',
  category: 'Entity',
  args: EntityRotateArgs,
  undoable: true,
  run: ({ state }, { id, deltaMdeg }) => {
    const entity = findEntity(state, id);
    if (!entity) return notFound(id);
    if (entity.mountedOn !== null) return fail('mounted', `Entity ${id} is mounted: it can't be rotated`);
    const hold = entityHold(state, id);
    if (hold !== null) return holdFailure(hold, id);
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

/** Binding id of the Delete key: `entity.delete` with `id` taken from the selection (F1.7). */
export const ENTITY_DELETE_SELECTION_BINDING = 'entity.delete.selection';

/**
 * `entity.delete`: removes an entity and every connection with an end on it (plan F2.1: deleting
 * never leaves a lead in the world to be silently compiled). `nextEntityId` is untouched, so the id
 * is never handed out again while undo can bring the entity back; undo reinserts it, and its
 * connections, with the same ids and data. Delete (or Backspace) in the viewport deletes the selected
 * entity: the binding takes `id` from the `selection.entityId` context key, so the log holds the
 * concrete id.
 */
export const entityDelete = defineCommand<EntityDeleteArgs, World>({
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
      when: `${VIEWPORT_FOCUSED_KEY} && ${SELECTION_ENTITY_ID_KEY}`,
    },
  ],
  run: ({ state }, { id }) => {
    const entity = findEntity(state, id);
    if (!entity) return notFound(id);
    const hold = entityHold(state, id);
    if (hold !== null) return holdFailure(hold, id);
    // Only leads remain on it (a landed conductor is `wired` above).
    const removed = state.connections.filter((c) => touchesEntity(c, id));
    return succeed({
      apply: (w) => ({
        ...w,
        entities: withoutEntity(w.entities, id),
        connections: removed.length === 0 ? w.connections : w.connections.filter((c) => !touchesEntity(c, id)),
      }),
      invert: (w) => ({
        ...w,
        entities: insertSorted(w.entities, entity),
        connections: removed.length === 0 ? w.connections : insertAllSorted(w.connections, removed),
      }),
    });
  },
});

/** The entity commands, in a fixed order, resolving refs against `catalog`. */
export function entityCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [entityPlaceCommand(catalog), entityMove, entityRotate, entityDelete];
}
