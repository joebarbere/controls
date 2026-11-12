import type { SourcedConstant } from '../constants';

/*
 * Sourced constants of the conductor thermal model (ADR 0018 §3.2, §9, §11), as far as F3.1's derived
 * ampacity needs them. F3.6 adds the rest (the bank's schedule, the hot-spot node, degradation).
 */

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
