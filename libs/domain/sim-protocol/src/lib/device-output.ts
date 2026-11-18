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
  /**
   * A unit symbol (`W`, `K`, `V`, `A`, `Ω`; protocol 8 adds the prefixed `mA` and `ms` its field names
   * carry, `residualMa`, `openingMs`), or `null` for ratios, enums and bit fields.
   */
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
const u8Bits = (name: string, offset: number): DeviceOutputField =>
  Object.freeze({ name, type: 'u8', offset, unit: null, values: null });
const status = (offset: number): DeviceOutputField => u8Enum('status', offset, RECORD_STATUS_VALUES);

/**
 * Why a breaker tripped, by code (protocol 8): `none` (0: not tripped), then the causes of a trip
 * ({@link TRIP_CAUSE_VALUES}). A record's `tripCause` and a `tripped` event's `detail.cause` use these
 * names; the catalogue's `TRIP_CAUSES` (the persisted `tripCause` key) is the same list, which a
 * sim-core spec pins.
 */
export const TRIP_CAUSE_VALUES = Object.freeze(['thermal', 'magnetic', 'groundFault', 'arcFault', 'test'] as const);
export type TripCauseValue = (typeof TRIP_CAUSE_VALUES)[number];
/** A record's `tripCause` field values by code: `none`, then {@link TRIP_CAUSE_VALUES}. */
export const RECORD_TRIP_CAUSE_VALUES: readonly string[] = Object.freeze(['none', ...TRIP_CAUSE_VALUES]);

/** A breaker's `state` values by code (the DIN breaker's, shared by every breaker kind): the handle and the trip. */
export const BREAKER_STATE_VALUES: readonly string[] = Object.freeze(['off', 'on', 'tripped']);

/**
 * The `readings` bits of a protocol 8 record that reads more than one island or a voltage between two
 * terminals (the GFCI and AFCI breakers): which electrical fields are a reading. A clear bit means no
 * reading (the field is written 0 and is never shown as 0 A or 0 V), whatever `status` says; the
 * connection records' rule (ADR 0011's protocol 7 amendment §3).
 */
export const DEVICE_READING_CURRENT = 1;
export const DEVICE_READING_NEUTRAL_CURRENT = 2;
export const DEVICE_READING_RESIDUAL = 4;
export const DEVICE_READING_LINE_VOLTAGE = 8;
export const DEVICE_READING_LOAD_VOLTAGE = 16;

/** The LED lamp's and fixture's record (protocol 8, pending): one layout for both kinds. */
function ledSchema(kind: string): DeviceOutputSchema {
  return Object.freeze({
    kind,
    recordBytes: 40,
    fields: Object.freeze([
      f64('powerW', 0, 'W'),
      f64('voltageV', 8, 'V'),
      f64('currentA', 16, 'A'),
      f64('lightOutputRel', 24, null),
      u8Enum('driverState', 32, ['off', 'running']),
      status(33),
    ]),
  });
}

