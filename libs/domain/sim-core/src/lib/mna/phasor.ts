/*
 * Phasor constants for the AC solver (plan F2.2 part 2, decision D6). A phasor is an RMS magnitude
 * and an angle, V_rms∠θ, written as `re + j·im` = V_rms · (cos θ + j sin θ) (ADR 0011 §5.3: AC values
 * are RMS phasors at the region frequency). The waveform it stands for is
 *
 *   v(t) = √2 · Re(V · e^{jωt}) = √2 · V_rms · cos(ωt + θ),
 *
 * so a 120 V phasor peaks at 169.7 V. Every phasor in sim-core (EMFs, node voltages, branch currents)
 * is RMS, never peak.
 *
 * sim-core may not call `Math.cos` or `Math.sin` (D6: they vary between JavaScript engines), so a
 * source's angle is restricted to the angles whose cosine and sine are exact constants: 0°, 180° and
 * ±120°, the angles of a split-phase (0°, 180°) or a three-phase (0°, −120°, +120°) supply. cos 120°
 * is exactly −0.5, and sin 120° = √3 / 2 comes from `Math.sqrt`, which IEEE 754 requires to be
 * correctly rounded, so it is the same double everywhere.
 */

/** A phasor source's angle in degrees: only those with exact cos and sin constants. */
export type PhasorAngle = 0 | 180 | 120 | -120;

export const PHASOR_ANGLES: readonly PhasorAngle[] = [0, 180, 120, -120];

/** sin 120° = √3 / 2, by `Math.sqrt` (IEEE-exact, D6). */
export const SIN_120 = Math.sqrt(3) / 2;

/** `cos θ` and `sin θ` of an allowed angle, as exact constants. */
export function phasorUnit(angle: PhasorAngle): { readonly re: number; readonly im: number } {
  switch (angle) {
    case 0:
      return { re: 1, im: 0 };
    case 180:
      return { re: -1, im: 0 };
    case 120:
      return { re: -0.5, im: SIN_120 };
    case -120:
      return { re: -0.5, im: -SIN_120 };
  }
}

/**
 * The angular frequency ω = 2π f (rad/s) of `frequencyHz`: `2 * Math.PI * f`, two correctly rounded
 * multiplications, the same double in every runtime (D6). 376.99111843077515 rad/s at 60 Hz.
 */
export function angularFrequency(frequencyHz: number): number {
  if (!(Number.isFinite(frequencyHz) && frequencyHz > 0)) {
    throw new RangeError(`AC frequency must be finite and > 0 Hz, got ${frequencyHz}`);
  }
  return 2 * Math.PI * frequencyHz;
}
