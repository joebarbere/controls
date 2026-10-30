/*
 * The only wall-clock read in sim-cli: `sim bench` measures how long a case takes. The root
 * eslint.config.mjs exempts this one file from the determinism lint (proven by
 * src/lint-determinism.spec.ts). A timing must never reach a hash, a save or a replay log: the bench
 * only reports it. Everything else in sim-cli takes a clock as a parameter, so tests pass a fake.
 */

/** Monotonic milliseconds from an arbitrary origin; only differences are meaningful. */
export function wallClockMs(): number {
  return performance.now();
}
