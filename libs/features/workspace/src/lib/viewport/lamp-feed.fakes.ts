import {
  DEVICE_OUTPUT_SCHEMAS,
  SIM_PROTOCOL_VERSION,
  type FieldRef,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';

/*
 * Test stand-ins for the lamp feed's specs (not exported from the library): a descriptor and a
 * snapshot view over a hand-written device section. Only what the feed reads is real.
 */

/** A descriptor with devices at the given record offsets (a lamp record is 56 bytes, a resistor's 32). */
export function lampDescriptor(
  devices: readonly { entity: number; kind: string; recordOffset: number }[],
  generation = 1,
): TopologyDescriptor {
  const kinds = [...new Set(devices.map((d) => d.kind))];
  return {
    protocol: SIM_PROTOCOL_VERSION,
    generation,
    topologyHash: '0'.repeat(64),
    nodes: [],
    branches: [],
    islands: [],
    devices,
    schemas: Object.fromEntries(kinds.map((k) => [k, DEVICE_OUTPUT_SCHEMAS[k]])),
    connections: [],
    connectionSchemas: {},
  };
}

/** A snapshot view over a device section: `descriptor`, `read` and `readAll`, nothing else. */
export function fakeView(descriptor: TopologyDescriptor, section: DataView): SnapshotView {
  const read = (f: FieldRef) => (f.type === 'f64' ? section.getFloat64(f.offset, true) : section.getUint8(f.offset));
  return {
    descriptor,
    read,
    readAll(fields: readonly FieldRef[], out: Float64Array) {
      fields.forEach((f, i) => (out[i] = read(f)));
    },
  } as unknown as SnapshotView;
}

/** Writes a lamp record's light output and status code at `offset` (protocol 8: `status` at 49, after `burnedOut`). */
export function writeLamp(section: DataView, offset: number, light: number, status: number): void {
  const fields = DEVICE_OUTPUT_SCHEMAS['lamp.incandescent'].fields;
  const at = (name: string) => offset + (fields.find((f) => f.name === name)?.offset ?? -1);
  section.setFloat64(at('lightOutputRel'), light, true);
  section.setUint8(at('status'), status);
}
