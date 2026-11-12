import { BUILTIN_CATALOG, type Catalog, entryType } from '@controls/catalog';
import { type AnyCommandDef, defineCommand, fail, succeed } from '@controls/commands';
import { findEntity } from '../entity-commands';
import type { Entity, World } from '../types';
import { EnclosureOpenEntryArgs, EntityLabelArgs } from './args';
import { checkDrive, checkTool, ENTRY_BITS, entryOpen } from './checks';

/*
 * `enclosure.openEntry` and `entity.label` (ADR 0015). An enclosure's knockouts are its commanded
 * state key `openEntries` (D11), a bit set over its catalogue `entries[]` in their save-format order;
 * every entry starts closed. Labels are their own command, with a tool that can `label` (D10).
 */

function withEntity(world: World, next: Entity): World {
  return { ...world, entities: world.entities.map((e) => (e.id === next.id ? next : e)) };
}

function swap(before: Entity, after: Entity) {
  return succeed<World>({ apply: (w) => withEntity(w, after), invert: (w) => withEntity(w, before) });
}

/**
 * `enclosure.openEntry {id, entry, tool}`: opens one entry of an enclosure (a knockout, pryout, clamp
 * or drill site) with a tool that has one of the capabilities its entry type lists (`ENTRY_TYPES`).
 * Refused: not an enclosure (`not-an-enclosure`), an entry it doesn't have (`unknown-entry`), one
 * already open (`already-open`), a tool that can't open it (`unknown-tool`, `wrong-tool`), or a driver
 * whose tip doesn't fit the entry type's drives (`wrong-drive`: a nut driver can't pry a knockout).
 */
export function enclosureOpenEntryCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EnclosureOpenEntryArgs, World>({
    id: 'enclosure.openEntry',
    title: 'Open an enclosure entry',
    category: 'Enclosure',
    args: EnclosureOpenEntryArgs,
    undoable: true,
    run: ({ state }, { id, entry, tool }) => {
      const entity = findEntity(state, id);
      if (!entity) return fail('not-found', `No entity with id ${id}`);
      const enclosure = catalog.device(entity.ref)?.enclosure;
      const open = entity.state['openEntries'];
      if (!enclosure || typeof open !== 'number') return fail('not-an-enclosure', `Entity ${id} is not an enclosure`);
      const index = enclosure.entries.findIndex((e) => e.id === entry);
      if (index < 0) return fail('unknown-entry', `Entity ${id} has no entry "${entry}"`);
      if (entryOpen(entity, index)) return fail('already-open', `Entry "${entry}" of entity ${id} is already open`);
      const type = entryType(enclosure.entries[index].type);
      const opener = checkTool(catalog, tool, type?.opens ?? []);
      if (!opener.ok) return opener;
      // Opened by driving (a screwdriver blade on a knockout, pryout or clamp tab): the tip must fit.
      const steps = new Set(opener.value.capabilities.map((c) => c.step));
      const otherwise = (type?.opens ?? []).some((step) => step !== 'drive' && steps.has(step));
      if (!otherwise && type) {
        const misfit = checkDrive(opener.value, type.drives, `a ${type.id} entry`);
        if (misfit) return misfit;
      }
      return swap(entity, { ...entity, state: { ...entity.state, openEntries: open + ENTRY_BITS[index] } });
    },
  });
}

/** `entity.label {id, text, tool}`: prints a label on a device (`TB1`) with a tool that can `label`; `null` removes it. */
export function entityLabelCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<EntityLabelArgs, World>({
    id: 'entity.label',
    title: 'Label an object',
    category: 'Entity',
    args: EntityLabelArgs,
    undoable: true,
    run: ({ state }, { id, text, tool }) => {
      const entity = findEntity(state, id);
      if (!entity) return fail('not-found', `No entity with id ${id}`);
      const labeller = checkTool(catalog, tool, 'label');
      if (!labeller.ok) return labeller;
      return swap(entity, { ...entity, label: text });
    },
  });
}

/** `enclosure.openEntry` and `entity.label`, resolving refs against `catalog`. */
export function enclosureCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [enclosureOpenEntryCommand(catalog), entityLabelCommand(catalog)];
}
