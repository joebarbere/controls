import { type Catalog, conduitTradeSize, racewayPorts } from '@controls/catalog';
import { entityPointMm, rotateQuarterTurns } from '../snap/quarter-turn';
import { entryOpen } from '../wiring/checks';
import type { EntityId, World } from '../types';
import { same, UNIT } from './vec';

/*
 * Which enclosure entry a conduit connector is in, **derived, never stored** (ADR 0017, deciding the
 * F3.5 part 2 question; storage, if any, is F3.4 part 2's `wire.pull`). A connector is in an entry
 * exactly when, in integer world geometry:
 *
 * 1. its `entry` port's point is the entry's world point,
 * 2. that port points along the entry's inward axis,
 * 3. their trade sizes are equal, and
 * 4. the entry is open (its `openEntries` bit is set).
 *
 * The three cases the save-format caveats call ambiguous each get one answer:
 * (a) **two connectors on one entry** (a script's `entity.place` allows it): the lowest entity id is
 *     in it; the others are in no entry;
 * (b) **a connector at a closed entry, or at one of another trade size**: in no entry (rules 3, 4);
 * (c) **an enclosure moved away from its connectors**: in no entry (rule 1).
 *
 * Routing reads this only to **propose** (where a pulled run meets a box); a logged route carries its
 * waypoints explicitly and no command reads it, so the rule can't change what a log replays to.
 */

/** A connector's place: the enclosure and the catalogue id of the entry it is in. */
export interface ConnectorEntry {
  readonly connector: EntityId;
  readonly enclosure: EntityId;
  readonly entry: string;
}

/** Every connector that is in an entry (see the module comment), in connector id order. */
export function connectorEntries(world: Pick<World, 'entities'>, catalog: Catalog): ConnectorEntry[] {
  const taken = new Set<string>();
  const found: ConnectorEntry[] = [];
  const connectors = world.entities.filter((e) => catalog.device(e.ref)?.model.kind === 'raceway.conduitConnector');
  for (const connector of [...connectors].sort((p, q) => p.id - q.id)) {
    const device = catalog.device(connector.ref);
    if (!device) continue;
    const port = racewayPorts(device, connector.state).find((p) => p.kind === 'entry');
    const size = conduitTradeSize(device);
    if (!port || size === null) continue;
    const point = entityPointMm(connector.transform, port.positionMm);
    const axis = rotateQuarterTurns(connector.transform.orientationMdeg, UNIT[port.axis]);
    if (point === null || axis === null) continue;
    let match: ConnectorEntry | null = null;
    for (const host of world.entities) {
      const enclosure = catalog.device(host.ref)?.enclosure;
      if (!enclosure) continue;
      for (const [index, entry] of enclosure.entries.entries()) {
        if (entry.tradeSize !== size || !entryOpen(host, index)) continue;
        const at = entityPointMm(host.transform, entry.positionMm);
        const inward = rotateQuarterTurns(host.transform.orientationMdeg, UNIT[entry.axis]);
        if (at === null || inward === null || !same(at, point) || !same(inward, axis)) continue;
        const key = `${host.id}:${entry.id}`;
        if (taken.has(key)) continue;
        match = { connector: connector.id, enclosure: host.id, entry: entry.id };
        break;
      }
      if (match) break;
    }
    if (match) {
      taken.add(`${match.enclosure}:${match.entry}`);
      found.push(match);
    }
  }
  return found;
}

/** The entry connector `id` is in, or `null` (not a connector, or in no entry). */
export function connectorEntry(world: Pick<World, 'entities'>, catalog: Catalog, id: EntityId): ConnectorEntry | null {
  return connectorEntries(world, catalog).find((c) => c.connector === id) ?? null;
}
