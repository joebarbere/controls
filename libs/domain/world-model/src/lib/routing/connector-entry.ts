import type { EntityId, World } from '../types';

/*
 * Which enclosure entry a conduit connector is in: **stored**, read here (ADR 0015 F3.4 part 2
 * implementation note 4, the pre-freeze decision that supersedes ADR 0017 §8's derivation). A
 * connector's `inEntry` is set by `entity.place` only when `checkInEntry` (`wiring/in-entry.ts`)
 * accepts it: an open entry of its trade size, its entry end exactly at the entry pointing in, and at
 * most one connector per entry. The load check re-verifies each stored relation, and the enclosure is
 * `occupied` while the connector is in it, so the three cases ADR 0017 §8 had to answer can't arise:
 * (a) two connectors on one entry, (b) a connector at a closed or wrong-size entry, (c) an enclosure
 * moved away from its connector.
 */

/** A connector's place: the enclosure and the catalogue id of the entry it is in. */
export interface ConnectorEntry {
  readonly connector: EntityId;
  readonly enclosure: EntityId;
  readonly entry: string;
}

/** Every entity that is in an entry (its stored `inEntry`), in entity id order. */
export function connectorEntries(world: Pick<World, 'entities'>): ConnectorEntry[] {
  const found: ConnectorEntry[] = [];
  for (const e of world.entities) {
    if (e.inEntry !== null) found.push({ connector: e.id, enclosure: e.inEntry.entity, entry: e.inEntry.entry });
  }
  return found;
}

/** The entry entity `id` is in, or `null` (no such entity, or in no entry). */
export function connectorEntry(world: Pick<World, 'entities'>, id: EntityId): ConnectorEntry | null {
  return connectorEntries(world).find((c) => c.connector === id) ?? null;
}
