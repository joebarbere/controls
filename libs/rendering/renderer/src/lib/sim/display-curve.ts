/*
 * The lamp display curve (plan F2.5, ADR 0011 §9.2): how a lamp's physics-derived light output is
 * drawn. A pure module (lint-fenced: no Three.js, clock, randomness or DOM), so the same output always
 * draws the same level.
 *
 * The renderer never computes an electrical quantity. `lightOutputRel` comes from the simulator's lamp
 * record (1 = rated light, above 1 on over-voltage, 0 dark); this module only maps it to an emissive
 * level, which is a game-design choice.
 */

/** Emissive levels drawn: 0 (dark) to 255 (full glow), in steps of 1/255 (ADR 0011 §9.2). */
export const LAMP_DISPLAY_STEPS = 255;

/** Light output below which a lamp is drawn dark (level 0): one display step of rated light. */
export const LAMP_DARK_BELOW_REL = 1 / LAMP_DISPLAY_STEPS;

/**
 * Saturation rate `k` of the curve `1 − e^(−k·L)`: `ln 5`, so rated light (L = 1) draws at 0.8 of full
 * glow and over-voltage still shows brighter (L = 1.5 → 0.91, L = 2 → 0.96) without clipping.
 */
export const LAMP_DISPLAY_SATURATION = Math.log(5);

/** The level a lamp at rated light (`lightOutputRel` = 1) is drawn at: `round(255 × 0.8)` = 204. */
export const LAMP_RATED_LEVEL = 204;

/** Where the curve comes from (realism charter: every constant has a source). */
export const LAMP_DISPLAY_CURVE_SOURCE = {
  kind: 'game-design',
  source:
    'game-design: glow = 1 − exp(−ln5 · L) of full for light output L (rated = 1), dark below L = 1/255, quantised ' +
    'to 1/255. Near-linear for dim glows, saturating smoothly so an over-driven lamp is brighter than a rated one ' +
    'but never clips; rated light draws at 0.8 of full. A display choice, not a photometric model.',
} as const;

/**
 * The display curve: `lightOutputRel` → glow in [0, 1]. 0 below {@link LAMP_DARK_BELOW_REL} (and for
 * NaN or negative input), else `1 − e^(−k·L)` with k = {@link LAMP_DISPLAY_SATURATION}. Monotone
 * non-decreasing; 1 only at +∞.
 */
export function lampDisplayCurve(lightOutputRel: number): number {
  if (!(lightOutputRel >= LAMP_DARK_BELOW_REL)) return 0; // also NaN
  if (lightOutputRel === Infinity) return 1;
  return 1 - Math.exp(-LAMP_DISPLAY_SATURATION * lightOutputRel);
}

/**
 * The drawn level: `round(255 × lampDisplayCurve(L))`, an integer in 0…255. Below 1/255 of rated
 * light it is 0 (dark); at rated light it is {@link LAMP_RATED_LEVEL}.
 */
export function lampDisplayLevel(lightOutputRel: number): number {
  return Math.round(LAMP_DISPLAY_STEPS * lampDisplayCurve(lightOutputRel));
}
