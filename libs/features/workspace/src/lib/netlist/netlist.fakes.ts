import {
  CONNECTION_OUTPUT_FIELDS,
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  SIM_PROTOCOL_VERSION,
  type TopologyDescriptor,
} from '@controls/sim-protocol';

/*
 * Test stand-ins for the netlist inspector's specs (not exported from the library): the bench-lamp
 * circuit's descriptor (battery e1, switch closed, lamp e3, leads c1 to c3, as `netlist.dump` lists
 * it) plus a second, AC island with no reference, and a fake generation counter.
 */

/** The bench-lamp netlist (island 0, DC) and a two-node AC island (island 1). */
export function benchDescriptor(generation = 1): TopologyDescriptor {
  const t = (entity: number, terminal: string) => ({ entity, terminal });
  return {
    protocol: SIM_PROTOCOL_VERSION,
    generation,
    topologyHash: '0'.repeat(64),
    nodes: [
      { island: 0, members: [t(1, 'neg')] },
      { island: 0, members: [t(1, 'pos')] },
      { island: 0, members: [t(2, 'a'), t(2, 'b')] },
      { island: 0, members: [t(3, 'a')] },
      { island: 0, members: [t(3, 'b')] },
      { island: 1, members: [t(4, 'l1')] },
      { island: 1, members: [t(4, 'n')] },
    ],
    branches: [
      { element: { kind: 'entity', entity: 1, part: 'cell' }, a: 0, b: 1, island: 0 },
      { element: { kind: 'entity', entity: 3, part: 'filament' }, a: 3, b: 4, island: 0 },
      { element: { kind: 'connection', connection: 1 }, a: 1, b: 2, island: 0 },
      { element: { kind: 'connection', connection: 2 }, a: 2, b: 3, island: 0 },
      { element: { kind: 'connection', connection: 3 }, a: 4, b: 0, island: 0 },
      { element: { kind: 'entity', entity: 4, part: 'l1' }, a: 6, b: 5, island: 1 },
    ],
    islands: [
      { kind: 'dc', nodes: [0, 1, 2, 3, 4] },
      { kind: 'ac', nodes: [5, 6] },
    ],
    devices: [],
    schemas: {},
    // Protocol 7: the three leads' records, and a wire (c9) that isn't netlisted.
    connections: [
      { connection: 1, kind: 'lead', recordOffset: 0, branch: 2 },
      { connection: 2, kind: 'lead', recordOffset: 104, branch: 3 },
      { connection: 3, kind: 'lead', recordOffset: 208, branch: 4 },
      { connection: 9, kind: 'conductor', recordOffset: 312, branch: -1 },
    ],
    connectionSchemas: { lead: CONNECTION_OUTPUT_SCHEMAS['lead'], conductor: CONNECTION_OUTPUT_SCHEMAS['conductor'] },
  };
}

/** Connection record bytes: per record, its fields by name (u8 enums by code). */
export function connectionRecords(records: readonly Readonly<Record<string, number>>[]): Uint8Array {
  const bytes = new Uint8Array(records.length * CONNECTION_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  records.forEach((record, i) => {
    for (const [name, value] of Object.entries(record)) {
      const field = CONNECTION_OUTPUT_FIELDS.find((f) => f.name === name);
      if (field === undefined) throw new Error(`no connection field ${name}`);
      const at = i * CONNECTION_RECORD_BYTES + field.offset;
      if (field.type === 'f64') view.setFloat64(at, value, true);
      else view.setUint8(at, value);
    }
  });
  return bytes;
}

/** The lit bench's lead records (solved, their clips inside the conductor value) and the open wire's. */
export const BENCH_CONNECTIONS = connectionRecords([
  { currentA: 0.3906, conductorDropV: 0.03, conductorTempK: 293.4, status: 1 },
  { currentA: 0.3906, conductorDropV: 0.0, conductorTempK: 293.4, status: 1 },
  { currentA: 0.3906, conductorDropV: 0.016, conductorTempK: 293.4, status: 1 },
  { conductorTempK: 293.15, endATempK: 293.15, endAState: 1, status: 4 },
]);

/** Node voltages of the lit bench lamp (V, against node 0) and its loop current (A, a -> b of each branch). */
export const BENCH_NODES: readonly (readonly [number, number])[] = [
  [0, 0],
  [12.86, 0],
  [12.83, 0],
  [12.83, 0],
  [0.016, 0],
];
export const BENCH_BRANCHES: readonly (readonly [number, number])[] = [
  [-0.3906, 0],
  [0.3906, 0],
  [0.3906, 0],
  [0.3906, 0],
  [0.3906, 0],
];
