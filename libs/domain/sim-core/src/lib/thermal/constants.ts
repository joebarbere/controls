import type { SourcedConstant } from '../constants';

/*
 * Sourced constants of the conductor thermal model that belong to the engine (ADR 0018 §3.4, §9, §11):
 * the rating ambient of the derived ampacity, and the connection thermal bank's numerical settings.
 * The heat-path constants (convection, radiation, emissivity, Lorenz number, the minimum time
 * constant) live in `@controls/catalog` beside the heat path itself, so the catalogue's load check
 * evaluates the same model; this module re-exports them.
 */

export {
  BARE_CONDUCTOR_EMISSIVITY,
  H_CONV_COEFF,
  LN_SERIES_TERMS,
  LN_SQRT_STEPS,
  LORENZ_NUMBER,
  STEFAN_BOLTZMANN,
  SURFACE_ITERATIONS,
  THERMAL_MIN_TAU_S,
} from '@controls/catalog';

/**
 * The ambient building-wire ampacity is rated at (F3.1, D6): 30 °C. Separate from the game's 20 °C
 * ambient, which the engine heats conductors from.
 */
export const RATING_AMBIENT_K: SourcedConstant = {
  value: 303.15,
  unit: 'K',
  kind: 'real-world',
  source:
    'real-world (convention): building-wire ampacity in air is rated at a 30 °C ambient, the basis that NFPA 70 Art. 310.15(B)(1) corrects other ambients from (cited by number only; the 2023 sub-numbering is unverified). Kept apart from the game ambient (20 °C) by ADR 0018 §9.',
};

/**
 * The conductor temperature an NM cable's ampacity is limited to (60 °C), although its conductors are
 * rated 90 °C. P4's inspector calls `derivedAmpacityA` with it for a conductor of an NM assembly; no NM
 * figure is ever derived at 90 °C (ADR 0018 §9).
 */
export const NM_CABLE_AMPACITY_TEMP_K: SourcedConstant = {
  value: 333.15,
  unit: 'K',
  kind: 'real-world',
  source:
    'real-world: NFPA 70-2023 Art. 334.80 (cited by number, paraphrased) limits the ampacity of NM cable to that of 60 °C conductors, whatever its conductors are rated (the catalogue review of 2026-11-11; ADR 0018 §9).',
};

/**
 * How many bank steps (of `SOLVE_INTERVAL_TICKS` × `TICK_S` = 10 ms) the shortest thermal time
 * constant must span (ADR 0018 §3.4). The catalogue's `THERMAL_MIN_TAU_S` is this × the step; a spec
 * pins the product.
 */
export const THERMAL_MIN_TAU_STEPS: SourcedConstant = {
  value: 100,
  unit: '1',
  kind: 'numerical',
  source:
    "numerical: forward Euler's per-step local error is (dt/τ)²/2 ≤ 5 × 10⁻⁵ at τ ≥ 100 dt, and its stability limit dt < 2τ holds with a 200× margin (ADR 0018 §3.4). The catalogue refuses an entry below it at load.",
};

/**
 * The connection bank's re-solve rule (ADR 0018 §3.4, the lamp's `LAMP_RESOLVE_RELTOL`): after a
 * scheduled step, a netlisted connection whose solve-time value has moved more than this fraction
 * from the value the last solve saw (read back from the solution as |ΔV| / |I|) asks for a value-only
 * re-solve at t + 1.
 */
export const CONNECTION_RESOLVE_RELTOL: SourcedConstant = {
  value: 0.01,
  unit: '1',
  kind: 'numerical',
  source:
    "numerical: the lamp's 1 % rule (LAMP_RESOLVE_RELTOL). Smooth heating moves a conductor's R by far less than 1 % per 10 ms step, so in practice it fires on value steps (part 2's regimes and degradation), not while a conductor warms normally; fast fault heating (a shorted lead at hundreds of amps) re-solves every 3–4 steps (ADR 0018 §3.4).",
};

/** Below this branch current (A) the connection bank never asks for a re-solve (as `LAMP_RESOLVE_MIN_A`). */
export const CONNECTION_RESOLVE_MIN_A: SourcedConstant = {
  value: 1e-6,
  unit: 'A',
  kind: 'numerical',
  source:
    "numerical: as LAMP_RESOLVE_MIN_A, 1 µA. A connection carrying less barely heats, and a gmin-level current's |ΔV| / |I| is rounding, so the 1 % rule would re-solve on noise (ADR 0018 §3.4).",
};
