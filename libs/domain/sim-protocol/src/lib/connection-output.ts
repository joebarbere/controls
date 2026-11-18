import { type DeviceOutputField, type DeviceOutputSchema, RECORD_STATUS_VALUES } from './device-output';

/*
 * Connection records (protocol 7, F3.6 part 3; ADR 0015 "Protocol 7 connection records", finalised by
 * the ADR 0011 amendment): one fixed-width record per connection in the engine's thermal bank (every
 * lead and conductor of a known connection kind, netlisted or not), in connection-id order, in the
 * slot's connection section after the device section. Laid out by its kind's schema with the device
 * schemas' rules (`deviceOutputSchemaProblems`: f64 first, then 4-byte, then u8, padded to 8).
 *
 * The validity rule (ADR 0011 §5.4, amended): the **electrical** fields (`currentA`, the three drops
 * and the two end voltages) are a reading only when their bit is set in `readings`
 * ({@link CONNECTION_READING_CURRENT} …); a field whose bit is clear is written 0 and is **no
 * reading**, never 0 A or 0 V.
 *
 * - `solved`: every bit set (an end voltage's only while the island has a reference node);
 * - `unsolved`, `unsettled`, `singular`: none set;
 * - `open` (the connection isn't netlisted, so no current flows): `currentA` is a reading of 0, and so
 *   is the drop across the conductor body, a closed end or a free end. **A gap is never 0 V**: the drop
 *   across an `intermittentOpen` end, or along a fused lead's or conductor's body (`conductorState`
 *   `open`; a fused conductor's halves each float at their own closed end's terminal), is the
 *   terminal-to-terminal |ΔV| across the gap when both of its sides are on one solved, referenced
 *   island (the conductor floats at the potential of its landed, closed end), else no reading. An end
 *   voltage is the conductor side's potential: a closed landed end's terminal, an open end's floating
 *   conductor (from the closed end), a lead's terminal; no reading for a free end or when unknown.
 *
 * **Own-state** fields (the resistances and temperatures, the end and conductor states,
 * `insulationDamaged`) are always written. An end whose state is `none` (a lead's clip, an unlanded
 * end, an end whose terminal has no method spec) has no termination node: its temperature and contact
 * are written 0 and readers treat them as absent, never as 0 K or 0 Ω. An `intermittentOpen` end's
 * contact is the closed contact's value; readers show the end as open, not as that resistance.
 *
 * Readers check the protocol version before reading (ADR 0011 §12), so a code past a table here can't
 * come from this protocol; a reader still falls back safely (an unknown status reads as `unsolved`).
 *
 * Every schema is part of the protocol: changing a field or adding a kind bumps `SIM_PROTOCOL_VERSION`.
 */

/** A connection record's `status` values by code: the device records' four, then `open` (not netlisted). */
export const CONNECTION_RECORD_STATUS_VALUES: readonly string[] = Object.freeze([...RECORD_STATUS_VALUES, 'open']);
/** {@link CONNECTION_RECORD_STATUS_VALUES}' `open` code. */
export const CONNECTION_RECORD_OPEN = 4;

/**
 * An end's published state by code (ADR 0015, split in the amendment's review so readers can tell
 * which end is a gap): `none` (no termination node), `ok`, `intermittentClosed`, `intermittentOpen`
 * (the gap: the connection isn't netlisted), `arcing`.
 */
export const CONNECTION_RECORD_END_STATES: readonly string[] = Object.freeze([
  'none',
  'ok',
  'intermittentClosed',
  'intermittentOpen',
  'arcing',
]);
export const CONNECTION_END_NONE = 0;
export const CONNECTION_END_OK = 1;
export const CONNECTION_END_INTERMITTENT_CLOSED = 2;
export const CONNECTION_END_INTERMITTENT_OPEN = 3;
export const CONNECTION_END_ARCING = 4;

/**
 * `conductorState`: `open` for a fused lead (the gap is in its body; its clip ends stay `none`) or a
 * fused conductor (its sticky `fused`: open whatever its re-made ends are).
 */
export const CONNECTION_CONDUCTOR_STATES: readonly string[] = Object.freeze(['closed', 'open']);
export const CONNECTION_CONDUCTOR_CLOSED = 0;
export const CONNECTION_CONDUCTOR_OPEN = 1;

/** `readings` bits: which electrical fields are a reading (a clear bit: no reading, written 0). */
export const CONNECTION_READING_CURRENT = 1;
export const CONNECTION_READING_CONDUCTOR_DROP = 2;
export const CONNECTION_READING_END_A_DROP = 4;
export const CONNECTION_READING_END_B_DROP = 8;
export const CONNECTION_READING_END_A_VOLTS = 16;
export const CONNECTION_READING_END_B_VOLTS = 32;
/** Every `readings` bit: a solved record with a referenced island. */
export const CONNECTION_READING_ALL = 63;

/**
 * The ambient and the overheat rise the engine uses (copies of `sim-core`'s sourced
 * `AMBIENT_TEMPERATURE_K` and `TERMINATION_OVERHEAT_RISE_K`, which a sim-core spec requires equal),
 * for readers that can't import sim-core: the renderer's heat overlay scale.
 */
export const CONNECTION_AMBIENT_K = 293.15;
export const CONNECTION_OVERHEAT_RISE_K = 100;

