import type { Catalog } from './catalog';
import type { ThermalInsulationData, ThermalLineData } from './conductor-thermal';
import type { DeviceDefinition } from './device';
import { gaugeRow } from './gauge';
import type { ConductorParams } from './model-kinds';
import type { ConductorStranding } from './registries';
import type { InsulationRow, MaterialRow } from './tables';

/*
 * Conductor physics data and resistance (F3.1, ADR 0018 §2). A conductor's resistance is derived from
 * its material, size, length and temperature, never tabulated (realism charter; no NEC or conductor
 * tables, ADR 0003). Only `+ − × ÷`, so the result is bit-identical in every JavaScript engine (D6), and
 * sim-core may call it: the netlist compiler at T₀ for the static value, the F3.6 thermal bank at the
 * conductor's temperature, so the two can't disagree.
 */

/** What `conductorResistanceOhm` reads: the material row's ρ₀, α, T₀ and clamp, and the entry's size. */
export interface ConductorResistanceData {
  /** Volume resistivity ρ₀ at `referenceTemperatureK` (Ω·m). */
  readonly resistivityOhmM: number;
  /** Temperature coefficient of resistance α at T₀ (1/K). */
  readonly temperatureCoefficientPerK: number;
  /** T₀ (K). */
  readonly referenceTemperatureK: number;
  /** The top of the linear-α range (K): R(T) is clamped there (ADR 0018 §2, D7). */
  readonly linearAlphaMaxK: number;
  /** The nominal cross-section A (m²), from the AWG definition. */
  readonly areaM2: number;
  /** The stranding lay factor k_lay (1 for solid). */
  readonly layFactor: number;
}

/** A conductor's insulation as the thermal model reads it (ADR 0018 §3.2), SI units, with its ratings. */
export interface ConductorInsulationData extends ThermalInsulationData {
  /** The insulation's dry and wet temperature ratings (K; wet `null` where not rated). */
  readonly ratedTempDryK: number;
  readonly ratedTempWetK: number | null;
}

/** Everything the electrical and thermal models read about one conductor entry, resolved and in SI. */
export interface ConductorPhysics extends ThermalLineData {
  /** Its AWG designation (4/0 = −3). */
  readonly awg: number;
  readonly stranding: ConductorStranding;
  /**
   * The solid-round diameter of the nominal area (m), from the AWG definition. A stranded conductor
   * is taken at this diameter too (an abstraction for the thermal model: concentric strands sit up
   * to about 15 % wider, compact strands about at it).
   */
  readonly diameterM: number;
  /** The insulation, or `null` for a bare conductor. */
  readonly insulation: ConductorInsulationData | null;
}

/**
 * The resolved physics of a conductor entry: its gauge row, pinned material and insulation rows, and
 * its params. `undefined` for anything that isn't a conductor entry with `ConductorParams` (a lead,
 * a placed device, a test kind without a lay factor). Throws only if the catalogue is inconsistent
 * (a pinned row missing), which `parseCatalog` rules out.
 */
export function conductorPhysics(
  catalog: Pick<Catalog, 'tableRow'>,
  device: DeviceDefinition,
): ConductorPhysics | undefined {
  const spec = device.conductor;
  const layFactor = device.model.params['layFactor'];
  if (spec === null || layFactor === undefined) return undefined;
  const gauge = gaugeRow(spec.awg);
  const material = catalog.tableRow(spec.material) as MaterialRow | undefined;
  const insulation = spec.insulation === null ? null : (catalog.tableRow(spec.insulation) as InsulationRow | undefined);
  if (gauge === undefined || material === undefined || insulation === undefined) {
    throw new Error(`conductorPhysics: ${device.id}@${device.version} pins a row its catalogue lacks`);
  }
  const params: ConductorParams = { layFactor };
  return {
    awg: spec.awg,
    stranding: spec.stranding,
    areaM2: gauge.areaMm2 / 1e6,
    diameterM: gauge.diameterMm / 1000,
    layFactor: params.layFactor,
    resistivityOhmM: material.resistivityOhmM,
    temperatureCoefficientPerK: material.temperatureCoefficientPerK,
    referenceTemperatureK: material.referenceTemperatureK,
    linearAlphaMaxK: material.linearAlphaMaxK,
    densityKgM3: material.densityKgM3,
    specificHeatJPerKgK: material.specificHeatJPerKgK,
    meltingPointK: material.meltingPointK,
    insulation:
      insulation === null
        ? null
        : {
            thicknessM: (spec.insulationThicknessMm as number) / 1000,
            conductivityWPerMK: insulation.thermalConductivityWPerMK,
            jacketThicknessM: spec.jacketThicknessMm === null ? null : spec.jacketThicknessMm / 1000,
            jacketConductivityWPerMK: insulation.jacketThermalConductivityWPerMK,
            emissivity: insulation.emissivity,
            ratedTempDryK: insulation.ratedTempDryK,
            ratedTempWetK: insulation.ratedTempWetK,
          },
  };
}

/**
 * A conductor's resistance (Ω) over `lengthMm` at `temperatureK` (ADR 0018 §2):
 *
 * R = ρ₀ · k_lay · L / A · (1 + α · (T_e − T₀)), T_e = min(T, T_lin).
 *
 * Above the material's linear-α range R stays at its value there (an abstraction: a real conductor's
 * resistance keeps rising, slightly faster). No lower clamp: the engine never takes a conductor below
 * ambient, inside copper's linear range.
 */
export function conductorResistanceOhm(data: ConductorResistanceData, lengthMm: number, temperatureK: number): number {
  const effectiveK = temperatureK < data.linearAlphaMaxK ? temperatureK : data.linearAlphaMaxK;
  const atReference = (data.resistivityOhmM * data.layFactor * (lengthMm / 1000)) / data.areaM2;
  return atReference * (1 + data.temperatureCoefficientPerK * (effectiveK - data.referenceTemperatureK));
}
