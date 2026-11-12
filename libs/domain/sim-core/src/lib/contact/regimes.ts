import { mix32 } from '@controls/world-model';
import type { SourcedConstant } from '../constants';

/*
 * Degradation, the end regimes and the end states of a landed conductor end (F3.6 part 2, ADR 0018 §5
 * and §6), and the failure limits of a conductor or lead node: the sourced constants, and the pure
 * functions the connection thermal bank writes out inline (a spec pins each against its inline copy).
 *
 * **R_deg = R_made · D.** Every threshold compares the end's as-made contact resistance at T₀ times
 * its degradation, a static value times a monotone one, so an end's progression is monotone and a
 * temperature swing can't make it chatter between regimes:
 *
 * - below `GLOW_ONSET_OHM`: `ok`, ohmic;
 * - from `GLOW_ONSET_OHM`: `ok`, glowing (V = V_G0 + P_G/|I|, a value regime, not a state);
 * - from `INTERMITTENT_ONSET_OHM`: intermittent, one draw per `INTERMITTENT_MIN_DWELL_TICKS` bucket:
 *   `intermittentOpen` (the branch leaves the netlist), `arcing` (R = V_arc/|I|) or
 *   `intermittentClosed` (the glowing law);
 * - from `BURNED_OPEN_OHM`: burned open, `intermittentOpen` in every bucket.
 *
 * Only `+ − × ÷`, `Math.sqrt`-free, and 32-bit integer operations on the draws (ADR 0015: per-tick draws
 * use only `Math.imul`, `>>>`, `^` and `+` on the stream's cached first output and the bucket).
 */

/** The hot-spot temperature above which an end's contact degrades (ADR 0018 §5). */
export const OXIDATION_ONSET_K: SourcedConstant = {
  value: 422.15,
  unit: 'K',
  kind: 'game-design',
  source:
    'game-design, real-world anchor (ADR 0018 §5): CPSC Publication 516 (June 2011, read in the P3 source pre-audit) counts a cover-plate screw reaching 149 °C (422.15 K) as a fire-hazard condition; a connection that study would call hazardous is one that degrades.',
};

/** The degradation rate per kelvin above the oxidation onset (ADR 0018 §5): dD/dt = this × m × (T_h − T_onset). */
export const DEGRADATION_RATE_PER_K_S: SourcedConstant = {
  value: 1 / 30_000,
  unit: 'K⁻¹·s⁻¹',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §5): 1/(600 s × 50 K), so an end held 50 K above the oxidation onset doubles its contact resistance in 10 minutes. Linear in the excess over a single onset (Abstraction 11): real oxidation and fretting depend on cycling and time.',
};

/** R_deg from which an end is burned open for good (ADR 0018 §6); reaching the metal's melting point forces it. */
export const BURNED_OPEN_OHM: SourcedConstant = {
  value: 1,
  unit: 'Ω',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §6): an end whose degraded contact resistance reaches 1 Ω (about 6× the top of NBS BSS 103’s 80–160 mΩ glowing band) has burned open; D never falls, so it stays open.',
};

/** R_deg from which an `ok` end follows the glowing law (ADR 0018 §6). */
export const GLOW_ONSET_OHM: SourcedConstant = {
  value: 0.08,
  unit: 'Ω',
  kind: 'real-world',
  source:
    'real-world anchor (ADR 0018 §6): NBS Building Science Series 103 (Meese and Beausoliel, 1977, read in the P3 source pre-audit) measured glowing connections at 80 to 160 mΩ at 15 A; the low end.',
};

/** V_G0 of the glowing law V = V_G0 + P_G/|I| (ADR 0018 §6). */
export const GLOW_V0: SourcedConstant = {
  value: 1.5915,
  unit: 'V',
  kind: 'real-world',
  source:
    'real-world fit, game-design form (ADR 0018 §6): NBS BSS 103’s glowing connections dropped 1.2–2.4 V at 15 A and 4–7 V at 0.8 A; V = V_G0 + P_G/|I| through both midpoints gives V_G0 = 1.5915 V and P_G = 3.1268 W (1.800 V at 15 A, 5.500 V at 0.8 A).',
};

/** P_G of the glowing law (ADR 0018 §6). */
export const GLOW_P: SourcedConstant = {
  value: 3.1268,
  unit: 'W',
  kind: 'real-world',
  source: 'real-world fit, game-design form (ADR 0018 §6): see GLOW_V0.',
};

