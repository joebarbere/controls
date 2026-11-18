import type { SourcedConstant } from '../../constants';

/*
 * The sourced constants of breakers v2, the GFCI and the AFCI (P4 D6–D8, ADR 0021 part 2). The device
 * bands themselves (pickups, opening and mechanism times, the test resistor) are catalogue parameters;
 * the region's GFCI and AFCI limits are `RegionProfile.protection`. These are the model's own choices,
 * each `game-design` or `numerical`, reviewed by `electrical-realism-reviewer`.
 */

/** How long a GFCI's test contact stays closed after a press, if it doesn't trip first (ADR 0019 S8). */
export const GFCI_TEST_HOLD_TICKS: SourcedConstant = {
  value: 5000,
  unit: 'tick',
  kind: 'game-design',
  source:
    "game-design: covers the region's Class A limit at the smallest realistic test current, a test circuit of at most about 9 mA at rated voltage that must still trip at 85 % voltage (UL 943 by number). A 15 kΩ resistor at 102 V draws 6.8 mA, giving a limit of 4.60 s. A press holds the test contact, and so the internal test resistor, in circuit for 5 s or until the device trips (ADR 0019 S8, fixed in ADR 0021 part 2).",
};

/**
 * The tolerance on the GFCI's inverse-time integral passing 1. Numerical: the integral is a sum of 1 ms
 * rate steps, so at a tabulated point (10 mA, 2.695 s) it reaches 1 at exactly 2695 steps only up to
 * rounding; the tolerance keeps that from moving the trip by a tick either way.
 */
export const GFCI_INTEGRAL_TOLERANCE: SourcedConstant = {
  value: 1e-9,
  unit: '1',
  kind: 'numerical',
  source:
    'numerical: a GFCI opens when its integral Σ dt / t(I) would pass 1 + 1e-9 within the next tick; 1e-9 is far below one tick’s step (dt / t ≥ 1.8e-4 at the 5.594 s point) and far above the rounding of a few thousand additions (about 1e-13), so a constant residual at a tabulated point opens exactly at its limit.',
};

/**
 * Between a GFCI's drawn pickup (4–6 mA) and the first tabulated point of the region's limit (6 mA),
 * the rate stays at the first point's (1 / 5.594 s). The limit has no value below its must-trip
 * current, so this is a labelled extension.
 */
export const GFCI_BELOW_FIRST_POINT_RULE =
  'game-design (ADR 0021 part 2): between the drawn pickup and the limit’s first point (6 mA) the trip rate is the first point’s, 1 / 5.594 s; the limit sets no time there (a Class A device need not trip at all below 6 mA), and holding the first point’s rate keeps the curve monotone.';

/**
 * The quiet gap after which an AFCI forgets its arc exposure (D8: `arcExposure` resets to 0 a quiet
 * gap after `arcLastSeenTick`).
 */
export const AFCI_QUIET_RESET_TICKS: SourcedConstant = {
  value: 1000,
  unit: 'tick',
  kind: 'game-design',
  source:
    'game-design (D8, ADR 0021 part 2): an AFCI forgets its arc exposure after 1 s (ten 100 ms buckets) with no counted arcing bucket downstream, the same scale as the 1 s detection limit at 5 A. A real device counts arc signatures in a sliding window whose length is the maker’s; only arcing buckets count towards a trip (D8).',
};

/**
 * The line voltage from which a GFCI's or an AFCI's electronics are powered: an AFCI's test press
 * trips it only from here (and, from F4.1 part 2, a GFCI receptacle's reset latches only from here).
 */
export const TRIP_ELECTRONICS_MIN_V: SourcedConstant = {
  value: 60,
  unit: 'V',
  kind: 'game-design',
  source:
    'game-design (ADR 0021 part 2): a GFCI or AFCI’s electronics are taken as powered from half the 120 V nominal line-to-neutral voltage, read between its line and its line-side neutral in the last solution. A real unit’s supply drops out somewhere below its rated range; no published figure is used.',
};
