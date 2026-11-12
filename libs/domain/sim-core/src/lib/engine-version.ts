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
 * - 4: F2.4, the power sources. The battery's EMF follows its state of charge (12.9 V when full, never
 *   the nominal 12 V placeholder) and it discharges; the battery and supplies publish device records.
 * - 5: F2.5, the first loads. The lamp has a filament model (tungsten R(T), heated and cooled), so an
 *   island holding one is solved where engine 4 left it unmodelled; the lamp, resistor and heater
 *   publish device records, and a heating filament re-solves within the step.
 * - 6: the lamp's filament also loses heat by conduction into its two lead-ins (the end loss,
 *   `LAMP_CONDUCTION_FRACTION`), so a switched-off lamp cools in seconds rather than minutes. A lit
 *   lamp settles a little hotter above its rated voltage (about 4 K at 12.84 V on a 12 V lamp) and a
 *   little cooler below it; at rated voltage it is unchanged.
 * - 7 (F3.6 part 1, **provisional until v0.4.0**, ADR 0018 §12): the connection thermal bank. Leads
 *   (D2) and conductors heat with I²R and cool to the 20 °C ambient on the fixed 10 ms schedule; each
 *   landed conductor end has a termination hot spot; a connection's solve-time value follows its
 *   temperatures (R(T), and the ends' constriction resistance). Every scenario with a lead moves.
 *   Later P3 PRs that change engine-7 behaviour re-pin in place (no 7 → 7′), until v0.4.0 freezes it.
 */
export const SIM_ENGINE_VERSION = 7;
