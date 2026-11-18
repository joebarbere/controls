import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { type AnyCommandDef, defineCommand, fail, succeed } from '@controls/commands';
import { findEntity } from '../entity-commands';
import type { Entity, World } from '../types';
import { PlugInsertArgs, PlugRemoveArgs } from './args';
import { checkPlugInsert } from './plug';

/*
 * `plug.insert` and `plug.remove` (world v4, ADR 0019 "Commands"; D1, D12). A plug is a relation on the
 * plugged entity (`pluggedInto`), never a transform: the appliance stays where it was placed. Neither
 * command takes a tool in P4 nor reads sim-owned state, and neither draws. Undo restores the relation
 * exactly. The check is `checkPlugInsert` (written with world v4 for the load check; called here
 * unchanged), so a world this command makes always loads.
 */

/** An undoable change of one entity's `pluggedInto` only (its bags stay the same objects, ADR 0011 §1). */
function setPlug(entity: Entity, after: Entity['pluggedInto']) {
  const before = entity.pluggedInto;
  const set = (value: Entity['pluggedInto']) => (w: World) => ({
    ...w,
    entities: w.entities.map((e) => (e.id === entity.id ? { ...e, pluggedInto: value } : e)),
  });
  return succeed<World>({ apply: set(after), invert: set(before) });
}

/**
 * `plug.insert {appliance, receptacle, outlet}`: plugs the appliance's cord into one outlet of the
 * receptacle. Refused, in `checkPlugInsert`'s order: `not-found`, `not-an-appliance`,
 * `already-plugged` (unplug first: one gesture is one command), `not-found`, `plug-cycle`,
 * `not-a-receptacle`, `unknown-outlet`, `outlet-occupied`, `wrong-configuration`, `not-axis-aligned`
 * and `out-of-reach`. Only refused versus accepted is replay format, never which code.
 */
export function plugInsertCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<PlugInsertArgs, World>({
    id: 'plug.insert',
    title: 'Plug in an appliance',
    category: 'Plug',
    args: PlugInsertArgs,
    undoable: true,
    run: ({ state }, { appliance, receptacle, outlet }) => {
      const refused = checkPlugInsert(state, catalog, { appliance, receptacle, outlet });
      if (refused) return refused;
      const entity = findEntity(state, appliance) as Entity; // exists: checked above
      return setPlug(entity, { entity: receptacle, outlet });
    },
  });
}

/**
 * `plug.remove {appliance}`: unplugs the appliance's cord. Refused: `not-found`, `not-an-appliance` (its
 * entry has no plug) and `not-plugged`.
 */
export function plugRemoveCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<PlugRemoveArgs, World>({
    id: 'plug.remove',
    title: 'Unplug an appliance',
    category: 'Plug',
    args: PlugRemoveArgs,
    undoable: true,
    run: ({ state }, { appliance }) => {
      const entity = findEntity(state, appliance);
      if (!entity) return fail('not-found', `No entity with id ${appliance}`);
      if ((catalog.device(entity.ref)?.plug ?? null) === null) {
        return fail('not-an-appliance', `${entity.ref.id} has no cord plug`);
      }
      if (entity.pluggedInto === null) return fail('not-plugged', `Entity ${appliance} isn't plugged in`);
      return setPlug(entity, null);
    },
  });
}

/** The plug commands, in a fixed order, resolving refs against `catalog`. */
export function plugCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [plugInsertCommand(catalog), plugRemoveCommand(catalog)];
}
