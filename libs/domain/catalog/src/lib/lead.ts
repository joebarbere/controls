import type { LeadParams } from './model-kinds';

/*
 * Test-lead resistance, derived from the conductor's material and geometry (plan P2: never from NEC
 * tables, ADR 0003). Only `+ - * /`, so the result is bit-identical in every JavaScript engine
 * (decision D6), and sim-core may call it.
 */

/**
 * The conductor's resistance at `conductorTemperatureK` (Ω), by the linear model of a metal's
 * resistance against temperature: R(T) = ρ₀ · L / A · (1 + α · (T − T₀)).
 */
export function leadConductorResistanceOhm(params: LeadParams, conductorTemperatureK: number): number {
  const lengthM = params.lengthMm / 1000;
  const atReference = (params.resistivityOhmM * lengthM) / params.conductorAreaM2;
  return atReference * (1 + params.temperatureCoefficientPerK * (conductorTemperatureK - params.referenceTemperatureK));
}

/**
 * A lead's end-to-end resistance (Ω): the conductor at `conductorTemperatureK` plus the contact
 * resistance at each of its two ends. F2.1 compiles each lead to exactly one branch of this value.
 */
export function leadResistanceOhm(params: LeadParams, conductorTemperatureK: number): number {
  return leadConductorResistanceOhm(params, conductorTemperatureK) + 2 * params.contactResistanceOhm;
}
