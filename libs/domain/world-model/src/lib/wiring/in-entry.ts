import { type BodyState, type Catalog, conduitTradeSize, racewayPorts } from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { findEntity } from '../entity-commands';
import { UNIT } from '../routing/vec';
import { entityPointMm, rotateQuarterTurns } from '../snap/quarter-turn';
import type { CatalogRef, Entity, EntityId, InEntry, OrientationMdeg, PositionMm, World } from '../types';
import { cablesInEntry, entryOpen } from './checks';

/*
 * Which enclosure entry a conduit connector is in (ADR 0015 F3.4 part 2 implementation note 4, the
 * pre-freeze decision): **stored** on the connector as `inEntry: { entity, entry } | null`, logged by
 * `entity.place` (default `null`), never derived after the fact. A connector is placed in an entry
 * only when, in exact integer quarter-turn geometry:
 *
 * 1. it is a conduit connector (`raceway.conduitConnector`; `not-a-connector`) and not also mounted
 *    (`mount-mismatch`);
 * 2. the host exists (`not-found`), is an enclosure (`not-an-enclosure`) with that entry
 *    (`unknown-entry`), opened (`entry-closed`), of the connector's trade size (`wrong-size`);
 * 3. both are at quarter-turns (`not-axis-aligned`), and the connector's `entry` port is exactly the
 *    entry's world point, pointing along the entry's inward axis (`off-entry`);
 * 4. no other connector is in the entry, and the entry has room: connectors and cable ends together
 *    at most its `maxCables` (`entry-full`).
 *
 * The connector then can't move or turn (`in-entry`), and its enclosure is `occupied`. The load check
 * (`checkWorldReferences`) re-runs this check on every stored relation.
 */

/** How many entities are in `entry` of entity `id` (stored `inEntry`; at most one in a valid world). */
export function connectorsInEntry(entities: readonly Entity[], id: EntityId, entry: string): number {
  let count = 0;
  for (const e of entities) if (e.inEntry?.entity === id && e.inEntry.entry === entry) count++;
  return count;
}

/** What uses `entry` of entity `id`: its cable ends plus the connector in it. */
export function entryUse(world: Pick<World, 'entities' | 'cables'>, id: EntityId, entry: string): number {
  return cablesInEntry(world.cables, id, entry) + connectorsInEntry(world.entities, id, entry);
}

/**
 * Whether conduit connector `ref`, at `transform` with commanded `state`, may be in `inEntry` (see the
 * module comment); `self` is the connector's own id when re-checking a placed one (the load check),
 * whose own relation doesn't count towards `entry-full`. `null` when it may.
 */
export function checkInEntry(
  world: Pick<World, 'entities' | 'cables'>,
  catalog: Catalog,
  ref: CatalogRef,
  transform: { readonly positionMm: PositionMm; readonly orientationMdeg: OrientationMdeg },
  state: BodyState,
  inEntry: InEntry,
  self: EntityId | null,
): CommandFailure | null {
  const device = catalog.device(ref);
  const port = device ? racewayPorts(device, state).find((p) => p.kind === 'entry') : undefined;
  const size = device ? conduitTradeSize(device) : null;
  if (!device || device.model.kind !== 'raceway.conduitConnector' || !port || size === null) {
    return fail('not-a-connector', `${ref.id} is not a conduit connector: only a connector goes in an entry`);
  }
  const host = findEntity(world, inEntry.entity);
  if (!host) return fail('not-found', `No entity with id ${inEntry.entity}`);
  const enclosure = catalog.device(host.ref)?.enclosure;
  if (!enclosure) return fail('not-an-enclosure', `Entity ${inEntry.entity} is not an enclosure`);
  const index = enclosure.entries.findIndex((e) => e.id === inEntry.entry);
  if (index < 0) return fail('unknown-entry', `Entity ${inEntry.entity} has no entry "${inEntry.entry}"`);
  const where = `Entry "${inEntry.entry}" of entity ${inEntry.entity}`;
  if (!entryOpen(host, index)) return fail('entry-closed', `${where} is closed`);
  const entry = enclosure.entries[index];
  if (entry.tradeSize !== size) {
    return fail('wrong-size', `${where} is ${entry.tradeSize ?? 'not'} a trade size; the connector is ${size} in`);
  }
  const at = entityPointMm(host.transform, entry.positionMm);
  const inward = rotateQuarterTurns(host.transform.orientationMdeg, UNIT[entry.axis]);
  const point = entityPointMm(transform, port.positionMm);
  const axis = rotateQuarterTurns(transform.orientationMdeg, UNIT[port.axis]);
  if (at === null || inward === null || point === null || axis === null) {
    return fail('not-axis-aligned', `The connector and entity ${inEntry.entity} must be at quarter-turns`);
  }
  const same = (p: PositionMm, q: PositionMm) => p.x === q.x && p.y === q.y && p.z === q.z;
  if (!same(at, point) || !same(inward, axis)) {
    return fail('off-entry', `The connector's entry end isn't at ${where.toLowerCase()}, pointing in`);
  }
  const others = world.entities.filter(
    (e) => e.id !== self && e.inEntry?.entity === inEntry.entity && e.inEntry.entry === inEntry.entry,
  );
  if (others.length > 0) return fail('entry-full', `${where} already holds connector ${others[0].id}`);
  if (cablesInEntry(world.cables, inEntry.entity, inEntry.entry) + 1 > entry.maxCables) {
    return fail('entry-full', `${where} takes ${entry.maxCables} cable(s) or connector(s)`);
  }
  return null;
}
