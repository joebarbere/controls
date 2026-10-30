import { z } from 'zod';
import { Extensions, Int, SemVer } from '../primitives';
import { CTRL_FORMAT } from '../v1/manifest';

/*
 * FROZEN once v0.3.0 ships: schemaVersion 2 (ADR 0013). After that, add `v3/manifest.ts` and a
 * v2 → v3 migration instead.
 */

/**
 * `manifest.json` in a `.ctrl` save, schemaVersion 2: v1 plus `simEngineVersion` (decision D8). Still
 * no timestamp: the container's bytes must be deterministic.
 */
export const ManifestV2 = z
  .strictObject({
    format: z.literal(CTRL_FORMAT),
    schemaVersion: z.literal(2),
    /** `APP_VERSION` from `@controls/units` of the build that wrote the save. */
    appVersion: SemVer,
    /** Version of the device catalogue the save's references resolve against; 0 = written before the catalogue (P1). */
    catalogVersion: Int.min(0),
    /**
     * `SIM_ENGINE_VERSION` of the build that wrote the save (decision D8, ADR 0011 §12): bumped
     * whenever snapshot or world goldens are re-pinned for numeric reasons. 0 = written before the sim
     * engine existed (a migrated v1 save), so it holds no sim state.
     */
    simEngineVersion: Int.min(0),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls save manifest, schemaVersion 2',
    description: 'manifest.json in a .ctrl save (ADR 0004, ADR 0013). Zod in @controls/save-format is authoritative.',
  });
export type ManifestV2 = z.infer<typeof ManifestV2>;
