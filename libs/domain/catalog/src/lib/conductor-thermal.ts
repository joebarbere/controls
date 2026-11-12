import type { ConductorResistanceData } from './conductor';
import type { LeadParams } from './model-kinds';
import {
  BARE_CONDUCTOR_EMISSIVITY,
  H_CONV_COEFF,
  LORENZ_NUMBER,
  STEFAN_BOLTZMANN,
  THERMAL_MIN_TAU_S,
} from './thermal-constants';

/*
 * A conductor's heat path in free air (ADR 0018 §3.2, §3.3): the insulation's conduction, the
 * surface's convection and radiation, the fin conductance a termination hot spot sees, and the
 * conservative time-constant bounds the catalogue checks at load (§3.4). F3.1 landed the static
 * pieces in sim-core for its derived ampacity; F3.6 part 1 moved them here, beside
 * `conductorResistanceOhm`, so the catalogue's load check and the engine's connection thermal bank
 * evaluate one heat path. sim-core re-exports every function.
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

/** A conductor's insulation as the thermal model reads it (ADR 0018 §3.2), SI units. */
export interface ThermalInsulationData {
  /** The insulation wall t₁ (m). */
  readonly thicknessM: number;
  /** Its thermal conductivity k₁ (W/(m·K)). */
  readonly conductivityWPerMK: number;
  /** The outer jacket wall t₂ (m), or `null` for a single layer. */
  readonly jacketThicknessM: number | null;
  /** The jacket's thermal conductivity k₂ (W/(m·K)), or `null` for a single layer. */
  readonly jacketConductivityWPerMK: number | null;
  /** The outer surface's emissivity ε. */
  readonly emissivity: number;
}

/**
 * Everything the thermal model reads about a conductor line, resolved and in SI: a conductor entry's
 * `ConductorPhysics`, or a test lead's (`leadThermalLine`).
 */
export interface ThermalLineData extends ConductorResistanceData {
  /** The solid-round diameter of the metal (m). */
  readonly diameterM: number;
  /** The metal's density (kg/m³) and specific heat (J/(kg·K)): C′ = ρ_m · c_p · A (metal only, §3.2). */
  readonly densityKgM3: number;
  readonly specificHeatJPerKgK: number;
  /** The insulation, or `null` for a bare conductor. */
  readonly insulation: ThermalInsulationData | null;
}

