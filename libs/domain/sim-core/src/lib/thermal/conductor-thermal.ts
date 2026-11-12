import { type ConductorPhysics, conductorResistanceOhm } from '@controls/catalog';
import { BARE_CONDUCTOR_EMISSIVITY, H_CONV_COEFF, STEFAN_BOLTZMANN } from './constants';

/*
 * The conductor's steady heat balance in free air (ADR 0018 §3.2) and the ampacity derived from it
 * (D6, ADR 0018 §9). F3.1 lands the static pieces and the derived ampacity; F3.6 integrates the same
 * conductance in its connection thermal bank, so the two never disagree.
 *
 * Only `+ − × ÷` and `Math.sqrt` (D6): the logarithm the cylinder's conduction needs is `lnRatio`,
 * a fixed sequence of IEEE-exact operations, so every result is bit-identical in Node and Chromium.
 */

const H_CONV = H_CONV_COEFF.value;
const SIGMA = STEFAN_BOLTZMANN.value;
const TWO_PI = 2 * Math.PI;

/**
 * ln(x) for 1 ≤ x ≤ 8 (the catalogue refuses an outer radius above 8 × the conductor's), by four
 * square roots (y = x^(1/16)) and six terms of the atanh series: ln x = 16 · 2 · atanh(z), z = (y − 1) / (y + 1).
 * Relative error below 2 × 10⁻¹¹ against `Math.log` over 1.0001–8 (pinned in the spec).
 */
export function lnRatio(x: number): number {
  const y = Math.sqrt(Math.sqrt(Math.sqrt(Math.sqrt(x))));
  const z = (y - 1) / (y + 1);
  const z2 = z * z;
  const series = z * (1 + z2 * (1 / 3 + z2 * (1 / 5 + z2 * (1 / 7 + z2 * (1 / 9 + z2 / 11)))));
  return 32 * series;
}

/** The static half of a conductor's heat path, computed once per entry (ADR 0018 §3.2). */
export interface ConductorThermal {
  readonly physics: ConductorPhysics;
  /** R′_ins: conduction through the insulation and jacket cylinders, per metre (K·m/W); 0 when bare. */
  readonly insulationResistanceKMPerW: number;
  /** The outer diameter D = 2 r₂ (m): over the jacket, the insulation, or the bare metal. */
  readonly outerDiameterM: number;
  /** The outer surface's emissivity ε (the insulation row's, or `BARE_CONDUCTOR_EMISSIVITY`). */
  readonly emissivity: number;
}

/**
 * The thermal data of a conductor: R′_ins = ln(r₁/r₀) / (2π k₁) + ln(r₂/r₁) / (2π k₂), with r₀ the
 * conductor's radius, r₁ = r₀ + t₁ over the insulation and r₂ = r₁ + t₂ over the jacket (absent for a
 * single layer).
 */
export function conductorThermal(physics: ConductorPhysics): ConductorThermal {
  const r0 = physics.diameterM / 2;
  const insulation = physics.insulation;
  if (insulation === null) {
    return {
      physics,
      insulationResistanceKMPerW: 0,
      outerDiameterM: physics.diameterM,
      emissivity: BARE_CONDUCTOR_EMISSIVITY.value,
    };
  }
  const r1 = r0 + insulation.thicknessM;
  let resistance = lnRatio(r1 / r0) / (TWO_PI * insulation.conductivityWPerMK);
  let outer = r1;
  if (insulation.jacketThicknessM !== null && insulation.jacketConductivityWPerMK !== null) {
    const r2 = r1 + insulation.jacketThicknessM;
    resistance += lnRatio(r2 / r1) / (TWO_PI * insulation.jacketConductivityWPerMK);
    outer = r2;
  }
  return {
    physics,
    insulationResistanceKMPerW: resistance,
    outerDiameterM: 2 * outer,
    emissivity: insulation.emissivity,
  };
}

/**
 * The surface heat-transfer coefficient h = h_conv + h_rad (W/(m²·K)) at surface temperature
 * `surfaceK` in still air at `ambientK`: h_conv = 1.32 (ΔT/D)^¼ (ΔT ≥ 0), and h_rad = ε σ (T_s² + T_a²)
 * (T_s + T_a), the exact linearisation of ε σ (T_s⁴ − T_a⁴), always on.
 */
export function surfaceCoefficientWPerM2K(thermal: ConductorThermal, surfaceK: number, ambientK: number): number {
  const rise = surfaceK > ambientK ? surfaceK - ambientK : 0;
  const convection = H_CONV * Math.sqrt(Math.sqrt(rise / thermal.outerDiameterM));
  const radiation = thermal.emissivity * SIGMA * (surfaceK * surfaceK + ambientK * ambientK) * (surfaceK + ambientK);
  return convection + radiation;
}

/**
 * G′, the conductance from the conductor at `conductorK` to the air at `ambientK`, per metre
 * (W/(m·K)): the insulation in series with the surface. The surface temperature comes from the
 * conductor's by exactly one fixed-point step (`SURFACE_ITERATIONS`), which _is_ the model:
 * h₀ = h(T_c); T_s = T_a + (T_c − T_a) · R′_s(h₀) / (R′_ins + R′_s(h₀)); h₁ = h(T_s); G′ = 1 / (R′_ins + R′_s(h₁)),
 * with R′_s(h) = 1 / (h π D).
 */
export function conductanceToAirWPerMK(thermal: ConductorThermal, conductorK: number, ambientK: number): number {
  const circumference = Math.PI * thermal.outerDiameterM;
  const insulation = thermal.insulationResistanceKMPerW;
  const surface0 = 1 / (surfaceCoefficientWPerM2K(thermal, conductorK, ambientK) * circumference);
  const surfaceK = ambientK + ((conductorK - ambientK) * surface0) / (insulation + surface0);
  const surface1 = 1 / (surfaceCoefficientWPerM2K(thermal, surfaceK, ambientK) * circumference);
  return 1 / (insulation + surface1);
}

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
