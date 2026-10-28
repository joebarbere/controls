import { type AnyCommandDef, defineCommand, entityRefMeta, fail, succeed } from '@controls/commands';
import { CatalogRef, Int, MILLIDEGREES_PER_TURN, OrientationMdegV1, PositionMmV1 } from '@controls/save-format';
import { z } from 'zod';
import type { Entity, EntityId, OrientationMdeg, World } from './types';

/*
 * The world document operations (plan F1.2), as undoable commands. Each `run` validates against the
 * current world and returns an apply/invert pair; nothing mutates. Invariants kept (ADR 0007):
 * entities stay sorted by ascending id, ids come from `nextEntityId` (undoing a place restores it),
 * and undoing a delete reinserts the entity with its same id.
 *
 * The argument shapes are persisted in replay logs: changing one is a save-format change.
 */

/** An entity id. The `.meta()` hint only tells generated forms to offer the selection (F1.3). */
const EntityIdArg = Int.min(1).meta({ ...entityRefMeta, title: 'Entity' });

/** A rotation step per axis in integer millidegrees, strictly less than a full turn either way. */
const DeltaMdeg = Int.min(-(MILLIDEGREES_PER_TURN - 1)).max(MILLIDEGREES_PER_TURN - 1);

export const EntityPlaceArgs = z.strictObject({
  ref: CatalogRef,
  positionMm: PositionMmV1,
  orientationMdeg: OrientationMdegV1.default(() => ({ yaw: 0, pitch: 0, roll: 0 })),
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

/** A copy of `entities` with `entity` inserted at its sorted position (its id must be absent). */
function insertSorted(entities: readonly Entity[], entity: Entity): Entity[] {
  let index = 0;
  while (index < entities.length && entities[index].id < entity.id) index++;
  return [...entities.slice(0, index), entity, ...entities.slice(index)];
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
 * which then increments; undo removes the entity and restores the counter.
 */
export const entityPlace = defineCommand<EntityPlaceArgs, World>({
  id: 'entity.place',
  title: 'Place object',
  category: 'Entity',
  args: EntityPlaceArgs,
  undoable: true,
  run: ({ state }, args) => {
    const id = state.nextEntityId;
    if (!Number.isSafeInteger(id + 1)) return fail('ids-exhausted', 'No entity ids left in this world');
    const entity: Entity = {
      id,
      ref: { ...args.ref },
      transform: { positionMm: { ...args.positionMm }, orientationMdeg: { ...args.orientationMdeg } },
      extensions: {},
    };
    return succeed({
      // The new id is above every existing one, so appending keeps the order.
      apply: (w) => ({ ...w, nextEntityId: id + 1, entities: [...w.entities, entity] }),
      invert: (w) => ({ ...w, nextEntityId: id, entities: withoutEntity(w.entities, id) }),
    });
  },
});

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
    if (!findEntity(state, id)) return notFound(id);
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

/**
 * `entity.delete`: removes an entity. `nextEntityId` is untouched, so the id is never handed out
 * again while undo can bring the entity back; undo reinserts it with the same id and data.
 */
export const entityDelete = defineCommand<EntityDeleteArgs, World>({
  id: 'entity.delete',
  title: 'Delete object',
  category: 'Entity',
  args: EntityDeleteArgs,
  undoable: true,
  run: ({ state }, { id }) => {
    const entity = findEntity(state, id);
    if (!entity) return notFound(id);
    return succeed({
      apply: (w) => ({ ...w, entities: withoutEntity(w.entities, id) }),
      invert: (w) => ({ ...w, entities: insertSorted(w.entities, entity) }),
    });
  },
});

/** The world commands, in a fixed order. */
export function entityCommands(): AnyCommandDef<World>[] {
  return [entityPlace, entityMove, entityRotate, entityDelete];
}