/** The current floor of the glowing law (ADR 0018 §6): it bounds the law at 15.7 Ω. */
export const GLOW_CURRENT_FLOOR_A: SourcedConstant = {
  value: 0.5,
  unit: 'A',
  kind: 'numerical',
  source:
    'numerical (ADR 0018 §6): |I| is taken at least 0.5 A in the glowing law, bounding it at V_G0/0.5 + P_G/0.25 = 15.69 Ω, so a cold start or a near-zero current never stamps an unbounded value.',
};

/** R_deg from which an end is intermittent (ADR 0018 §6). */
export const INTERMITTENT_ONSET_OHM: SourcedConstant = {
  value: 0.16,
  unit: 'Ω',
  kind: 'game-design',
  source:
    'game-design, real-world anchor (ADR 0018 §6): the top of NBS BSS 103’s 80–160 mΩ glowing band; above it a connection is taken to make and break.',
};

/** The intermittent bucket: every open, arcing or closed period is a whole number of these (ADR 0015, ADR 0018 §6). */
export const INTERMITTENT_MIN_DWELL_TICKS: SourcedConstant = {
  value: 100,
  unit: 'tick',
  kind: 'game-design',
  source:
    'game-design (ADR 0015, ADR 0018 §6): at least 100 ticks; lights visibly flicker at 100 ms, and it bounds each end to one topology event per 100 ms. A multiple of SOLVE_INTERVAL_TICKS, so bucket boundaries are cadence ticks. Sub-dwell chatter, a real loose contact’s millisecond make and break, is abstracted.',
};

/** The probability an intermittent bucket is open (ADR 0018 §6). */
export const INTERMITTENT_P_OPEN: SourcedConstant = {
  value: 0.3,
  unit: '1',
  kind: 'game-design',
  source: 'game-design (ADR 0018 §6): an intermittent end is open in about 30 % of its 100 ms buckets.',
};

/** The probability an intermittent bucket is arcing (ADR 0018 §6). */
export const INTERMITTENT_P_ARC: SourcedConstant = {
  value: 0.2,
  unit: '1',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §6): an intermittent end arcs in about 20 % of its buckets and is closed (the glowing law) in the other 50 %.',
};

/** The bottom of the series-arc voltage band V_arc is drawn from (ADR 0018 §6). */
export const ARC_VOLTAGE_MIN_V: SourcedConstant = {
  value: 15,
  unit: 'V',
  kind: 'game-design',
  source:
    'game-design, literature anchor (ADR 0018 §6): the P3 source pre-audit’s “a series arc is roughly constant-voltage, a few to tens of volts”; Newbury and Greenwald (J. Res. NBS 85, 1980, abstract only) report temperatures above 1500 °C at an arcing screw terminal, qualitative support only. V_arc is uniform in [15, 30] V, drawn once per termination from termination:<id>:arcing.',
};

/** The top of the series-arc voltage band (ADR 0018 §6). */
export const ARC_VOLTAGE_MAX_V: SourcedConstant = {
  value: 30,
  unit: 'V',
  kind: 'game-design',
  source: 'game-design, literature anchor (ADR 0018 §6): see ARC_VOLTAGE_MIN_V.',
};

/** The current floor of the series arc (ADR 0018 §6): it bounds R_arc at 60 Ω and stands in for extinction. */
export const ARC_CURRENT_FLOOR_A: SourcedConstant = {
  value: 0.5,
  unit: 'A',
  kind: 'game-design',
  source:
    'game-design (ADR 0018 §6): |I| is taken at least 0.5 A in R_arc = V_arc/|I|, bounding it at 60 Ω; it stands in for extinction (a real arc below its minimum current goes out). An arc that goes out instead is deferred to P4’s AFCI work (the realism review).',
};

/** The hot-spot rise over ambient at which `terminationOverheat` is detected (ADR 0018 §6). */
export const TERMINATION_OVERHEAT_RISE_K: SourcedConstant = {
  value: 100,
  unit: 'K',
  kind: 'game-design',
  source:
    'game-design, real-world anchor (ADR 0018 §6): NBS BSS 128 (1980, read in the P3 source pre-audit) limits a connection’s temperature rise to 100 °C in its laboratory criterion; once per upward crossing of T_a + 100 K, below the oxidation onset so the warning comes before damage.',
};

