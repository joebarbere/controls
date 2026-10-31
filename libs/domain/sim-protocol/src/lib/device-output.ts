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
 * A record's `status` field values, by code (ADR 0011 §5.4, amended in F2.4): `unsolved` (0, so a
 * zeroed record is never a reading), `solved` (a reading), `unsettled` (the outer loop hit its cap),
 * `singular` (a loop of ideal sources). A record's solved quantities are a reading only when `solved`.
 */
export const RECORD_STATUS_VALUES: readonly string[] = Object.freeze(['unsolved', 'solved', 'unsettled', 'singular']);

const f64 = (name: string, offset: number, unit: string | null): DeviceOutputField =>
  Object.freeze({ name, type: 'f64', offset, unit, values: null });
const u8Enum = (name: string, offset: number, values: readonly string[]): DeviceOutputField =>
  Object.freeze({ name, type: 'u8', offset, unit: null, values: Object.freeze([...values]) });
const status = (offset: number): DeviceOutputField => u8Enum('status', offset, RECORD_STATUS_VALUES);

/**
 * The output schemas of the built-in device models, by kind: the protocol's table (ADR 0011 §5.4).
 * Each device-model PR registers its kind's schema here and bumps `SIM_PROTOCOL_VERSION`; sim-core's
 * `BUILTIN_DEVICE_OUTPUTS` (what the models write) must equal it exactly, which a sim-core spec
 * checks. F2.4 (protocol 3): the battery, the bench supply and the DIN PSU. The AC services publish
 * no record.
 */
export const DEVICE_OUTPUT_SCHEMAS: Readonly<Record<string, DeviceOutputSchema>> = Object.freeze({
  battery: Object.freeze({
    kind: 'battery',
    recordBytes: 40,
    fields: Object.freeze([
      f64('emfV', 0, 'V'),
      f64('terminalV', 8, 'V'),
      f64('currentA', 16, 'A'),
      f64('stateOfCharge', 24, null),
      status(32),
    ]),
  }),
  'supply.bench': Object.freeze({
    kind: 'supply.bench',
    recordBytes: 24,
    fields: Object.freeze([
      f64('outputV', 0, 'V'),
      f64('outputA', 8, 'A'),
      u8Enum('mode', 16, ['off', 'cv', 'cc']),
      status(17),
    ]),
  }),
  'supply.dinPsu': Object.freeze({
    kind: 'supply.dinPsu',
    recordBytes: 24,
    fields: Object.freeze([
      f64('outputV', 0, 'V'),
      f64('outputA', 8, 'A'),
      u8Enum('mode', 16, ['ok', 'limit', 'hiccupOff']),
      status(17),
    ]),
  }),
});

/**
 * The nominal voltage bands an island can be in (ADR 0011 §5.3), by index, for the overlays' scales.
 * F2.3a has only `none` (index 0): the band is chosen from the island's source nameplates and
 * setpoints, which the source models of F2.4 provide. Appending a band bumps `SIM_PROTOCOL_VERSION`.
 */
export const NOMINAL_BANDS: readonly string[] = Object.freeze(['none']);
