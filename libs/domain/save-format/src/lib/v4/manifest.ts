import * as z from 'zod';
import { Extensions, Int, SemVer } from '../primitives';
import { CTRL_FORMAT } from '../v1/manifest';

/*
 * PROVISIONAL until v0.5.0 ships: schemaVersion 4 (ADR 0019). After that it is frozen; add
 * `v5/manifest.ts` and a v4 → v5 migration instead.
 */

/**
 * `manifest.json` in a `.ctrl` save, schemaVersion 4: v3's manifest with `schemaVersion` 4 (an
 * identity step: the one-version rule bumps every document together, ADR 0019).
 */
export const ManifestV4 = z
  .strictObject({
    format: z.literal(CTRL_FORMAT),
    schemaVersion: z.literal(4),
    /** `APP_VERSION` from `@controls/units` of the build that wrote the save. */
    appVersion: SemVer,
    /** Version of the catalogue the save's references resolve against; 0 = written before the catalogue (P1). */
    catalogVersion: Int.min(0),
    /** `SIM_ENGINE_VERSION` of the build that wrote the save (decision D8); 0 = before the sim engine. */
    simEngineVersion: Int.min(0),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls save manifest, schemaVersion 4',
    description:
      'manifest.json in a .ctrl save (ADR 0004, ADR 0013, ADR 0015, ADR 0019). Zod in @controls/save-format is authoritative.',
  });
export type ManifestV4 = z.infer<typeof ManifestV4>;
