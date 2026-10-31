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

/** Numerical choice: the throttle on the worker's cadence publishes (ADR 0011 kept 4; 8 is untried). */
export const PUBLISH_MIN_WALL_MS = 4;

/** Numerical choice: seqlock attempts per slot before a read counts as a miss (ADR 0011 §6.2). */
export const MAX_READ_ATTEMPTS = 4;

/** Spec §4.1: panels sample the snapshot at this rate by default. */
export const PANEL_SAMPLE_HZ = 10;

/** Spec §4.1: the most a panel may sample. */
export const MAX_PANEL_SAMPLE_HZ = 30;

/**
 * Numerical choice: nothing heard from the worker (no message, no accepted publish) for this long
 * while the target is ahead of progress is a crash (§10). A busy worker is never silent this long: it
 * yields every {@link WORK_SLICE_MS} and republishes at least every {@link LIVENESS_PUBLISH_MS}.
 */
export const WATCHDOG_MS = 3_000;

/**
 * Numerical choice: while it is busy (a burst of commands, a long catch-up) the worker republishes
 * at a slice's end if it hasn't published for this long, so the host hears it well inside
 * {@link WATCHDOG_MS} (a sixth of it). A republish is an ordinary publish: no new message.
 */
export const LIVENESS_PUBLISH_MS = 500;

/** Numerical choice: a generation needing a bigger slot than this is `error {code: 'capacity'}`. */
export const MAX_SLOT_BYTES = 64 * 1024 * 1024;

/** Numerical choice: the deadline of a `state` or `snapshot` query. */
export const STATE_QUERY_TIMEOUT_MS = 5_000;

/**
 * Numerical choice: the verification query's extra deadline per tick of the log being verified. `sim
 * bench` measured about 0.045 ms per tick of the 2,000-node plant locally and about 0.15 ms on the
 * slowest CI runner (`MAX_VERIFY_TICKS`' source), so 1 ms is several times the slowest seen.
 */
export const VERIFY_QUERY_MS_PER_TICK = 1;

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
