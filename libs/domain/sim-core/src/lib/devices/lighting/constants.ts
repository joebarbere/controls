import type { SourcedConstant } from '../../constants';

/*
 * Sourced constants of the lighting models (P4 F4.1 part 1, D10, D11; ADR 0021 part 3). Reviewed by
 * `electrical-realism-reviewer` with the PR that adds them.
 */

/** The dimmer's firing angle at level 1 (degrees after the voltage zero): its high-end trim. */
export const DIMMER_FIRING_ANGLE_MIN_DEG: SourcedConstant = {
  value: 30,
  unit: '°',
  kind: 'game-design',
  source:
    "game-design: a forward-phase-cut dimmer never conducts the whole half cycle (its timing circuit needs part of it, and makers trim the top of the slider below full output); at its highest setting the model fires 30° after each voltage zero, so the load sees 98.5 % of the supply's RMS voltage (about 1.7 V short of 120 V).",
};

/** The dimmer's firing angle at level 0 (degrees after the voltage zero): its low-end trim. */
export const DIMMER_FIRING_ANGLE_MAX_DEG: SourcedConstant = {
  value: 150,
  unit: '°',
  kind: 'game-design',
  source:
    'game-design: at its lowest setting the model fires 150° after each voltage zero (30° of conduction), so the load sees 17.0 % of the RMS voltage: an incandescent filament glows dull red, as at the bottom of a real slider. The map from level to firing angle is linear between this and DIMMER_FIRING_ANGLE_MIN_DEG (an abstraction: real sliders are tapered to look even to the eye).',
};

/**
 * The RMS fraction of a forward-phase-cut sine against the dimmer's level: `DIMMER_RMS_CURVE.fractions[i]`
 * at level i / 20 (i = 0 … 20), linear between the points. Each point is
 *
 *   f(α) = √(1 − α/π + sin 2α / (2π)),   α = 150° − 120° · level,
 *
 * the RMS of a sine switched on at α in each half cycle relative to the whole sine's (physics
 * derivation: ∫ sin² over [α, π] divided by ∫ sin² over [0, π]), computed offline because sim code may
 * not call `Math.sin` (D6; `dimmer.spec.ts` recomputes every point). At 0.25, 0.5 and 0.75 it is 0.442155,
 * 0.707107 and 0.896939. Linear interpolation between the twenty-one points is within 0.21 % of the
 * formula; the table, not the formula, is the model's curve (plan F4.1's golden).
 */
export const DIMMER_RMS_CURVE: {
  readonly kind: SourcedConstant['kind'];
  readonly source: string;
  readonly levels: number;
  readonly fractions: readonly number[];
} = Object.freeze({
  kind: 'game-design',
  source:
    'physics derivation: the RMS of a forward-phase-cut sine, √(1 − α/π + sin 2α / (2π)) of the full sine, at the firing angle the level maps to (game-design: 150° at level 0 down to 30° at level 1, linear), computed offline at levels 0, 0.05, …, 1 to nine decimals.',
  levels: 20,
  fractions: Object.freeze([
    0.169807075, 0.22053266, 0.273953021, 0.329216632, 0.385531651, 0.442155074, 0.498388899, 0.553580231, 0.607123699,
    0.658465256, 0.707106781, 0.752611126, 0.794607333, 0.83279585, 0.866953578, 0.896938621, 0.922694611, 0.94425442,
    0.961743075, 0.975379591, 0.985477325,
  ]),
});

/**
 * The relative step the dimmer takes from its warm-start reactance to measure the circuit (a second
 * point for the secant, `dimmer.ts`).
 */
export const DIMMER_PROBE_RELSTEP: SourcedConstant = {
  value: 1e-4,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a 0.01 % step in the series reactance moves the circuit current by at most 0.01 %, about ten orders above the phasor solver’s rounding (1e-14 relative), so the two-point fit of the circuit seen by the dimmer is good to about 1e-8 relative; and it is ten times inside DIMMER_RESOLVE_RELTOL, so the probed point is accepted when the warm start was already right.',
};

/** The dimmer accepts a solve once its fitted reactance is within this of the one solved with. */
export const DIMMER_RESOLVE_RELTOL: SourcedConstant = {
  value: 1e-3,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a reactance within 0.1 % of the fitted one gives a load RMS fraction within 0.1 % × (1 − k²) of the curve, five times inside plan F4.1’s 0.5 % golden; a tighter tolerance only costs more phasor solves.',
};

/** How many fits may move a dimmer's reactance in one engine solve before it is frozen for the rest of it. */
export const DIMMER_MAX_FITS: SourcedConstant = {
  value: 6,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a resistive circuit needs one fit after the probe (two from a cold start); six bounds the passes a circuit that is not a fixed source behind a resistance can take (a second dimmer in series), so the island stays well inside OUTER_LOOP_MAX_ITERATIONS and readable.',
};

/** The near-short reactance a dimmer starts from with no usable warm start (its first point). */
export const DIMMER_MIN_REACTANCE_OHM: SourcedConstant = {
  value: 1e-6,
  unit: 'Ω',
  kind: 'numerical',
  source:
    'numerical: a 1 µΩ series reactance stands in for "no dimming" at a cold start (the stamp needs a value above 0); it moves a 120 V branch circuit’s current by about 1e-14 relative.',
};

/** A dimmer on a DC island: its triac latched on. */
export const DIMMER_DC_ON_OHM: SourcedConstant = {
  value: 0.01,
  unit: 'Ω',
  kind: 'game-design',
  source:
    'game-design: on DC a triac, once fired, never sees a current zero and stays on, so a phase-cut dimmer passes DC unregulated; its on-state taken as 10 mΩ (an abstraction: a triac’s about 1 V on-state drop is not modelled). P4 has no DC lighting circuit; an empty (unsupplied) island carries no current through it either way.',
};

/** A stopped LED driver's input: a resistance across each of its two branches. */
export const LED_DRIVER_OFF_OHM: SourcedConstant = {
  value: 1e8,
  unit: 'Ω',
  kind: 'numerical',
  source:
    'numerical: a stopped constant-power driver draws nothing (D11); each of its two branches stands at 100 MΩ, a stable stamp the solvers can hold (10 nS against gmin’s 1 pS). Two in parallel draw 0.16 mW at 90 V (2 × 90² / 1e8), below any meter the player has.',
};

/** The LED driver accepts a solve once its admittance is within this of the one solved with. */
export const LED_RESOLVE_RELTOL: SourcedConstant = {
  value: 1e-3,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: the driver’s admittance P / |V|² is re-solved until it moves by less than 0.1 % (so its power is within about 0.1 % of rated, ten times inside plan F4.1’s 1 % golden). Tighter than the lamp’s 1 % re-solve trigger (D11 names that one) because the driver has no thermal lag to hide a stale value: the error would show directly as power.',
};