/** The static half of a conductor's heat path, computed once per entry (ADR 0018 §3.2). */
export interface ConductorThermal {
  readonly physics: ThermalLineData;
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
export function conductorThermal(physics: ThermalLineData): ConductorThermal {
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
 * h = h_conv + h_rad (W/(m²·K)) of a surface of outer diameter `outerDiameterM` and emissivity
 * `emissivity` at `surfaceK` in still air at `ambientK`: h_conv = 1.32 (ΔT/D)^¼ (ΔT ≥ 0), and
 * h_rad = ε σ (T_s² + T_a²) (T_s + T_a), the exact linearisation of ε σ (T_s⁴ − T_a⁴), always on. The
 * scalar kernel the connection thermal bank calls on its struct-of-arrays data.
 */
export function surfaceCoefficientOf(
  outerDiameterM: number,
  emissivity: number,
  surfaceK: number,
  ambientK: number,
): number {
  const rise = surfaceK > ambientK ? surfaceK - ambientK : 0;
  const convection = H_CONV * Math.sqrt(Math.sqrt(rise / outerDiameterM));
  const radiation = emissivity * SIGMA * (surfaceK * surfaceK + ambientK * ambientK) * (surfaceK + ambientK);
  return convection + radiation;
}

/** {@link surfaceCoefficientOf} for a conductor's thermal data. */
export function surfaceCoefficientWPerM2K(thermal: ConductorThermal, surfaceK: number, ambientK: number): number {
  return surfaceCoefficientOf(thermal.outerDiameterM, thermal.emissivity, surfaceK, ambientK);
}

/**
 * G′ (W/(m·K)) from a conductor at `conductorK` to the air at `ambientK`, per metre, from its static
 * heat-path data: the insulation in series with the surface. The surface temperature comes from the
 * conductor's by exactly one fixed-point step (`SURFACE_ITERATIONS`), which _is_ the model:
 * h₀ = h(T_c); T_s = T_a + (T_c − T_a) · R′_s(h₀) / (R′_ins + R′_s(h₀)); h₁ = h(T_s); G′ = 1 / (R′_ins + R′_s(h₁)),
 * with R′_s(h) = 1 / (h π D). The scalar kernel the bank calls.
 */
export function conductanceToAirOf(
  insulationResistanceKMPerW: number,
  outerDiameterM: number,
  emissivity: number,
  conductorK: number,
  ambientK: number,
): number {
  const circumference = Math.PI * outerDiameterM;
  const insulation = insulationResistanceKMPerW;
  const surface0 = 1 / (surfaceCoefficientOf(outerDiameterM, emissivity, conductorK, ambientK) * circumference);
  const surfaceK = ambientK + ((conductorK - ambientK) * surface0) / (insulation + surface0);
  const surface1 = 1 / (surfaceCoefficientOf(outerDiameterM, emissivity, surfaceK, ambientK) * circumference);
  return 1 / (insulation + surface1);
}

/** {@link conductanceToAirOf} for a conductor's thermal data. */
export function conductanceToAirWPerMK(thermal: ConductorThermal, conductorK: number, ambientK: number): number {
  return conductanceToAirOf(
    thermal.insulationResistanceKMPerW,
    thermal.outerDiameterM,
    thermal.emissivity,
    conductorK,
    ambientK,
  );
}

/** C′ = ρ_m · c_p · A, the metal's heat capacity per metre (J/(m·K)); insulation left out (§3.2, §3.6). */
export function heatCapacityPerMetre(physics: ThermalLineData): number {
  return physics.densityKgM3 * physics.specificHeatJPerKgK * physics.areaM2;
}

/** The metal's Wiedemann–Franz thermal conductivity k = L₀ · T₀ / ρ₀ (W/(m·K), ADR 0018 §3.3), at T₀. */
export function thermalConductivityWPerMK(physics: ConductorResistanceData): number {
  return (LORENZ_NUMBER.value * physics.referenceTemperatureK) / physics.resistivityOhmM;
}

/**
 * A test lead's thermal line (D2, ADR 0018 §8): its copper, its cross-section (taken solid-round:
 * d = √(4A/π)), no lay factor (a lead's static value is v2's), and one insulation layer from its six
 * thermal params.
 */
export function leadThermalLine(params: LeadParams): ThermalLineData {
  return {
    resistivityOhmM: params.resistivityOhmM,
    temperatureCoefficientPerK: params.temperatureCoefficientPerK,
    referenceTemperatureK: params.referenceTemperatureK,
    linearAlphaMaxK: params.linearAlphaMaxK,
    areaM2: params.conductorAreaM2,
    layFactor: 1,
    diameterM: Math.sqrt((4 * params.conductorAreaM2) / Math.PI),
    densityKgM3: params.densityKgM3,
    specificHeatJPerKgK: params.specificHeatJPerKgK,
    insulation: {
      thicknessM: params.insulationThicknessMm / 1000,
      conductivityWPerMK: params.insulationConductivityWPerMK,
      jacketThicknessM: null,
      jacketConductivityWPerMK: null,
      emissivity: params.surfaceEmissivity,
    },
  };
}

/**
 * The G′ the time-constant bounds use (W/(m·K), §3.4): an insulated conductor's surface resistance → 0
 * leaves 1/R′_ins, a true upper bound. A bare one's G′ is taken at the top of its linear-α range, with
 * the ambient at its material's reference temperature (20 °C, the game's ambient; sim-core pins the
 * equality): **not** a true upper bound, since h keeps rising above T_lin (a bare conductor far past
 * 200 °C has a shorter τ than this), and it relies on the ambient being T₀. The built-in bare entries
 * pass with a 45× margin.
 */
export function maxConductanceToAirWPerMK(thermal: ConductorThermal): number {
  if (thermal.insulationResistanceKMPerW > 0) return 1 / thermal.insulationResistanceKMPerW;
  const physics = thermal.physics;
  return conductanceToAirWPerMK(thermal, physics.linearAlphaMaxK, physics.referenceTemperatureK);
}

/** A conservative lower bound on a conductor node's time constant C′/G′ (s, §3.4). */
export function conductorTauMinS(thermal: ConductorThermal): number {
  return heatCapacityPerMetre(thermal.physics) / maxConductanceToAirWPerMK(thermal);
}

/** The largest fin conductance √(G′ k A) the conductor can give a termination hot spot (W/K, §3.3, §3.4). */
export function maxFinConductanceWPerK(thermal: ConductorThermal): number {
  const physics = thermal.physics;
  return Math.sqrt(maxConductanceToAirWPerMK(thermal) * thermalConductivityWPerMK(physics) * physics.areaM2);
}

/** Whether a time constant passes the load check (§3.4): at least `THERMAL_MIN_TAU_S`. */
export function thermalTauAllowed(tauS: number): boolean {
  return tauS >= THERMAL_MIN_TAU_S.value;
}
