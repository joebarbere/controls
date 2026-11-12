import { type ConductorThermal, conductanceToAirWPerMK, conductorResistanceOhm } from '@controls/catalog';

/*
 * The derived ampacity (D6, ADR 0018 §9): the conductor's steady heat balance in free air, inverted.
 * F3.1 landed it; F3.6 part 1's connection thermal bank integrates the same conductance
 * (`conductanceToAirOf`, from `@controls/catalog`), so the two never disagree.
 */

/** Where a derived ampacity is taken: the conductor's rating temperature and the ambient (K). */
export interface AmpacityConditions {
  readonly ratingTempK: number;
  readonly ambientK: number;
}

/**
 * The derived ampacity (A, D6, ADR 0018 §9): the current at which the conductor's steady temperature
 * in free air reaches `ratingTempK`, a single conductor in still air at `ambientK`:
 * I = √((T_r − T_a) · G′(T_r; T_a) / R′(T_r)). Computed, never stored; no table value is involved.
 * Labelled "free air, single conductor": in a raceway or a cable a conductor runs hotter (P4+).
 * Call it with `RATING_AMBIENT_K` and the insulation's rating, or `NM_CABLE_AMPACITY_TEMP_K` for a
 * conductor of an NM cable. `ratingTempK` must be above `ambientK`.
 */
export function derivedAmpacityA(thermal: ConductorThermal, conditions: AmpacityConditions): number {
  const { ratingTempK, ambientK } = conditions;
  if (!(ratingTempK > ambientK)) throw new RangeError('derivedAmpacityA: the rating must be above the ambient');
  const conductance = conductanceToAirWPerMK(thermal, ratingTempK, ambientK);
  const resistancePerM = conductorResistanceOhm(thermal.physics, 1000, ratingTempK);
  return Math.sqrt(((ratingTempK - ambientK) * conductance) / resistancePerM);
}