/** The margin over an insulation's dry rating at which `insulationDamaged` is set (ADR 0018 §6). */
export const INSULATION_DAMAGE_MARGIN_K: SourcedConstant = {
  value: 40,
  unit: 'K',
  kind: 'game-design',
  source:
    'game-design, real-world anchor (ADR 0018 §6): 90 °C + 40 K = 130 °C, one manufacturer’s XHHW-2 emergency-overload rating (seen by the realism reviewer as a snippet only, unverified). An emergency rating is a permitted temperature, not a damage temperature, so it is conservative; applying the XLPE figure to PVC and nylon is unverified too.',
};

/** The end-state codes: indices into `CONNECTION_END_STATES` (`ok`, `intermittentClosed`, `intermittentOpen`, `arcing`). */
export const END_OK = 0;
export const END_INTERMITTENT_CLOSED = 1;
export const END_INTERMITTENT_OPEN = 2;
export const END_ARCING = 3;

/** u < this (of 2³²) draws `intermittentOpen`; u < `ARC_DRAW_BELOW` draws `arcing` (exact: 0.3 × 2³² etc. are compared as doubles). */
const TWO_POW_32 = 0x1_0000_0000;
const OPEN_BELOW = INTERMITTENT_P_OPEN.value;
const ARC_BELOW = INTERMITTENT_P_OPEN.value + INTERMITTENT_P_ARC.value;

/** The intermittent bucket of tick `tick` (`⌊tick / INTERMITTENT_MIN_DWELL_TICKS⌋`; exact for safe integers). */
export function intermittentBucket(tick: number): number {
  return Math.floor(tick / INTERMITTENT_MIN_DWELL_TICKS.value);
}

/**
 * One bucket's draw, an integer in [0, 2³²): `mix32(s ^ imul(bucket, 0x9e3779b1))`, with `s` the cached
 * first output of the termination's `:intermittent` stream (ADR 0015, ADR 0018 §6). No generator state,
 * no string per tick, no dependence on any other end's draws.
 */
export function intermittentDrawU32(first: number, bucket: number): number {
  return mix32((first ^ Math.imul(bucket, 0x9e37_79b1)) >>> 0);
}

/**
 * An end's state code (ADR 0018 §6): a pure function of R_deg = R_made · D, the termination's
 * `:intermittent` first output and the bucket. A burned-open end is open in every bucket.
 */
export function endStateCode(rDegOhm: number, first: number, bucket: number): number {
  if (rDegOhm >= BURNED_OPEN_OHM.value) return END_INTERMITTENT_OPEN;
  if (rDegOhm < INTERMITTENT_ONSET_OHM.value) return END_OK;
  const u = intermittentDrawU32(first, bucket) / TWO_POW_32;
  if (u < OPEN_BELOW) return END_INTERMITTENT_OPEN;
  if (u < ARC_BELOW) return END_ARCING;
  return END_INTERMITTENT_CLOSED;
}

/** V_arc from the first output of the termination's `:arcing` stream: uniform in [15, 30) V (ADR 0018 §6). */
export function arcVoltageV(first: number): number {
  const min = ARC_VOLTAGE_MIN_V.value;
  return min + (ARC_VOLTAGE_MAX_V.value - min) * (first / TWO_POW_32);
}

/** The glowing law's resistance V_G0/|I|_f + P_G/|I|_f² (Ω), |I|_f = max(|I|, 0.5 A) (ADR 0018 §6). */
export function glowResistanceOhm(amps: number): number {
  const i = amps > GLOW_CURRENT_FLOOR_A.value ? amps : GLOW_CURRENT_FLOOR_A.value;
  return GLOW_V0.value / i + GLOW_P.value / (i * i);
}

/** The series arc's resistance V_arc/|I|_a (Ω), |I|_a = max(|I|, 0.5 A) (ADR 0018 §6). */
export function arcResistanceOhm(arcVolts: number, amps: number): number {
  return arcVolts / (amps > ARC_CURRENT_FLOOR_A.value ? amps : ARC_CURRENT_FLOOR_A.value);
}

/**
 * One forward-Euler step of an end's degradation over `dtS` (ADR 0018 §5): D grows only above the
 * oxidation onset, at `DEGRADATION_RATE_PER_K_S` × `multiplier` per kelvin of excess. Never falls.
 */
export function degradationStep(degradation: number, hotSpotK: number, multiplier: number, dtS: number): number {
  const excess = hotSpotK - OXIDATION_ONSET_K.value;
  return excess > 0 ? degradation + dtS * DEGRADATION_RATE_PER_K_S.value * multiplier * excess : degradation;
}
