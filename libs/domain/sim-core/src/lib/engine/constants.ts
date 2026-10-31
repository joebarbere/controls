import type { SourcedConstant } from '../constants';

/*
 * The engine loop's constants (plan F2.3a, ADR 0011 §2). Both are numerical choices: they set how
 * the simulation is stepped, not any electrical value.
 */

/** One sim tick in seconds: the fixed 1 kHz clock (1 tick = 1 ms). */
export const TICK_S: SourcedConstant = {
  value: 0.001,
  unit: 's',
  kind: 'numerical',
  source:
    'numerical: spec §4.3 fixes the sim clock at 1 kHz (1 tick = 1 ms, an integer), the step of the continuous and protection layers (ADR 0011 §2). Fine enough for filament and battery thermal and charge dynamics (time constants of tens of ms and longer) and for fuse and breaker I²t at the currents P2 produces.',
};

/**
 * The electrical layer's cadence: a solve at every tick that is a multiple of this (absolute ticks, so
 * a restart or a load keeps the cadence), besides one on every topology or value change.
 */
export const SOLVE_INTERVAL_TICKS: SourcedConstant = {
  value: 10,
  unit: 'tick',
  kind: 'numerical',
  source:
    "numerical: ADR 0011 §2's choice inside spec §4.5's 10–20 ms re-solve cadence. Between solves the continuous and protection layers integrate against the last solution; anything that changes the topology (a command, a trip) solves at once.",
};
