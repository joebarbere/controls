import { regionProfile } from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey } from '@controls/world-model';
import type { SimDevice } from '../lib/engine/device-model';

/*
 * Helpers for specs that build a bank by hand (`model.bank([...])`) rather than through the engine.
 * Specs only.
 */

/**
 * The `SimDevice` fields engine 8 added (`parts`, `contacts`, `terminalNode`, the region's
 * `protection`, `purposeStream`) for a hand-built device: entity `entity` under `seed`, its branches'
 * parts `parts` (in branch order), its relation contacts and its terminals' nodes (none by default).
 */
export function deviceExtras(
  seed: number,
  entity: number,
  parts: readonly string[] = [],
  { contacts = [], nodes = {} }: { contacts?: SimDevice['contacts']; nodes?: Readonly<Record<string, number>> } = {},
): Pick<SimDevice, 'parts' | 'contacts' | 'terminalNode' | 'protection' | 'purposeStream'> {
  return {
    parts,
    contacts,
    terminalNode: (terminal) => (Object.prototype.hasOwnProperty.call(nodes, terminal) ? nodes[terminal] : -1),
    protection: regionProfile('nec').protection,
    purposeStream: (purpose) => deriveStream(seed, entityPurposeStreamKey(entity, purpose)),
  };
}
