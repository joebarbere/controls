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
 * no record. F2.5 (protocol 4): the incandescent lamp, the resistor and the heater, the fuse and the
 * thermal-magnetic breaker.
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
  'lamp.incandescent': Object.freeze({
    kind: 'lamp.incandescent',
    recordBytes: 56,
    fields: Object.freeze([
      f64('powerW', 0, 'W'),
      f64('currentA', 8, 'A'),
      f64('voltageV', 16, 'V'),
      f64('resistanceOhm', 24, 'Ω'),
      f64('filamentTempK', 32, 'K'),
      f64('lightOutputRel', 40, null),
      status(48),
    ]),
  }),
  resistor: Object.freeze({
    kind: 'resistor',
    recordBytes: 32,
    fields: Object.freeze([
      f64('voltageV', 0, 'V'),
      f64('currentA', 8, 'A'),
      f64('powerW', 16, 'W'),
      u8Enum('overRated', 24, ['no', 'yes']),
      status(25),
    ]),
  }),
  heater: Object.freeze({
    kind: 'heater',
    recordBytes: 32,
    fields: Object.freeze([f64('voltageV', 0, 'V'), f64('currentA', 8, 'A'), f64('powerW', 16, 'W'), status(24)]),
  }),
  fuse: Object.freeze({
    kind: 'fuse',
    recordBytes: 24,
    fields: Object.freeze([
      f64('currentA', 0, 'A'),
      f64('meltFraction', 8, null),
      u8Enum('state', 16, ['intact', 'blown']),
      status(17),
    ]),
  }),
  'breaker.thermalMagnetic': Object.freeze({
    kind: 'breaker.thermalMagnetic',
    recordBytes: 32,
    fields: Object.freeze([
      f64('currentA', 0, 'A'),
      f64('thermalFraction', 8, null),
      f64('magneticPickupA', 16, 'A'),
      u8Enum('state', 24, ['off', 'on', 'tripped']),
      status(25),
    ]),
  }),
});

/** One device record's fields by name: a number, or an enum field's value name (`status: 'solved'`). */
export type DecodedDeviceRecord = Readonly<Record<string, number | string>>;

/**
 * Decodes the record laid out by `schema` at byte `offset` of `data`: every field by name, enums by
 * their value names (a code past the table stays a number). The one record decoder: the headless
 * `SimEngine.deviceRecord` (and so `game.device`) uses it, and a panel decoding a whole record from a
 * snapshot would too. Allocates; per-frame readers resolve `FieldRef`s instead (`DescriptorIndex`).
 */
export function decodeDeviceRecord(schema: DeviceOutputSchema, data: DataView, offset: number): DecodedDeviceRecord {
  const values: Record<string, number | string> = {};
  for (const field of schema.fields) {
    const at = offset + field.offset;
    switch (field.type) {
      case 'f64':
        values[field.name] = data.getFloat64(at, true);
        break;
      case 'u32':
        values[field.name] = data.getUint32(at, true);
        break;
      case 'i32':
        values[field.name] = data.getInt32(at, true);
        break;
      default: {
        const code = data.getUint8(at);
        values[field.name] = field.values === null ? code : (field.values[code] ?? code);
      }
    }
  }
  return values;
}

/**
 * The nominal voltage bands an island can be in (ADR 0011 §5.3), by index, for the overlays' scales
 * (protocol 5, F2.6). Index 0, `none`, means "no scale", never the first bin of one. The engine
 * chooses an island's band from its sources' nameplates (`sim-core` `engine/bands.ts`); the overlays
 * look scales up by **name**, so a name is never changed. Appending a band bumps `SIM_PROTOCOL_VERSION`.
 *
 * - `dc12`: a 12 V DC system (the 12 V lead-acid battery);
 * - `dc24`: a 24 V DC system (the DIN-rail control supply);
 * - `ac120-240`: the 120/240 V split-phase service (and the portable generator);
 * - `ac208y120`: the 208Y/120 V three-phase service;
 * - `ac480y277`: the 480Y/277 V three-phase service.
 */
export const NOMINAL_BANDS: readonly string[] = Object.freeze([
  'none',
  'dc12',
  'dc24',
  'ac120-240',
  'ac208y120',
  'ac480y277',
]);

/** `NOMINAL_BANDS`' index 0: no scale (no source, a source without a fixed nominal, or disagreeing sources). */
export const NOMINAL_BAND_NONE = 0;
