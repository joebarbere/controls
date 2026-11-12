/*
 * The conductor heat path (ADR 0018 §3.2, §3.3). F3.1 landed it here; F3.6 part 1 moved it to
 * `@controls/catalog` (the catalogue's load-time time-constant check evaluates it), and sim-core
 * re-exports it unchanged, beside the derived ampacity and the connection thermal bank.
 */
export {
  type ConductorThermal,
  conductanceToAirOf,
  conductanceToAirWPerMK,
  conductorTauMinS,
  conductorThermal,
  heatCapacityPerMetre,
  leadThermalLine,
  lnRatio,
  maxConductanceToAirWPerMK,
  maxFinConductanceWPerK,
  surfaceCoefficientOf,
  surfaceCoefficientWPerM2K,
  type ThermalInsulationData,
  type ThermalLineData,
  thermalConductivityWPerMK,
} from '@controls/catalog';
export * from './ampacity';
