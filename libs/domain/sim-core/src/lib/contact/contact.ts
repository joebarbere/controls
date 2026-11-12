import type { ConductorStranding, TerminalMethodSpec } from '@controls/catalog';
import type { TerminationV3 } from '@controls/save-format';
import {
  AL_UNRATED_DEGRADATION_MULTIPLIER,
  CRIMP_GOOD_OHM,
  LOOSE_FILM_OHM,
  NICK_MAX_FRACTION,
  SEAT_FRACTION,
  STRAND_SPREAD_FACTOR,
  TERMINAL_RESISTIVITY_OHM_M,
} from './constants';

/*
 * The as-made contact resistance of a landed conductor end (ADR 0018 §4; F3.3 part 1). A pure function
 * of the stored `TerminationV3` outcome, the terminal's method spec (catalogue data), how many
 * conductors that method holds on the terminal, and the conductor's stranding and metal. It is the
 * netlist compiler's static value per end; F3.6's connection bank multiplies it by degradation and
 * applies temperature and the end regimes at solve time.
 *
 * Holm's constriction gives only the shape; R₀ (`spec.contactOhm`) is calibrated to measurement:
 *
 *   R_clamp(r) = R₀ / √(clamp(r, r_seat, 1)) + R_loose · (max(0, 1 − r / r_seat))²
 *   r_eff      = r × φ_strip × count × spread          (r = 1 for a method without a torque)
 *   R_crimp    = the same law with R_crimp,good and the crimp quality q (with a ferrule or lug)
 *   R_made     = (R_clamp(r_eff) · m_metal + R_crimp) · 1/(1 − min(f, 0.9))
 *
 * returned as two parts: the **constriction** part (the R₀ term, which carries the metal's α at solve
 * time) and the **film** part (the loose term and the crimp, temperature-independent; ADR 0018 §3.3).
 *
 * Deterministic (D6): only `+ − × ÷` and `Math.sqrt`, in the fixed order written below, so the value is
 * bit-identical in every engine. `asMadeContactInto` allocates nothing.
 */

/** One landed end as the contact model reads it. */
export interface ContactEnd {
  /** The stored outcome of the landing (ADR 0015). */
  readonly termination: TerminationV3;
  /** The terminal's spec for the termination's method (catalogue data, ADR 0018 §8). */
  readonly spec: TerminalMethodSpec;
  /** How many conductor ends that method holds on the terminal, this one included (counted by the compiler). */
  readonly landedCount: number;
}

/** What the contact model reads of the conductor: its stranding and its metal's resistivity at T₀. */
export interface ContactConductor {
  readonly stranding: ConductorStranding;
  readonly resistivityOhmM: number;
}

/** An end's as-made contact resistance in its two parts (Ω, at T₀). */
export interface ContactParts {
  /** The constriction part (the R₀ term): it scales with the metal's resistivity at solve time. */
  constrictionOhm: number;
  /** The film part (the loose term and any crimp): temperature-independent. */
  filmOhm: number;
}

const R_SEAT = SEAT_FRACTION.value;
const R_LOOSE = LOOSE_FILM_OHM.value;
const RHO_TERMINAL = TERMINAL_RESISTIVITY_OHM_M.value;

/**
 * The clamp's torque ratio r = T_achieved / T_marked, capped at 1 (no benefit above the marked torque,
 * ADR 0018 §4.1). K and d of T = K·F·d cancel, so r is also the force ratio. A method without a clamp
 * torque (spring cage, push-in, twist-on) holds with a fixed force: r = 1. A clamp-torque method whose
 * outcome has no torque (never written by `resolveTermination`) counts as finger-tight, r = 0.
 */
export function torqueRatio(termination: TerminationV3, spec: TerminalMethodSpec): number {
  const marked = spec.torqueNm;
  if (marked === null) return 1;
  const achieved = termination.torqueNm;
  if (achieved === null || achieved <= 0) return 0;
  const r = achieved / marked;
  return r < 1 ? r : 1;
}

/**
 * The effective clamp ratio (ADR 0018 §4.3): r × φ_strip × count × spread, multiplied in that order.
 *
 * - φ_strip = min(1, strip length / clamp depth): a short strip clamps insulation, not metal;
 * - count = rated / n when n conductors share a clamp rated for fewer (shared evenly, an abstraction);
 * - spread = `STRAND_SPREAD_FACTOR` for a bare stranded conductor under a binding screw.
 */
