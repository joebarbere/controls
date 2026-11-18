import { TRIP_CAUSES } from '@controls/catalog';
import {
  DEVICE_OUTPUT_SCHEMAS,
  DEVICE_READING_CURRENT,
  DEVICE_READING_LINE_VOLTAGE,
  DEVICE_READING_LOAD_VOLTAGE,
  DEVICE_READING_NEUTRAL_CURRENT,
  DEVICE_READING_RESIDUAL,
  PENDING_DEVICE_OUTPUT_SCHEMAS,
  RECORD_STATUS_VALUES,
  TRIP_CAUSE_VALUES,
} from '@controls/sim-protocol';
import { BUILTIN_DEVICE_MODELS, BUILTIN_DEVICE_OUTPUTS } from './index';
import {
  PLUG_ON_READING_CURRENT,
  PLUG_ON_READING_LINE_VOLTAGE,
  PLUG_ON_READING_LOAD_VOLTAGE,
  PLUG_ON_READING_NEUTRAL_CURRENT,
  PLUG_ON_READING_RESIDUAL,
} from './protection/plug-on';
import { READING_STATUS_VALUES } from './readings';

/*
 * What the built-in models write is what the protocol says they write (ADR 0011 §5.4, F2.3b): a
 * record added or changed in a model without registering it in `sim-protocol` (and bumping
 * `SIM_PROTOCOL_VERSION`) fails here, so the worker and a reader never disagree on a layout. A change
 * made consistently on both sides is caught by `sim-protocol`'s `protocol-fingerprint.spec.ts`, which
 * pins the registry's fingerprint per `SIM_PROTOCOL_VERSION` (F2.5 test review).
 */

describe('the built-in device records are the protocol registry', () => {
  it('BUILTIN_DEVICE_OUTPUTS equals DEVICE_OUTPUT_SCHEMAS exactly, kind for kind', () => {
    expect(Object.keys(BUILTIN_DEVICE_OUTPUTS).sort()).toStrictEqual(Object.keys(DEVICE_OUTPUT_SCHEMAS).sort());
    for (const [kind, schema] of Object.entries(BUILTIN_DEVICE_OUTPUTS))
      expect(JSON.parse(JSON.stringify(schema))).toStrictEqual(JSON.parse(JSON.stringify(DEVICE_OUTPUT_SCHEMAS[kind])));
  });

  it('uses the protocol status codes', () => {
    expect([...READING_STATUS_VALUES]).toStrictEqual([...RECORD_STATUS_VALUES]);
  });

  it("protocol 8: the trip causes are the catalogue's, and the readings bits the protocol's", () => {
    expect([...TRIP_CAUSE_VALUES]).toStrictEqual([...TRIP_CAUSES]);
    expect([
      PLUG_ON_READING_CURRENT,
      PLUG_ON_READING_NEUTRAL_CURRENT,
      PLUG_ON_READING_RESIDUAL,
      PLUG_ON_READING_LINE_VOLTAGE,
      PLUG_ON_READING_LOAD_VOLTAGE,
    ]).toStrictEqual([
      DEVICE_READING_CURRENT,
      DEVICE_READING_NEUTRAL_CURRENT,
      DEVICE_READING_RESIDUAL,
      DEVICE_READING_LINE_VOLTAGE,
      DEVICE_READING_LOAD_VOLTAGE,
    ]);
  });

  it('every protocol 8 kind on main publishes a record, and no pending kind has a model yet', () => {
    for (const kind of [
      'breaker.afci1p',
      'breaker.gfci1p',
      'breaker.plugOn1p',
      'breaker.plugOn2p',
      'electrode.groundRod',
      'service.splitPhase',
    ]) {
      expect(BUILTIN_DEVICE_OUTPUTS, kind).toHaveProperty(kind);
    }
    // A model that lands for a pending kind moves its schema into DEVICE_OUTPUT_SCHEMAS unchanged.
    for (const kind of Object.keys(PENDING_DEVICE_OUTPUT_SCHEMAS))
      expect(BUILTIN_DEVICE_MODELS).not.toHaveProperty(kind);
  });
});
