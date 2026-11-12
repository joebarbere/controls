import type { ManifestV2 } from '../v2/manifest';
import type { ReplayEntryV2, ReplayLogV2 } from '../v2/replay-log';
import type { WorldV2 } from '../v2/world';
import type { ManifestV3 } from './manifest';
import type { ReplayEntryV3, ReplayLogV3 } from './replay-log';
import type { WorldV3 } from './world';

/*
 * The v2 → v3 migration steps (ADR 0015). Pure and total: each returns a new document and never
 * mutates its argument (the tests deep-freeze it and run each step twice). Kept forever. They don't
 * read the catalogue.
 *
 * - World: the new counters start at 1 and there are no cables; each entity is unmounted and
 *   unlabelled; each connection (every v2 connection is a test lead, or a ref the catalogue doesn't
 *   know) becomes lead-shaped, with clip ends (`termination: null`), an empty commanded bag and the
 *   lead kind's initial sim bag.
 * - Replay log: its initial world migrated as above; each `entity.place` entry without its own
 *   `mountedOn` gains `mountedOn: null` (what a v3 bus logs). Every other entry is copied verbatim; an
 *   entry that doesn't fit is copied and fails at replay, as before.
 * - Manifest: `schemaVersion` 3, everything else kept.
 */

/**
 * The `lead` model kind's initial sim bag at schemaVersion 3: ADR 0015's ten connection keys at their
 * initial values, held here as a frozen literal so this step never depends on the catalogue (a later
 * catalogue may change the lead kind's keys; this step must not move). While v3 is current a parity
 * test in `@controls/catalog` (`lead.spec.ts`) requires it to equal `initialBags(MODEL_KINDS.lead).sim`.
 */
export const LEAD_SIM_BAG_V3: Readonly<Record<string, number | boolean | string | null>> = Object.freeze({
  conductorTempK: null,
  endADegradation: 1,
  endAState: 'ok',
  endATempK: null,
  endATerminationId: null,
  endBDegradation: 1,
  endBState: 'ok',
  endBTempK: null,
  endBTerminationId: null,
  insulationDamaged: false,
});

export function worldV2ToV3(world: WorldV2): WorldV3 {
  return {
    ...world,
    schemaVersion: 3,
    nextCableId: 1,
    nextTerminationId: 1,
    entities: world.entities.map((entity) => ({ ...entity, mountedOn: null, label: null })),
    connections: world.connections.map((connection) => ({
      id: connection.id,
      ref: connection.ref,
      a: { ...connection.a, termination: null },
      b: { ...connection.b, termination: null },
      cable: null,
      route: null,
      lengthMm: null,
      colour: null,
      label: null,
      state: {},
      sim: { ...LEAD_SIM_BAG_V3 },
      extensions: connection.extensions,
    })),
    cables: [],
  };
}

export function manifestV2ToV3(manifest: ManifestV2): ManifestV3 {
  return { ...manifest, schemaVersion: 3 };
}

/** An `entity.place` entry gains `mountedOn: null` unless its args already have their own `mountedOn`. */
export function replayEntryV2ToV3(entry: ReplayEntryV2): ReplayEntryV3 {
  if (entry.id !== 'entity.place' || Object.prototype.hasOwnProperty.call(entry.args, 'mountedOn')) return entry;
  return { ...entry, args: { ...entry.args, mountedOn: null } };
}

export function replayLogV2ToV3(log: ReplayLogV2): ReplayLogV3 {
  return {
    ...log,
    schemaVersion: 3,
    initialWorld: worldV2ToV3(log.initialWorld),
    entries: log.entries.map(replayEntryV2ToV3),
  };
}
