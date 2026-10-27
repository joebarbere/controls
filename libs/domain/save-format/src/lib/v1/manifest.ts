import { z } from 'zod';
import { Extensions, Int, SemVer } from '../primitives';

/*
 * FROZEN once v0.2.0 ships: schemaVersion 1. Never edit this file after that release; add
 * `v2/manifest.ts` and a v1 → v2 migration instead.
 */

/** Fixed marker that identifies a `.ctrl` manifest. */
export const CTRL_FORMAT = 'controls.ctrl';

/**
 * `manifest.json` in a `.ctrl` save, schemaVersion 1. No timestamp on purpose: the container's bytes
 * must be deterministic, and the file's modification time already says when it was saved.
 */
export const ManifestV1 = z
  .strictObject({
    format: z.literal(CTRL_FORMAT),
    schemaVersion: z.literal(1),
    /** `APP_VERSION` from `@controls/units` of the build that wrote the save. */
    appVersion: SemVer,
    /** Version of the device catalogue the save's references resolve against; 0 = no catalogue yet (P1). */
    catalogVersion: Int.min(0),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls save manifest, schemaVersion 1',
    description: 'manifest.json in a .ctrl save (ADR 0004). Zod in @controls/save-format is authoritative.',
  });
export type ManifestV1 = z.infer<typeof ManifestV1>;
