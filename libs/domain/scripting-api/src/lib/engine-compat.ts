/*
 * Which saves are verified against this build's engine (decision D8, ADR 0013 Consequences): the one
 * place that decides it.
 */

/** The two versions that decide whether a save's log can be verified: a manifest's, or this build's. */
export interface EngineVersions {
  readonly simEngineVersion: number;
  readonly catalogVersion: number;
}

/**
 * What a load does with a save's replay log:
 *
 * - `verify`: the same engine and catalogue as this build: replay the log and compare;
 * - `verify-v0`: a migrated P1 save (both versions 0, no sim state): verify it, but a failure restarts
 *   the log as `engine-changed`, never `hash-mismatch` or a refusal;
 * - `engine-changed`: another engine or catalogue: don't verify; load `world.json` as saved with a new
 *   log (`replay.status: 'restarted'`, reason `engine-changed`), which the load policy never refuses.
 */
export type EngineCompatibility = 'verify' | 'verify-v0' | 'engine-changed';

/**
 * D8's rule, narrow v0 compatibility included. Pure. Same `simEngineVersion` and `catalogVersion` →
 * `verify`; both 0 (a migrated P1 save) → `verify-v0`; any other mismatch, a single 0 on its own
 * included, → `engine-changed`.
 */
export function engineCompatible(manifest: EngineVersions, build: EngineVersions): EngineCompatibility {
  if (manifest.simEngineVersion === build.simEngineVersion && manifest.catalogVersion === build.catalogVersion) {
    return 'verify';
  }
  if (manifest.simEngineVersion === 0 && manifest.catalogVersion === 0) return 'verify-v0';
  return 'engine-changed';
}
