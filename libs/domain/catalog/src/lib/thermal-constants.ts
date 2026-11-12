import type { SourcedConstant } from './sourced';

/*
 * Sourced constants of the conductor heat path (ADR 0018 §3.2, §3.3, §3.4, §11). They live in the
 * catalogue since F3.6 part 1, beside `conductorResistanceOhm`, because the catalogue's load-time
 * time-constant check (§3.4) evaluates the same heat path as the engine's connection thermal bank;
 * sim-core re-exports every one, so the two can't disagree.
 */

/** The coefficient of the simplified laminar convection relation h = C · (ΔT / D)^¼ for air. */
export const H_CONV_COEFF: SourcedConstant = {
  value: 1.32,
  unit: 'W·m⁻⁷ᐟ⁴·K⁻⁵ᐟ⁴',
  kind: 'real-world',
  source:
    'real-world: the simplified natural-convection relation for a horizontal cylinder in air at atmospheric pressure, h = 1.32 (ΔT/D)^¼ with D in metres (Holman, Heat Transfer; vetted in the P3 source pre-audit). Against Churchill and Chu (1975) it is within −17 %/+22 % for D 2.6–16 mm and ΔT 10–60 K; it is used below its laminar Rayleigh range (Ra ≈ 50 for 14 AWG), justified only by that comparison (ADR 0018 §3.2).',
};

/** The Stefan–Boltzmann constant σ. */
export const STEFAN_BOLTZMANN: SourcedConstant = {
  value: 5.670374419e-8,
  unit: 'W·m⁻²·K⁻⁴',
  kind: 'real-world',
  source:
    'real-world (physics): σ = 2π⁵k_B⁴/(15h³c²) from the exactly defined SI 2019 constants (the CODATA 2018 value, 5.670374419 × 10⁻⁸ W·m⁻²·K⁻⁴).',
};

/** The surface emissivity of a bare conductor (insulated ones read their insulation row's). */
export const BARE_CONDUCTOR_EMISSIVITY: SourcedConstant = {
  value: 0.5,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design: between bright copper (a few per cent) and heavily oxidised copper; the bare equipment grounding conductor normally carries no current, so its heating rarely matters (ADR 0018 §11).',
};

/** How many fixed-point steps find the insulation surface temperature from the conductor's (ADR 0018 §3.2). */
export const SURFACE_ITERATIONS: SourcedConstant = {
  value: 1,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: one iteration is within 0.02 % (14 AWG THHN) to 0.2 % (18 AWG MTW) of the converged surface balance (ADR 0018 §3.2, prototype); a second would cost two square roots per conductor for no visible change.',
};

/** `lnRatio`'s square roots (x^(1/16)) and atanh-series terms (ADR 0018 §3.2). */
export const LN_SQRT_STEPS: SourcedConstant = {
  value: 4,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: four square roots bring x ≤ 8 to within 1.14 of 1, where six terms of the atanh series give a relative error below 2 × 10⁻¹¹ against Math.log over 1.0001–8 (ADR 0018 §3.2; pinned in thermal.spec.ts).',
};

export const LN_SERIES_TERMS: SourcedConstant = {
  value: 6,
  unit: '1',
  kind: 'numerical',
  source: 'numerical: see LN_SQRT_STEPS.',
};

/**
 * The Sommerfeld Lorenz number L₀ = π²/3 · (k_B/e)², for the Wiedemann–Franz thermal conductivity
 * k = L₀ · T₀ / ρ₀ of a conductor metal (ADR 0018 §3.3): the hot spot's fin conductance √(G′ k A).
 */
export const LORENZ_NUMBER: SourcedConstant = {
  value: 2.443004509e-8,
  unit: 'W·Ω·K⁻²',
  kind: 'real-world',
  source:
    'real-world (physics derivation): the Sommerfeld value L₀ = π²/3 · (k_B/e)² from the exactly defined SI 2019 constants k_B and e, 2.443004509 × 10⁻⁸ W·Ω/K². With the Wiedemann–Franz law k = L₀T₀/ρ₀ it gives 415.4 W/(m·K) for annealed copper and 253.4 W/(m·K) for the 61 % IACS aluminium alloy. Measured Lorenz numbers for copper near room temperature are a few per cent lower, so k reads about 4 % high (ADR 0018 §3.3, an abstraction).',
};

/**
 * The shortest thermal time constant any conductor, lead or termination hot spot may have (s): the
 * connection thermal bank's forward-Euler step (`SOLVE_INTERVAL_TICKS` × `TICK_S` = 0.01 s) times
 * `THERMAL_MIN_TAU_STEPS` (100) in sim-core, which pins the product against this value. The catalogue
 * refuses an entry whose conservative lower bound is shorter (ADR 0018 §3.4).
 */
export const THERMAL_MIN_TAU_S: SourcedConstant = {
  value: 1,
  unit: 's',
  kind: 'numerical',
  source:
    "numerical: 100 steps of the thermal bank's 10 ms forward-Euler step (ADR 0018 §3.4): the per-step local error is (dt/τ)²/2 ≤ 5 × 10⁻⁵ and the stability limit dt < 2τ holds with a 200× margin.",
};
