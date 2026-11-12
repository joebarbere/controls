import { Extensions, FiniteNumber, Int, SafeString } from '@controls/save-format';
import * as z from 'zod';
import { CatalogSource } from './sources';
import { ColourId, TableKey, TableName } from './registries';

/*
 * Catalogue tables (catalogue v2, D3, ADR 0016): shared physical data that entries pin by
 * `{ table, version, key }`. One file per table version in `content/tables/` (`<table>.v<version>.json`),
 * mirrored into `builtin-tables.generated.ts`. A table version, once shipped, is frozen: a changed value
 * is a new table version, and only new entry versions point at it, so an old save's entries keep
 * meaning what they meant.
 *
 * The colour table is the exception that proves the rule: its **ids** are append-only across every
 * version (an id once shipped is never removed or renamed, ADR 0015), because saves hold colour ids
 * directly (`ConductorColourV3`), not pinned refs. Its display values may change.
 *
 * Every sourced field of every row is covered by a source (`rows.<key>.<field>`, or an ancestor
 * `rows.<key>`, or `rows.*.<field>` for a column).
 */

const Label = (max: number) => SafeString.min(1).max(max);
const positive = FiniteNumber.positive();

/** A pinned table row: the table, its version and the row key. */
export const TableRef = z
  .strictObject({ table: TableName, version: Int.min(1), key: TableKey })
  .meta({ id: 'TableRef', description: 'A pinned catalogue table row: { table, version, key }.' });
export type TableRef = z.infer<typeof TableRef>;

/** A conductor material (`materials` table): resistivity and its temperature coefficient, density, heat capacity. */
export const MaterialRow = z
  .strictObject({
    /** What it is (`Annealed copper`). */
    name: Label(80),
    /** Conductivity in percent of the International Annealed Copper Standard (100 for annealed copper). */
    conductivityIacsPercent: positive,
    /** Volume resistivity ρ₀ at the reference temperature (Ω·m). */
    resistivityOhmM: positive,
    /** The reference temperature T₀ of ρ₀ and α (K). */
    referenceTemperatureK: positive,
    /** Temperature coefficient of resistance α at T₀ (1/K): R(T) = R₀ (1 + α (T − T₀)). */
    temperatureCoefficientPerK: FiniteNumber.min(0),
    /** The top of the range where the linear α model holds (K): the engine clamps R(T) there (D7). */
    linearAlphaMaxK: positive,
    /** Density (kg/m³). */
    densityKgM3: positive,
    /** Specific heat capacity near room temperature (J/(kg·K)), taken as constant. */
    specificHeatJPerKgK: positive,
    /**
     * The melting point (K): a conductor or termination node that reaches it burns open, and the
     * engine never reports a node above it (F3.6 part 2, ADR 0018 §5).
     */
    meltingPointK: positive,
  })
  .refine((r) => r.linearAlphaMaxK > r.referenceTemperatureK, {
    message: 'linearAlphaMaxK must be above the reference temperature',
  })
  .refine((r) => r.meltingPointK > r.linearAlphaMaxK, {
    message: 'meltingPointK must be above linearAlphaMaxK',
  });
export type MaterialRow = z.infer<typeof MaterialRow>;

/** A conductor insulation or cable jacket (`insulation` table): ratings and thermal properties. */
export const InsulationRow = z
  .strictObject({
    /** The type designation (`THHN/THWN-2`). */
    name: Label(80),
    /** What it is made of (`PVC with a nylon jacket`). Display text. */
    material: Label(120),
    /** Maximum conductor operating temperature in dry locations (K). */
    ratedTempDryK: positive,
    /** In wet locations (K), or `null` where the type isn't rated for them. */
    ratedTempWetK: positive.nullable(),
    /** Thermal conductivity of the (main) insulation layer (W/(m·K)). */
    thermalConductivityWPerMK: positive,
    /** Of an outer jacket layer (nylon on THHN), or `null` for a single layer. */
    jacketThermalConductivityWPerMK: positive.nullable(),
    /** Total hemispherical emissivity of the outer surface, for radiation (0 to 1). */
    emissivity: FiniteNumber.gt(0).max(1),
  })
  .refine((r) => r.ratedTempWetK === null || r.ratedTempWetK <= r.ratedTempDryK, {
    message: 'a wet rating is never above the dry rating',
  });
export type InsulationRow = z.infer<typeof InsulationRow>;

/** A colour (`colours` table): its name and a display colour. Saves hold the id. */
export const ColourRow = z.strictObject({
  /** What the player reads (`Green`). */
  name: Label(40),
  /** Display colour, sRGB `#rrggbb` (lower case). Display only: never part of any check. */
  srgb: z.string().regex(/^#[0-9a-f]{6}$/),
});
export type ColourRow = z.infer<typeof ColourRow>;

export interface TableKindDef {
  readonly name: string;
  readonly row: z.ZodType<Readonly<Record<string, unknown>>>;
  /** The row fields that need a source (labels and display names don't). */
  readonly sourced: readonly string[];
  /** The key grammar of the table's rows, if narrower than {@link TableKey}. */
  readonly keys: z.ZodType<string>;
  readonly description: string;
}

/** Every table the catalogue knows, by name. Adding one is a catalogue-format change (ADR 0016). */
export const TABLE_KINDS: Readonly<Record<string, TableKindDef>> = Object.freeze({
  colours: {
    name: 'colours',
    row: ColourRow,
    sourced: ['srgb'],
    keys: ColourId,
    description: 'Insulation, stripe and jacket colours: append-only ids (ADR 0015) with display values.',
  },
  insulation: {
    name: 'insulation',
    row: InsulationRow,
    sourced: [
      'ratedTempDryK',
      'ratedTempWetK',
      'thermalConductivityWPerMK',
      'jacketThermalConductivityWPerMK',
      'emissivity',
    ],
    keys: TableKey,
    description: 'Conductor insulation types and cable jackets: temperature ratings and thermal properties.',
  },
  materials: {
    name: 'materials',
    row: MaterialRow,
    sourced: [
      'conductivityIacsPercent',
      'resistivityOhmM',
      'referenceTemperatureK',
      'temperatureCoefficientPerK',
      'linearAlphaMaxK',
      'densityKgM3',
      'specificHeatJPerKgK',
      'meltingPointK',
    ],
    keys: TableKey,
    description:
      'Conductor metals: resistivity and α at a reference temperature, density, specific heat, melting point.',
  },
} satisfies Record<string, TableKindDef>);

/** A table kind by name (own properties only), or `undefined`. */
export function tableKind(name: string): TableKindDef | undefined {
  return Object.prototype.hasOwnProperty.call(TABLE_KINDS, name) ? TABLE_KINDS[name] : undefined;
}

/** One table version: a file in `content/tables/`. Rows are checked against the table kind's row schema. */
export const TableDocument = z
  .strictObject({
    table: TableName,
    version: Int.min(1),
    title: Label(80),
    /** Rows by key. Their shape is the table kind's (checked by `parseCatalog`). */
    rows: z.record(TableKey, z.record(z.string().max(64), z.unknown())),
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls catalogue table, catalogue format v2',
    description:
      'One file in content/tables/ (ADR 0016). Zod in @controls/catalog is authoritative; the row shape of each table (materials, insulation, colours) and source coverage are checked by parseCatalog.',
  });
export type TableDocument = z.infer<typeof TableDocument>;
