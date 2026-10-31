/*
 * Device output records (ADR 0011 §5.4): what a device model publishes in the snapshot's device
 * section, in fixed-width records laid out by its kind's schema. Every schema is part of the protocol
 * (`SIM_PROTOCOL_VERSION`): adding a kind or a field bumps it.
 */

export type DeviceOutputFieldType = 'f64' | 'u32' | 'i32' | 'u8';

export interface DeviceOutputField {
  readonly name: string;
  readonly type: DeviceOutputFieldType;
  /** Naturally aligned within the record. */
  readonly offset: number;
  /** An SI symbol (`W`, `K`, `V`, `A`), or `null` for ratios and enums. */
  readonly unit: string | null;
  /** `u8` enums: the code-to-name table; `null` otherwise. */
  readonly values: readonly string[] | null;
}

export interface DeviceOutputSchema {
  /** The catalogue model kind, e.g. `lamp.incandescent`. */
  readonly kind: string;
  /** A multiple of 8. */
  readonly recordBytes: number;
  readonly fields: readonly DeviceOutputField[];
}

const FIELD_BYTES: Readonly<Record<DeviceOutputFieldType, number>> = { f64: 8, u32: 4, i32: 4, u8: 1 };
/** Fields are ordered f64, then the 4-byte types, then u8. */
const FIELD_RANK: Readonly<Record<DeviceOutputFieldType, number>> = { f64: 0, u32: 1, i32: 1, u8: 2 };
const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,63}$/;

/**
 * The problems with a device output schema (empty when it is valid): the record a multiple of 8;
 * fields with unique lower-camelCase names, naturally aligned, in bounds, not overlapping, ordered
 * f64 then 4-byte then u8, and enum tables only on u8 fields.
 */
export function deviceOutputSchemaProblems(schema: DeviceOutputSchema): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(schema.recordBytes) || schema.recordBytes <= 0 || schema.recordBytes % 8 !== 0) {
    problems.push('recordBytes must be a positive multiple of 8');
  }
  const names = new Set<string>();
  let end = 0;
  let rank = 0;
  for (const field of schema.fields) {
    const size = FIELD_BYTES[field.type];
    if (!FIELD_NAME.test(field.name)) problems.push(`${field.name}: not a lower camelCase name`);
    if (names.has(field.name)) problems.push(`${field.name}: repeated`);
    names.add(field.name);
    if (!Number.isInteger(field.offset) || field.offset % size !== 0) problems.push(`${field.name}: not aligned`);
    if (field.offset < end) problems.push(`${field.name}: overlaps the field before it`);
    if (field.offset + size > schema.recordBytes) problems.push(`${field.name}: past the end of the record`);
    if (FIELD_RANK[field.type] < rank) problems.push(`${field.name}: out of order (f64, then 4-byte, then u8)`);
    if (field.values !== null && field.type !== 'u8') problems.push(`${field.name}: only u8 fields have enum values`);
    rank = FIELD_RANK[field.type];
    end = field.offset + size;
  }
  return problems;
}

/**
 * The output schemas of the built-in device models, by kind. Empty in F2.3a: no built-in device
 * model publishes a record yet. ADR 0011 §5.4's table is provisional; each device-model PR (F2.4's
 * battery and supplies, F2.5's lamp, fuse, breaker, resistor and heater) adds its kind's schema here,
 * finalised with `renderer-engineer` and `angular-ui-engineer`, and bumps `SIM_PROTOCOL_VERSION`.
 */
export const DEVICE_OUTPUT_SCHEMAS: Readonly<Record<string, DeviceOutputSchema>> = Object.freeze({});

/**
 * The nominal voltage bands an island can be in (ADR 0011 §5.3), by index, for the overlays' scales.
 * F2.3a has only `none` (index 0): the band is chosen from the island's source nameplates and
 * setpoints, which the source models of F2.4 provide. Appending a band bumps `SIM_PROTOCOL_VERSION`.
 */
export const NOMINAL_BANDS: readonly string[] = Object.freeze(['none']);
