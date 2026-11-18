import { regionProfile } from '@controls/catalog';
import { deriveStream, entityPurposeStreamKey } from '@controls/world-model';
import type { SimDevice } from '../lib/engine/device-model';

/*
 * Helpers for specs that build a bank by hand (`model.bank([...])`) rather than through the engine.
 * Specs only.
 */

/**
 * The `SimDevice` fields engine 8 added (`parts`, the region's `protection`, `purposeStream`) for a
 * hand-built device: entity `entity` under `seed`, its branches' parts `parts` (in branch order).
 */
export function deviceExtras(
  seed: number,
  entity: number,
  parts: readonly string[] = [],
): Pick<SimDevice, 'parts' | 'protection' | 'purposeStream'> {
  return {
    parts,
    protection: regionProfile('nec').protection,
    purposeStream: (purpose) => deriveStream(seed, entityPurposeStreamKey(entity, purpose)),
  };
}
