import * as z from 'zod';
import { Extensions, Int, SemVer } from '../primitives';
import { CTRL_FORMAT } from '../v1/manifest';

/*
 * PROVISIONAL until v0.4.0 ships: schemaVersion 3 (ADR 0015). After that it is frozen; add
 * `v4/manifest.ts` and a v3 → v4 migration instead.
 */

/**
 * `manifest.json` in a `.ctrl` save, schemaVersion 3: v2's manifest with `schemaVersion` 3 (an
 * identity step: the one-version rule bumps every document together, ADR 0015).
 */
export const ManifestV3 = z
  .strictObject({
    format: z.literal(CTRL_FORMAT),
    schemaVersion: z.literal(3),
    /** `APP_VERSION` from `@controls/units` of the build that wrote the save. */
    appVersion: SemVer,
    /** Version of the catalogue the save's references resolve against; 0 = written before the catalogue (P1). */
    catalogVersion: Int.min(0),
    /** `SIM_ENGINE_VERSION` of the build that wrote the save (decision D8); 0 = before the sim engine. */
    simEngineVersion: Int.min(0),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls save manifest, schemaVersion 3',
    description:
      'manifest.json in a .ctrl save (ADR 0004, ADR 0013, ADR 0015). Zod in @controls/save-format is authoritative.',
  });
export type ManifestV3 = z.infer<typeof ManifestV3>;
