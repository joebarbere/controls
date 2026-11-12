import {
  BUILTIN_CATALOG,
  type Catalog,
  CUT_LENGTH_KEY,
  cutLengthMm,
  isCutToLength,
  MAX_RACEWAY_LENGTH_MM,
} from '@controls/catalog';
import { type AnyCommandDef, defineCommand, entityRefMeta, fail, succeed } from '@controls/commands';
import { Int } from '@controls/save-format';
import * as z from 'zod';
import { entityOccupied, findEntity } from '../entity-commands';
import type { Entity, World } from '../types';
import { checkMount } from './mounting';
import { checkOverlap } from './overlap';

/*
 * `raceway.cut` (F3.5 part 2): sets a cut-to-length raceway's commanded `lengthMm` (wire duct, an EMT
 * stick). The part keeps its origin, so its +x end moves. A new id, so no `schemaVersion` bump: older
 * logs never hold it. Not tool-gated in P3 (game-design: stock is cut as it is fitted; a hacksaw or
 * duct cutter may gate it later as a new argument, a save-format change while v3 is provisional).
 */

export const RacewayCutArgs = z.strictObject({
  id: Int.min(1).meta({ ...entityRefMeta, title: 'Duct or conduit' }),
  lengthMm: Int.min(1)
    .max(MAX_RACEWAY_LENGTH_MM)
    .meta({ title: 'Length (mm)', description: 'The cut length along the part, integer mm' }),
});
export type RacewayCutArgs = z.infer<typeof RacewayCutArgs>;

function withEntity(world: World, next: Entity): World {
  return { ...world, entities: world.entities.map((e) => (e.id === next.id ? next : e)) };
}

/**
 * `raceway.cut {id, lengthMm}`. Refused: no such entity (`not-found`); not a cut-to-length raceway
 * (`not-cut-to-length`); the length it already has (`same-length`); shorter than the entry's
 * `minLengthMm` or longer than its stock (`sizeMm.widthMm`) (`out-of-range`); a part that hosts a
 * route waypoint or a mounted device (`occupied`: its routes were laid against the old length); a
 * mounted part that no longer fits its mount (`off-mount`, `mount-full`); or a body that would overlap
 * another (`overlaps`, the `mounting` scope like `entity.place`). Undo restores the old length.
 */
export function racewayCutCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<RacewayCutArgs, World>({
    id: 'raceway.cut',
    title: 'Cut raceway to length',
    category: 'Raceway',
    args: RacewayCutArgs,
    undoable: true,
    run: ({ state }, { id, lengthMm }) => {
      const entity = findEntity(state, id);
      if (!entity) return fail('not-found', `No entity with id ${id}`);
      const device = catalog.device(entity.ref);
      if (!device || !isCutToLength(device) || device.sizeMm === null) {
        return fail('not-cut-to-length', `Entity ${id} is not duct or conduit cut to length`);
      }
      if (cutLengthMm(device, entity.state) === lengthMm) {
        return fail('same-length', `Entity ${id} is already ${lengthMm} mm long`);
      }
      const min = device.model.params['minLengthMm'];
      const max = device.sizeMm.widthMm;
      if (lengthMm < min || lengthMm > max) {
        return fail('out-of-range', `${device.title} is cut from ${min} mm to ${max} mm`);
      }
      if (entityOccupied(state, id)) {
        return fail('occupied', `Entity ${id} holds a route or a mounted device: clear it before cutting`);
      }
      const next: Entity = { ...entity, state: { ...entity.state, [CUT_LENGTH_KEY]: lengthMm } };
      const { positionMm, orientationMdeg } = entity.transform;
      if (entity.mountedOn !== null) {
        const refused = checkMount(
          state,
          catalog,
          entity.ref,
          positionMm,
          orientationMdeg,
          entity.mountedOn,
          id,
          next.state,
        );
        if (refused) return refused;
      }
      const overlaps = checkOverlap(state, catalog, entity.ref, entity.transform, entity.mountedOn, id, next.state);
      if (overlaps) return overlaps;
      return succeed<World>({ apply: (w) => withEntity(w, next), invert: (w) => withEntity(w, entity) });
    },
  });
}

/** The raceway commands (`raceway.cut`), resolving refs against `catalog`. */
export function racewayCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [racewayCutCommand(catalog)];
}
