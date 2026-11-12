import { type DeviceOutputField, type DeviceOutputSchema, RECORD_STATUS_VALUES } from './device-output';

/*
 * Connection records (protocol 7, F3.6 part 3; ADR 0015 "Protocol 7 connection records", finalised by
 * the ADR 0011 amendment): one fixed-width record per connection in the engine's thermal bank (every
 * lead and conductor of a known connection kind, netlisted or not), in connection-id order, in the
 * slot's connection section after the device section. Laid out by its kind's schema with the device
 * schemas' rules (`deviceOutputSchemaProblems`: f64 first, then 4-byte, then u8, padded to 8).
 *
 * The validity rule (ADR 0011 §5.4, amended): **solved** fields (`currentA`, the three drops and the
 * two end voltages) are a reading only when `status` is `solved`, and are written 0 otherwise; with
 * `status` `open` (the connection isn't netlisted) they are readings of exactly 0. **Own-state** fields
 * (the resistances and temperatures, the end states, `insulationDamaged`) are always written. An end
 * whose state is `none` (a lead's clip, an unlanded end, an end whose terminal has no method spec) has
 * no termination node: its temperature and contact fields are written 0 and readers treat them as
 * absent, never as 0 K or 0 Ω.
 *
 * Every schema is part of the protocol: changing a field or adding a kind bumps `SIM_PROTOCOL_VERSION`.
 */

/** A connection record's `status` values by code: the device records' four, then `open` (not netlisted). */
export const CONNECTION_RECORD_STATUS_VALUES: readonly string[] = Object.freeze([...RECORD_STATUS_VALUES, 'open']);
/** {@link CONNECTION_RECORD_STATUS_VALUES}' `open` code. */
export const CONNECTION_RECORD_OPEN = 4;

/**
 * An end's published state by code (ADR 0015): `none` (no termination node), `ok`, `intermittent`
 * (the persisted `intermittentClosed` and `intermittentOpen` both), `arcing`.
 */
export const CONNECTION_RECORD_END_STATES: readonly string[] = Object.freeze(['none', 'ok', 'intermittent', 'arcing']);
export const CONNECTION_END_NONE = 0;
export const CONNECTION_END_OK = 1;
export const CONNECTION_END_INTERMITTENT = 2;
export const CONNECTION_END_ARCING = 3;

/** A connection record's size in bytes (12 × f64 + 4 × u8, padded to 8). */
export const CONNECTION_RECORD_BYTES = 104;

/** A connection record's field offsets (the writer's and the tests' names for {@link CONNECTION_OUTPUT_FIELDS}). */
export const CONNECTION_RECORD_OFFSETS = Object.freeze({
  currentA: 0,
  conductorDropV: 8,
  endADropV: 16,
  endBDropV: 24,
  endAVolts: 32,
  endBVolts: 40,
  conductorResistanceOhm: 48,
  endAContactOhm: 56,
  endBContactOhm: 64,
  conductorTempK: 72,
  endATempK: 80,
  endBTempK: 88,
  endAState: 96,
  endBState: 97,
  insulationDamaged: 98,
  status: 99,
});

const f64 = (name: keyof typeof CONNECTION_RECORD_OFFSETS, unit: string | null): DeviceOutputField =>
  Object.freeze({ name, type: 'f64', offset: CONNECTION_RECORD_OFFSETS[name], unit, values: null });
const u8Enum = (name: keyof typeof CONNECTION_RECORD_OFFSETS, values: readonly string[]): DeviceOutputField =>
  Object.freeze({ name, type: 'u8', offset: CONNECTION_RECORD_OFFSETS[name], unit: null, values });

/**
 * The fields every connection kind publishes:
 *
 * - solved: `currentA` (|I|, RMS on AC; the direction is the branch's, `NetlistReadout.branchDirection`);
 *   `conductorDropV`, `endADropV`, `endBDropV` (magnitudes: the solved terminal-to-terminal voltage split
 *   in proportion to the conductor's and each end's resistance, so they add up to it); `endAVolts`,
 *   `endBVolts` (|V − V(islandReference)| at the conductor side of each end's contact, by the node
 *   voltages' rules; a lead's are its terminals' voltages, its clips being inside its conductor value);
 * - own state: `conductorResistanceOhm` (at its temperature; a lead's includes its two clip contacts),
 *   `endAContactOhm`, `endBContactOhm` (each end's value by its regime: ohmic, glowing or arcing at the
 *   solved current; the closed contact's ohmic value while the connection isn't netlisted),
 *   `conductorTempK`, `endATempK`, `endBTempK`, `endAState`, `endBState`, `insulationDamaged`;
 * - `status`: the branch's island status, or `open`.
 */
export const CONNECTION_OUTPUT_FIELDS: readonly DeviceOutputField[] = Object.freeze([
  f64('currentA', 'A'),
  f64('conductorDropV', 'V'),
  f64('endADropV', 'V'),
  f64('endBDropV', 'V'),
  f64('endAVolts', 'V'),
  f64('endBVolts', 'V'),
  f64('conductorResistanceOhm', 'Ω'),
  f64('endAContactOhm', 'Ω'),
  f64('endBContactOhm', 'Ω'),
  f64('conductorTempK', 'K'),
  f64('endATempK', 'K'),
  f64('endBTempK', 'K'),
  u8Enum('endAState', CONNECTION_RECORD_END_STATES),
  u8Enum('endBState', CONNECTION_RECORD_END_STATES),
  u8Enum('insulationDamaged', Object.freeze(['no', 'yes'])),
  u8Enum('status', CONNECTION_RECORD_STATUS_VALUES),
]);

/** The protocol layout's shape (readers' fast path): its f64 fields, contiguous from byte 0, then its u8 fields. */
export const CONNECTION_F64_COUNT = CONNECTION_OUTPUT_FIELDS.filter((f) => f.type === 'f64').length;
export const CONNECTION_U8_OFFSET = CONNECTION_RECORD_OFFSETS.endAState;
export const CONNECTION_U8_COUNT = CONNECTION_OUTPUT_FIELDS.length - CONNECTION_F64_COUNT;

const schemaOf = (kind: string): DeviceOutputSchema =>
  Object.freeze({ kind, recordBytes: CONNECTION_RECORD_BYTES, fields: CONNECTION_OUTPUT_FIELDS });

/**
 * The connection output schemas by catalogue model kind (protocol 7). Both P3 kinds share one layout;
 * readers join a descriptor connection by (id, kind), as they join devices.
 */
export const CONNECTION_OUTPUT_SCHEMAS: Readonly<Record<string, DeviceOutputSchema>> = Object.freeze({
  conductor: schemaOf('conductor'),
  lead: schemaOf('lead'),
});