/** A connection record's size in bytes (14 × f64 + 6 × u8, padded to 8; protocol 7's was 104). */
export const CONNECTION_RECORD_BYTES = 120;

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
  // Protocol 8 (ADR 0019 "Protocol 8", the carried P3 readout item): inside the f64 block, after `endBTempK`.
  endADegradation: 96,
  endBDegradation: 104,
  endAState: 112,
  endBState: 113,
  insulationDamaged: 114,
  status: 115,
  readings: 116,
  conductorState: 117,
});

const f64 = (name: keyof typeof CONNECTION_RECORD_OFFSETS, unit: string | null): DeviceOutputField =>
  Object.freeze({ name, type: 'f64', offset: CONNECTION_RECORD_OFFSETS[name], unit, values: null });
const u8Enum = (name: keyof typeof CONNECTION_RECORD_OFFSETS, values: readonly string[] | null): DeviceOutputField =>
  Object.freeze({ name, type: 'u8', offset: CONNECTION_RECORD_OFFSETS[name], unit: null, values });

/**
 * The fields every connection kind publishes:
 *
 * - electrical (a reading only with its `readings` bit): `currentA` (|I|, RMS on AC; the direction is
 *   the branch's, `NetlistReadout.branchDirection`); `conductorDropV`, `endADropV`, `endBDropV`
 *   (magnitudes: solved, the terminal-to-terminal voltage split in proportion to the conductor's and
 *   each end's resistance, so they add up to it; open, see the file comment); `endAVolts`, `endBVolts`
 *   (|V − V(islandReference)| on the conductor side of each end's contact; a lead's are its terminals'
 *   voltages, its clips being inside its conductor value);
 * - own state: `conductorResistanceOhm` (at its temperature; a lead's includes its two clip contacts),
 *   `endAContactOhm`, `endBContactOhm` (each end's value by its regime: ohmic, glowing or arcing at the
 *   solved current; the closed contact's ohmic value while the connection isn't netlisted),
 *   `conductorTempK`, `endATempK`, `endBTempK`, `endADegradation`, `endBDegradation` (protocol 8: each
 *   end's degradation factor D ≥ 1, R_deg = R_made · D, ADR 0018 §5; it never falls, so a cooled end
 *   that degraded still shows it), `endAState`, `endBState`, `insulationDamaged`, `conductorState`;
 * - `status`: the branch's island status, or `open`; `readings`: the bit field above.
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
  f64('endADegradation', null),
  f64('endBDegradation', null),
  u8Enum('endAState', CONNECTION_RECORD_END_STATES),
  u8Enum('endBState', CONNECTION_RECORD_END_STATES),
  u8Enum('insulationDamaged', Object.freeze(['no', 'yes'])),
  u8Enum('status', CONNECTION_RECORD_STATUS_VALUES),
  u8Enum('readings', null),
  u8Enum('conductorState', CONNECTION_CONDUCTOR_STATES),
]);

/** The protocol layout's shape (readers' fast path): its f64 fields, contiguous from byte 0, then its u8 fields. */
export const CONNECTION_F64_COUNT = CONNECTION_OUTPUT_FIELDS.filter((f) => f.type === 'f64').length;
/** The first u8 field's offset: right after the f64 block (`connectionLayoutProblems` checks the table agrees). */
export const CONNECTION_U8_OFFSET = 8 * CONNECTION_F64_COUNT;
export const CONNECTION_U8_COUNT = CONNECTION_OUTPUT_FIELDS.length - CONNECTION_F64_COUNT;

/**
 * The problems with a connection layout for the readers' fast path (empty when it fits, protocol 8's
 * module-load check, ADR 0019 R7): every f64 field first, contiguous from byte 0 in field order, then
 * every u8 field contiguous from `CONNECTION_U8_OFFSET` in field order, inside `CONNECTION_RECORD_BYTES`.
 */
export function connectionLayoutProblems(fields: readonly DeviceOutputField[], recordBytes: number): string[] {
  const problems: string[] = [];
  const f64s = fields.filter((f) => f.type === 'f64').length;
  fields.forEach((field, i) => {
    const expected = i < f64s ? 8 * i : 8 * f64s + (i - f64s);
    const type = i < f64s ? 'f64' : 'u8';
    if (field.type !== type) problems.push(`${field.name}: expected ${type} (every f64, then every u8)`);
    if (field.offset !== expected) problems.push(`${field.name}: at ${field.offset}, expected ${expected}`);
  });
  if (8 * f64s + (fields.length - f64s) > recordBytes) problems.push('the fields run past the record');
  if (recordBytes % 8 !== 0) problems.push('the record is not a multiple of 8 bytes');
  return problems;
}

const layoutProblems = connectionLayoutProblems(CONNECTION_OUTPUT_FIELDS, CONNECTION_RECORD_BYTES);
// The named offset table agrees with the derived u8 block (the writer uses the table, readers the constant).
if (CONNECTION_RECORD_OFFSETS.endAState !== CONNECTION_U8_OFFSET) {
  layoutProblems.push(`endAState is at ${CONNECTION_RECORD_OFFSETS.endAState}, not CONNECTION_U8_OFFSET`);
}
if (layoutProblems.length > 0) {
  throw new Error(`The connection record layout is not the fast path's: ${layoutProblems.join('; ')}`);
}

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
