import { DEVICE_OUTPUT_SCHEMAS, RECORD_STATUS_VALUES } from '@controls/sim-protocol';
import { BUILTIN_DEVICE_OUTPUTS } from './index';
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
});
