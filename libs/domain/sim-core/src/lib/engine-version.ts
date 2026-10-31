/**
 * The sim engine's version, written into every save's manifest as `simEngineVersion` (decision D8,
 * ADR 0011 §12, ADR 0013). Bump it whenever snapshot or world goldens are re-pinned for numeric
 * reasons (a solver, a device model or a constant changes what the engine computes). A save from
 * another engine version loads `world.json` as saved with a restarted log (`engine-changed`, F2.3a),
 * never refused. 0 means "written before the engine existed" (a migrated v1 save); it may move freely
 * until v0.3.0 ships. History:
 *
 * - 1: the world v2 kickoff (P2). Nothing ran: every save's `sim` was `null`.
 * - 2: sparse LU uses plain partial pivoting (`PIVOT_THRESHOLD` 1, #51), which moved the sparse
 *   solver pins.
 * - 3: F2.3a, the engine loop. Saves and `world.hash` now hold the materialised solution record, so a
 *   world with a non-empty netlist hashes differently from what engine 1 or 2 wrote for the same log.
 */
export const SIM_ENGINE_VERSION = 3;