export function effectiveClampRatio(end: ContactEnd, stranding: ConductorStranding): number {
  const { termination, spec } = end;
  let ratio = torqueRatio(termination, spec);
  const strip = termination.stripLengthMm / spec.clampDepthMm;
  if (strip < 1) ratio = ratio * strip;
  const n = end.landedCount;
  if (n > spec.ratedConductors) ratio = ratio * (spec.ratedConductors / n);
  if (termination.accessory === null && stranding === 'stranded' && spec.clampType === 'bindingScrew') {
    ratio = ratio * STRAND_SPREAD_FACTOR.value;
  }
  return ratio;
}

/** The seated term's divisor, √(clamp(r, r_seat, 1)). */
function seatedRoot(r: number): number {
  return Math.sqrt(r < R_SEAT ? R_SEAT : r > 1 ? 1 : r);
}

/** The loose film term R_loose · (max(0, 1 − r / r_seat))² (Ω). */
function looseFilmOhm(r: number): number {
  const x = 1 - r / R_SEAT;
  return x > 0 ? R_LOOSE * x * x : 0;
}

/**
 * R_clamp(r) (ADR 0018 §4.2) for a good-connection resistance `contactOhm`: continuous and strictly
 * decreasing up to r = 1, with a slope step at r_seat, flat above 1, finite at 0.
 */
export function clampResistanceOhm(contactOhm: number, r: number): number {
  return contactOhm / seatedRoot(r) + looseFilmOhm(r);
}

/** A crimp's resistance for quality q ∈ [0, 1] (ADR 0018 §4.3): the clamp law with `CRIMP_GOOD_OHM`. */
export function crimpResistanceOhm(quality: number): number {
  return CRIMP_GOOD_OHM.value / seatedRoot(quality) + looseFilmOhm(quality);
}

/**
 * The metal factor m = (ρ + ρ_Cu)/(2 ρ_Cu) (ADR 0018 §4.3): exactly 1 for copper, 1.31966 for the
 * 61.0 % IACS aluminium alloy. The terminal is taken as copper.
 */
export function metalContactFactor(resistivityOhmM: number): number {
  return (resistivityOhmM + RHO_TERMINAL) / (2 * RHO_TERMINAL);
}

/** The nick factor 1/(1 − min(f, 0.9)) (ADR 0018 §4.3). */
export function nickFactor(nickedStrandFraction: number): number {
  const f = nickedStrandFraction < NICK_MAX_FRACTION.value ? nickedStrandFraction : NICK_MAX_FRACTION.value;
  return 1 / (1 - (f > 0 ? f : 0));
}

/**
 * Writes an end's as-made contact resistance into `out` and returns it (no allocation):
 *
 *   constriction = R₀ / √(clamp(r_eff)) × m × k
 *   film         = (R_loose · (1 − r_eff/r_seat)₊² × m + R_crimp) × k
 *
 * with m the metal factor and k the nick factor. Aluminium on a method not rated for it changes only
 * the degradation rate ({@link degradationRateMultiplier}), not this value.
 */
export function asMadeContactInto(out: ContactParts, end: ContactEnd, conductor: ContactConductor): ContactParts {
  const r = effectiveClampRatio(end, conductor.stranding);
  const m = metalContactFactor(conductor.resistivityOhmM);
  const k = nickFactor(end.termination.nickedStrandFraction);
  const accessory = end.termination.accessory;
  const crimp = accessory === null ? 0 : crimpResistanceOhm(accessory.crimpQuality);
  out.constrictionOhm = (end.spec.contactOhm / seatedRoot(r)) * m * k;
  out.filmOhm = (looseFilmOhm(r) * m + crimp) * k;
  return out;
}

/** {@link asMadeContactInto} into a new object. */
export function asMadeContact(end: ContactEnd, conductor: ContactConductor): ContactParts {
  return asMadeContactInto({ constrictionOhm: 0, filmOhm: 0 }, end, conductor);
}

/**
 * The degradation-rate multiplier of an end (ADR 0018 §5; F3.6 part 2 applies it):
 * `AL_UNRATED_DEGRADATION_MULTIPLIER` for a conductor that isn't copper on a method with
 * `alRated: false`, else 1.
 */
export function degradationRateMultiplier(spec: TerminalMethodSpec, conductor: ContactConductor): number {
  return conductor.resistivityOhmM > RHO_TERMINAL && !spec.alRated ? AL_UNRATED_DEGRADATION_MULTIPLIER.value : 1;
}