/**
 * The output schemas of the built-in device models, by kind: the protocol's table (ADR 0011 §5.4).
 * Each device-model PR registers its kind's schema here and bumps `SIM_PROTOCOL_VERSION`; sim-core's
 * `BUILTIN_DEVICE_OUTPUTS` (what the models write) must equal it exactly, which a sim-core spec
 * checks. F2.4 (protocol 3): the battery, the bench supply and the DIN PSU. The AC services publish
 * no record. F2.5 (protocol 4): the incandescent lamp, the resistor and the heater, the fuse and the
 * thermal-magnetic breaker. P4 (protocol 8): the plug-on, GFCI and AFCI breakers, the service, the ground
 * rod, and the lamp's `burnedOut`.
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
      // Protocol 8: the sticky burnout (ADR 0019), own state, always written; `status` stays last.
      u8Enum('burnedOut', 48, ['no', 'yes']),
      status(49),
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
  // Protocol 8 (P4, ADR 0011's protocol 8 amendment): the residential kinds of engine 8. Every record
  // ends with the validity `status`; state, trip cause and every draw-relevant own-state field are
  // always written whatever the status (ADR 0019's co-sign conditions).
  'breaker.plugOn1p': Object.freeze({
    kind: 'breaker.plugOn1p',
    recordBytes: 40,
    fields: Object.freeze([
      f64('currentA', 0, 'A'),
      f64('thermalFraction', 8, null),
      f64('magneticPickupA', 16, 'A'),
      f64('openingMs', 24, 'ms'),
      u8Enum('state', 32, BREAKER_STATE_VALUES),
      u8Enum('tripCause', 33, RECORD_TRIP_CAUSE_VALUES),
      status(34),
    ]),
  }),
  'breaker.plugOn2p': Object.freeze({
    kind: 'breaker.plugOn2p',
    recordBytes: 64,
    fields: Object.freeze([
      f64('pole1CurrentA', 0, 'A'),
      f64('pole2CurrentA', 8, 'A'),
      f64('pole1ThermalFraction', 16, null),
      f64('pole2ThermalFraction', 24, null),
      f64('pole1MagneticPickupA', 32, 'A'),
      f64('pole2MagneticPickupA', 40, 'A'),
      f64('openingMs', 48, 'ms'),
      u8Enum('state', 56, BREAKER_STATE_VALUES),
      u8Enum('tripCause', 57, RECORD_TRIP_CAUSE_VALUES),
      status(58),
    ]),
  }),
  'breaker.gfci1p': Object.freeze({
    kind: 'breaker.gfci1p',
    recordBytes: 88,
    fields: Object.freeze([
      f64('currentA', 0, 'A'),
      f64('neutralCurrentA', 8, 'A'),
      f64('residualMa', 16, 'mA'),
      f64('lineVoltageV', 24, 'V'),
      f64('loadVoltageV', 32, 'V'),
      f64('thermalFraction', 40, null),
      f64('magneticPickupA', 48, 'A'),
      f64('openingMs', 56, 'ms'),
      f64('pickupMa', 64, 'mA'),
      f64('residualIntegral', 72, null),
      u8Enum('state', 80, BREAKER_STATE_VALUES),
      u8Enum('tripCause', 81, RECORD_TRIP_CAUSE_VALUES),
      u8Enum('testHeld', 82, ['no', 'yes']),
      u8Bits('readings', 83),
      status(84),
    ]),
  }),
  'breaker.afci1p': Object.freeze({
    kind: 'breaker.afci1p',
    recordBytes: 72,
    fields: Object.freeze([
      f64('currentA', 0, 'A'),
      f64('neutralCurrentA', 8, 'A'),
      f64('lineVoltageV', 16, 'V'),
      f64('loadVoltageV', 24, 'V'),
      f64('thermalFraction', 32, null),
      f64('magneticPickupA', 40, 'A'),
      f64('openingMs', 48, 'ms'),
      f64('arcExposure', 56, null),
      u8Enum('state', 64, BREAKER_STATE_VALUES),
      u8Enum('tripCause', 65, RECORD_TRIP_CAUSE_VALUES),
      u8Enum('arcingDownstream', 66, ['no', 'yes']),
      u8Bits('readings', 67),
      status(68),
    ]),
  }),
  'service.splitPhase': Object.freeze({
    kind: 'service.splitPhase',
    recordBytes: 64,
    fields: Object.freeze([
      f64('l1CurrentA', 0, 'A'),
      f64('l2CurrentA', 8, 'A'),
      f64('neutralCurrentA', 16, 'A'),
      f64('groundingCurrentA', 24, 'A'),
      f64('l1NeutralV', 32, 'V'),
      f64('l2NeutralV', 40, 'V'),
      f64('lineToLineV', 48, 'V'),
      status(56),
    ]),
  }),
  'electrode.groundRod': Object.freeze({
    kind: 'electrode.groundRod',
    recordBytes: 24,
    fields: Object.freeze([f64('currentA', 0, 'A'), f64('touchVoltageV', 8, 'V'), status(16)]),
  }),
});

/**
 * Protocol 8 record schemas agreed for kinds that are **not on main yet** (P4 PR 12's lighting, ADR
 * 0011's protocol 8 amendment): the LED lamp and fixture (`light.led`, `light.ledFixture`) and the
 * wall dimmer (`dimmer.wall`). The PR that adds a kind's engine model moves its schema from here into
 * {@link DEVICE_OUTPUT_SCHEMAS} unchanged, and the protocol fingerprint, which covers both tables as
 * one map, doesn't move. A kind is never in both (a sim-protocol spec checks it), and each passes
 * {@link deviceOutputSchemaProblems}. Appliances (P4 PR 13) have no reserved schema: their fields are
 * agreed in the amendment, their layout lands with their model.
 */
export const PENDING_DEVICE_OUTPUT_SCHEMAS: Readonly<Record<string, DeviceOutputSchema>> = Object.freeze({
  'dimmer.wall': Object.freeze({
    kind: 'dimmer.wall',
    recordBytes: 32,
    fields: Object.freeze([
      f64('levelRms', 0, null),
      f64('loadVoltageV', 8, 'V'),
      f64('currentA', 16, 'A'),
      u8Enum('state', 24, ['off', 'on']),
      status(25),
    ]),
  }),
  'light.led': ledSchema('light.led'),
  'light.ledFixture': ledSchema('light.ledFixture'),
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
