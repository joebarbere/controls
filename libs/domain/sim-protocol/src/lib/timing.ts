/*
 * The transport's timing and sizing constants (ADR 0011 §2). Every one is a numerical or a
 * game-design choice about how the sim is paced, published and supervised, never an electrical
 * value, so none of them reaches the engine, a snapshot's hashed bytes or a save. The engine's own
 * constants (`TICK_S`, `SOLVE_INTERVAL_TICKS`) live in `sim-core`; the time commands' bounds
 * (`SIM_SPEEDS`, `MAX_STEP_TICKS`, `DEFAULT_STEP_TICKS`) in `@controls/commands`.
 */

/** Numerical choice: the main thread's pacing loop period, under a frame and cheap. */
export const PACE_INTERVAL_MS = 10;

/**
 * Numerical choice: the most wall time, per unit of speed, the commanded tick may run ahead of the
 * worker's progress. At least 2 × {@link PACE_INTERVAL_MS}, or 60× could never be reached.
 */
export const MAX_LEAD_WALL_MS = 25;

/** Numerical choice: the worker yields to its message queue at least this often. */
export const WORK_SLICE_MS = 8;

/** Numerical choice: the throttle on the worker's cadence publishes (F2.3b kept 4; 8 was tried, see the caveats). */
export const PUBLISH_MIN_WALL_MS = 4;

/** Numerical choice: seqlock attempts per slot before a read counts as a miss (ADR 0011 §6.2). */
export const MAX_READ_ATTEMPTS = 4;

/** Spec §4.1: panels sample the snapshot at this rate by default. */
export const PANEL_SAMPLE_HZ = 10;

/** Spec §4.1: the most a panel may sample. */
export const MAX_PANEL_SAMPLE_HZ = 30;

/** Numerical choice: no publish for this long while the target is ahead of progress is a crash (§10). */
export const WATCHDOG_MS = 3_000;

/** Numerical choice: a generation needing a bigger slot than this is `error {code: 'capacity'}`. */
export const MAX_SLOT_BYTES = 64 * 1024 * 1024;

/** Numerical choice: the deadline of a `state` or `snapshot` query. */
export const STATE_QUERY_TIMEOUT_MS = 5_000;

/** Numerical choice: the most the quit flush, a replace or a teardown waits for pending queries. */
export const SIM_SETTLE_MS = 1_000;

/** Numerical choice: an autosave is skipped while the worker is further behind than this, in wall time. */
export const AUTOSAVE_MAX_BEHIND_MS = 2_000;

/** Game-design choice: `tripped` and `blown` toasts are coalesced per entity over this window. */
export const EVENT_TOAST_COALESCE_MS = 2_000;

/** The effective-speed window (ADR 0011 §2): Δtick ÷ Δwall over this much wall time. */
export const EFFECTIVE_SPEED_WINDOW_MS = 1_000;

/** "Falling behind" is raised below this fraction of the requested speed for two windows in a row. */
export const BEHIND_RAISE_RATIO = 0.9;

/** …and cleared after one window at this fraction or better (hysteresis, so it doesn't flicker). */
export const BEHIND_CLEAR_RATIO = 0.97;
