/**
 * The sim engine's version, written into every save's manifest as `simEngineVersion` (decision D8,
 * ADR 0011 §12, ADR 0013). Bump it whenever snapshot or world goldens are re-pinned for numeric
 * reasons (a solver, a device model or a constant changes what the engine computes). A save from
 * another engine version loads `world.json` as saved with a restarted log (`engine-changed`, F2.3a),
 * never refused. 0 means "written before the engine existed" (a migrated v1 save); 1 is the first
 * engine (P2), and it may move freely until v0.3.0 ships.
 */
export const SIM_ENGINE_VERSION = 1;
