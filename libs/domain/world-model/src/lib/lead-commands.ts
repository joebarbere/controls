import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { type AnyCommandDef, defineCommand, entityRefMeta, fail, succeed } from '@controls/commands';
import { CatalogRef, Int, TerminalId } from '@controls/save-format';
import { z } from 'zod';
import { terminalProblem } from './devices';
import { findEntity, insertSorted } from './entity-commands';
import type { Connection, ConnectionId, TerminalRef, World } from './types';

/*
 * Test leads (plan P2 decision D2, ADR 0013): persisted two-ended connections between device
 * terminals, made and removed only by these commands (the palette, the console and scripts in P2;
 * the mouse terminal picker is P3). Ids come from `nextConnectionId` by the entity-id rule: undoing a
 * connect restores the counter, undoing a disconnect reinserts the same id. Neither command reads
 * sim-owned state (ADR 0011 §1).
 *
 * The ids and argument shapes are save format (persisted in the replay log); their JSON Schema is
 * frozen in `json-schema/command-args/`.
 */

/** One end of a lead: an entity and one of its device's terminals. */
export const TerminalRefArg = z.strictObject({
  entity: Int.min(1).meta({ ...entityRefMeta, title: 'Entity' }),
  terminal: TerminalId.meta({ title: 'Terminal', description: 'A terminal id of that device (pos, neg, a, b, …)' }),
});

export const LeadConnectArgs = z.strictObject({
  ref: CatalogRef.meta({ title: 'Lead type', description: 'A test lead in the catalogue (lead.quillfern-test-1m)' }),
  a: TerminalRefArg.meta({ title: 'From' }),
  b: TerminalRefArg.meta({ title: 'To' }),
});
export type LeadConnectArgs = z.infer<typeof LeadConnectArgs>;

export const LeadDisconnectArgs = z.strictObject({ id: Int.min(1).meta({ title: 'Lead' }) });
export type LeadDisconnectArgs = z.infer<typeof LeadDisconnectArgs>;

/** Index of connection `id` in the sorted `connections`, or -1. */
export function findConnectionIndex(connections: readonly Connection[], id: ConnectionId): number {
  let lo = 0;
  let hi = connections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (connections[mid].id === id) return mid;
    if (connections[mid].id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function findConnection(world: World, id: ConnectionId): Connection | undefined {
  const index = findConnectionIndex(world.connections, id);
  return index < 0 ? undefined : world.connections[index];
}

const sameTerminal = (x: TerminalRef, y: TerminalRef): boolean => x.entity === y.entity && x.terminal === y.terminal;

/** Whether `connection` joins exactly the terminals `a` and `b`, in either direction. */
export function joins(connection: Connection, a: TerminalRef, b: TerminalRef): boolean {
  return (
    (sameTerminal(connection.a, a) && sameTerminal(connection.b, b)) ||
    (sameTerminal(connection.a, b) && sameTerminal(connection.b, a))
  );
}

/**
 * `lead.connect {ref, a, b}`: joins terminal `a` to terminal `b` with a test lead of type `ref`. Its
 * id is the world's `nextConnectionId`, which then increments; undo removes it and restores the
 * counter. Refused: a `ref` that isn't a lead in the catalogue (`not-a-lead`), an entity that doesn't
 * exist (`not-found`), a prop (`no-terminals`) or a device without that terminal or one the catalogue
 * doesn't know (`unknown-terminal`), the same terminal twice (`same-terminal`), and a lead between two
 * terminals already joined by one (`duplicate-lead`).
 */
export function leadConnectCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<LeadConnectArgs, World>({
    id: 'lead.connect',
    title: 'Connect a test lead',
    category: 'Lead',
    args: LeadConnectArgs,
    undoable: true,
    run: ({ state }, { ref, a, b }) => {
      if (catalog.kindOf(ref)?.placement !== 'connection') {
        return fail('not-a-lead', `${ref.id} version ${ref.version} is not a test lead in the catalogue`);
      }
      for (const end of [a, b]) {
        const entity = findEntity(state, end.entity);
        if (!entity) return fail('not-found', `No entity with id ${end.entity}`);
        const problem = terminalProblem(entity, end.terminal, catalog);
        if (problem === 'prop') return fail('no-terminals', `Entity ${end.entity} is a prop: it has no terminals`);
        if (problem !== null || !catalog.device(entity.ref)) {
          return fail('unknown-terminal', `Entity ${end.entity} has no terminal "${end.terminal}"`);
        }
      }
      if (sameTerminal(a, b)) return fail('same-terminal', 'A lead joins two different terminals');
      const existing = state.connections.find((c) => joins(c, a, b));
      if (existing) {
        return fail('duplicate-lead', `Lead ${existing.id} already joins those terminals`);
      }
      const id = state.nextConnectionId;
      if (!Number.isSafeInteger(id + 1)) return fail('ids-exhausted', 'No connection ids left in this world');
      const connection: Connection = {
        id,
        ref: { ...ref },
        a: { ...a },
        b: { ...b },
        extensions: {},
      };
      return succeed({
        // The new id is above every existing one, so appending keeps the order.
        apply: (w) => ({ ...w, nextConnectionId: id + 1, connections: [...w.connections, connection] }),
        invert: (w) => ({ ...w, nextConnectionId: id, connections: w.connections.filter((c) => c.id !== id) }),
      });
    },
  });
}

/**
 * `lead.disconnect {id}`: removes a test lead. `nextConnectionId` is untouched; undo reinserts the
 * lead with the same id and data.
 */
export const leadDisconnect = defineCommand<LeadDisconnectArgs, World>({
  id: 'lead.disconnect',
  title: 'Disconnect a test lead',
  category: 'Lead',
  args: LeadDisconnectArgs,
  undoable: true,
  run: ({ state }, { id }) => {
    const connection = findConnection(state, id);
    if (!connection) return fail('not-found', `No lead with id ${id}`);
    return succeed({
      apply: (w) => ({ ...w, connections: w.connections.filter((c) => c.id !== id) }),
      invert: (w) => ({ ...w, connections: insertSorted(w.connections, connection) }),
    });
  },
});

/** The lead commands, in a fixed order, resolving refs against `catalog`. */
export function leadCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [leadConnectCommand(catalog), leadDisconnect];
}
