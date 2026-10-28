/**
 * Angle units. World orientation is integer **millidegrees** (ADR 0007); the renderer converts to
 * radians for Three.js with {@link mdegToRadians}, in one place, and only at draw time (the result is
 * view state and never feeds back into the world).
 */

/** Integer millidegrees → radians. `mdegToRadians(90_000)` is π/2. */
export const mdegToRadians = (mdeg: number): number => (mdeg / 1000) * (Math.PI / 180);
