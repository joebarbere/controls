import {
  CONNECTION_OUTPUT_FIELDS,
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  CONNECTION_RECORD_STATUS_VALUES,
} from './connection-output';
import type { TopologyDescriptor } from './descriptor';
import { fakeSnapshotView } from './fake-snapshot';
import { ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR, SIM_PROTOCOL_VERSION } from './layout';
import {
  CONNECTION_VALUE_COUNT,
  CONNECTION_VALUE_INDEX,
  NetlistReadout,
  READING_NONE,
  READING_SOLVED,
  READING_STATUSES,
  readingStatusCode,
} from './netlist-readout';

/**
 * A bench of four islands: a DC battery loop (nodes 0–2, two leads and the battery), an AC island
 * (nodes 3–4, one lead), a singular island (node 5) and an unwired lamp's island (node 6, unmodelled).
 */
const descriptor = (): TopologyDescriptor => ({
  protocol: SIM_PROTOCOL_VERSION,
  generation: 4,
  topologyHash: 'cd'.repeat(32),
  nodes: [
    { island: 0, members: [{ entity: 1, terminal: 'neg' }] },
    { island: 0, members: [{ entity: 1, terminal: 'pos' }] },
    {
      island: 0,
      members: [
        { entity: 2, terminal: 'a' },
        { entity: 2, terminal: 'b' },
      ],
    },
    { island: 1, members: [{ entity: 4, terminal: 'l1' }] },
    { island: 1, members: [{ entity: 4, terminal: 'n' }] },
    { island: 2, members: [{ entity: 5, terminal: 'pos' }] },
    {
      island: 3,
      members: [
        { entity: 3, terminal: 'a' },
        { entity: 3, terminal: 'b' },
      ],
    },
  ],
  branches: [
    { element: { kind: 'entity', entity: 1, part: 'cell' }, a: 0, b: 1, island: 0 },
    { element: { kind: 'connection', connection: 1 }, a: 1, b: 2, island: 0 },
    { element: { kind: 'connection', connection: 2 }, a: 2, b: 0, island: 0 },
    { element: { kind: 'connection', connection: 3 }, a: 3, b: 4, island: 1 },
  ],
  islands: [
    { kind: 'dc', nodes: [0, 1, 2] },
    { kind: 'ac', nodes: [3, 4] },
    { kind: 'dc', nodes: [5] },
    { kind: 'empty', nodes: [6] },
  ],
  devices: [],
  schemas: {},
  // Protocol 7: the three leads' records, then an unlanded conductor's (not netlisted).
  connections: [
    { connection: 1, kind: 'lead', recordOffset: 0, branch: 1 },
    { connection: 2, kind: 'lead', recordOffset: 104, branch: 2 },
    { connection: 3, kind: 'lead', recordOffset: 208, branch: 3 },
    { connection: 9, kind: 'conductor', recordOffset: 312, branch: -1 },
  ],
  connectionSchemas: { lead: CONNECTION_OUTPUT_SCHEMAS['lead'], conductor: CONNECTION_OUTPUT_SCHEMAS['conductor'] },
});

/** Connection record bytes: per record, `values` by field name (u8 fields by code). */
function connectionBytes(records: readonly Readonly<Record<string, number>>[]): Uint8Array {
  const bytes = new Uint8Array(records.length * CONNECTION_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  records.forEach((record, i) => {
    for (const [name, value] of Object.entries(record)) {
      const field = CONNECTION_OUTPUT_FIELDS.find((f) => f.name === name);
      if (field === undefined) throw new Error(`no field ${name}`);
      const at = i * CONNECTION_RECORD_BYTES + field.offset;
      if (field.type === 'f64') view.setFloat64(at, value, true);
      else view.setUint8(at, value);
    }
  });
  return bytes;
}

describe('NetlistReadout', () => {
  const d = descriptor();
  const readout = NetlistReadout.of(d);

  it('is built once per descriptor (by identity) and joins terminals and leads to the numbering', () => {
    expect(NetlistReadout.of(d)).toBe(readout);
    expect(NetlistReadout.of(descriptor())).not.toBe(readout);
    expect(readout.nodeOf(1, 'pos')).toBe(1);
    expect(readout.nodeOf(2, 'b')).toBe(2);
    expect(readout.nodeOf(2, 'c')).toBe(-1);
    expect(readout.nodeOf(9, 'a')).toBe(-1);
    expect(readout.branchOfConnection(2)).toBe(2);
    expect(readout.branchOfConnection(7)).toBe(-1);
    expect(readout.islandOfNode(4)).toBe(1);
    expect(readout.islandOfBranch(3)).toBe(1);
  });

  it('a fresh reading is no reading, never 0 V', () => {
    const reading = readout.createReading();
    expect([...reading.islandStatus]).toStrictEqual([READING_NONE, READING_NONE, READING_NONE, READING_NONE]);
    expect(READING_STATUSES[READING_NONE]).toBe('none');
    expect(READING_STATUSES[READING_SOLVED]).toBe('solved');
  });

  it('reads |V − V(reference)|, |I| and the DC direction; unsolved islands read nothing', () => {
    const view = fakeSnapshotView({
      descriptor: d,
      tick: 77,
      // The DC loop is floating 100 V above the solver's ground: only the difference is a reading.
      nodes: [
        [100, 0],
        [112, 0],
        [106, 0],
        [120, -90],
        [0, 0],
        [5, 0],
        [3, 0],
      ],
      branches: [
        [-2, 0],
        [2, 0],
        [-2, 0],
        [3, 4],
      ],
      islands: [
        { reference: 0, band: 2 },
        { reference: 4, band: 3 },
        { flags: ISLAND_FLAG_SINGULAR },
        { iterations: 0, reference: -1 },
      ],
    });
    const reading = readout.createReading();
    readout.read(view, reading);
    expect(reading.tick).toBe(77);
    expect([...reading.islandStatus].map((s) => READING_STATUSES[s])).toStrictEqual([
      'solved',
      'solved',
      'singular',
      'unmodelled',
    ]);
    expect([...reading.islandBand]).toStrictEqual([2, 3, 0, 0]);
    expect([...reading.islandAc]).toStrictEqual([0, 1, 0, 0]);
    expect([...reading.islandReferenced]).toStrictEqual([1, 1, 1, 0]);
    expect([...reading.nodeVolts]).toStrictEqual([0, 12, 6, 150, 0, 0, 0]);
    expect([...reading.branchAmps]).toStrictEqual([2, 2, 2, 5, 0, 0, 0].slice(0, 4));
    // DC: the sign of the real part; AC: magnitude only.
    expect([...reading.branchDirection]).toStrictEqual([-1, 1, -1, 0]);
  });

  it('re-reading clears what an island no longer has, and a non-converged island is not solved', () => {
    const reading = readout.createReading();
    readout.read(
      fakeSnapshotView({
        descriptor: d,
        nodes: [
          [0, 0],
          [12, 0],
        ],
        branches: [
          [1, 0],
          [1, 0],
        ],
      }),
      reading,
    );
    expect(reading.nodeVolts[1]).toBe(12);
    expect(reading.branchDirection[1]).toBe(1);
    readout.read(
      fakeSnapshotView({
        descriptor: d,
        nodes: [
          [0, 0],
          [12, 0],
        ],
        branches: [
          [1, 0],
          [1, 0],
        ],
        islands: [{ flags: ISLAND_FLAG_NON_CONVERGED }],
      }),
      reading,
    );
    expect(READING_STATUSES[reading.islandStatus[0]]).toBe('nonConverged');
    expect(reading.nodeVolts[1]).toBe(0);
    expect(reading.branchAmps[1]).toBe(0);
    expect(reading.branchDirection[1]).toBe(0);
  });

  it('a solved island without a reference gives no voltages, but still its currents', () => {
    const reading = readout.createReading();
    readout.read(
      fakeSnapshotView({
        descriptor: d,
        nodes: [
          [0, 0],
          [12, 0],
        ],
        branches: [
          [0, 0],
          [0.5, 0],
        ],
        islands: [{ reference: -1 }],
      }),
      reading,
    );
    expect(reading.islandReferenced[0]).toBe(0);
    expect(reading.nodeVolts[1]).toBe(0);
    expect(reading.branchAmps[1]).toBe(0.5);
    expect(reading.branchDirection[0]).toBe(0); // a zero current has no direction
  });

  it('refuses a snapshot or a reading of another descriptor', () => {
    const other = descriptor();
    expect(() => readout.read(fakeSnapshotView({ descriptor: other }), readout.createReading())).toThrow(RangeError);
    expect(() => readout.read(fakeSnapshotView({ descriptor: d }), NetlistReadout.of(other).createReading())).toThrow(
      RangeError,
    );
  });

  it('names every island status with a code', () => {
    for (const status of ['solved', 'singular', 'nonConverged', 'unmodelled', 'mixed'] as const) {
      expect(READING_STATUSES[readingStatusCode(status)]).toBe(status);
    }
  });
});

describe('fakeSnapshotView', () => {
  it('encodes through the real codec: counts, island entries and device bytes', () => {
    const d = { ...descriptor(), devices: [{ entity: 1, kind: 'battery', recordOffset: 0 }] };
    const devices = new Uint8Array(5);
    devices[4] = 9;
    const view = fakeSnapshotView({ descriptor: d, tick: 12, islands: [{ band: 7 }, { iterations: 0 }], devices });
    expect(view.tick).toBe(12);
    expect(view.lastSolveTick).toBe(12);
    expect(view.descriptor).toBe(d);
    expect(view.generation).toBe(4);
    expect([view.nodeCount, view.branchCount, view.islandCount, view.deviceCount]).toStrictEqual([7, 4, 4, 1]);
    expect(view.islandBand(0)).toBe(7);
    expect(view.islandReference(1)).toBe(3);
    expect(view.islandIterations(1)).toBe(0);
    expect(view.islandIterations(2)).toBe(1);
    expect(
      view.read({ offset: 4, type: 'u8', field: { name: 'x', type: 'u8', offset: 4, unit: null, values: null } }),
    ).toBe(9);
  });
});

describe('NetlistReadout connection records (protocol 7)', () => {
  const d = descriptor();
  const readout = NetlistReadout.of(d);
  const at = (c: number, name: string) => c * CONNECTION_VALUE_COUNT + CONNECTION_VALUE_INDEX[name];

  it('joins connections to their records, and reads every field of every record allocation-free', () => {
    expect(readout.recordOfConnection(3)).toBe(2);
    expect(readout.recordOfConnection(9)).toBe(3);
    expect(readout.recordOfConnection(4)).toBe(-1);
    const view = fakeSnapshotView({
      descriptor: d,
      connections: connectionBytes([
        { currentA: 2, conductorDropV: 0.25, conductorResistanceOhm: 0.125, conductorTempK: 300, status: 1 },
        { currentA: 2, conductorDropV: 0.5, conductorTempK: 301, status: 1 },
        { currentA: 5, conductorTempK: 302, status: 1 },
        {
          conductorResistanceOhm: 0.02,
          endAContactOhm: 0.0005,
          conductorTempK: 295,
          endATempK: 296,
          endAState: 1,
          endBState: 0,
          insulationDamaged: 1,
          status: 4,
        },
      ]),
    });
    const reading = readout.createReading();
    readout.read(view, reading);
    expect([...reading.connectionStatus].map((code) => CONNECTION_RECORD_STATUS_VALUES[code])).toStrictEqual([
      'solved',
      'solved',
      'solved',
      'open',
    ]);
    expect(reading.connectionValues[at(0, 'conductorDropV')]).toBe(0.25);
    expect(reading.connectionValues[at(1, 'conductorTempK')]).toBe(301);
    expect(reading.connectionValues[at(2, 'currentA')]).toBe(5);
    expect(reading.connectionValues[at(3, 'endAContactOhm')]).toBe(0.0005);
    expect(reading.connectionValues[at(3, 'endAState')]).toBe(1);
    expect(reading.connectionValues[at(3, 'insulationDamaged')]).toBe(1);
    // A re-read with no connection section clears the previous values (never a stale reading).
    readout.read(fakeSnapshotView({ descriptor: d }), reading);
    expect(reading.connectionValues.every((v) => v === 0)).toBe(true);
    expect([...reading.connectionStatus]).toStrictEqual([0, 0, 0, 0]);
  });

  it('reads a kind whose schema is not the protocol layout field by field: shifted (aligned) and misaligned', () => {
    for (const shift of [8, 4]) {
      const fields = CONNECTION_OUTPUT_FIELDS.map((f) => ({ ...f, offset: f.offset + shift }));
      const shifted: TopologyDescriptor = {
        ...d,
        connections: [{ connection: 1, kind: 'lead', recordOffset: 0, branch: 1 }],
        connectionSchemas: { lead: { kind: 'lead', recordBytes: 112, fields } },
      };
      const bytes = new Uint8Array(112);
      const view = new DataView(bytes.buffer);
      view.setFloat64(shift + CONNECTION_OUTPUT_FIELDS[0].offset, 3.25, true); // currentA
      view.setFloat64(shift + CONNECTION_OUTPUT_FIELDS[9].offset, 301.5, true); // conductorTempK
      view.setUint8(shift + CONNECTION_OUTPUT_FIELDS[15].offset, 1); // status solved
      const r = NetlistReadout.of(shifted);
      const reading = r.createReading();
      r.read(fakeSnapshotView({ descriptor: shifted, connections: bytes }), reading);
      expect(reading.connectionValues[at(0, 'currentA')]).toBe(3.25);
      expect(reading.connectionValues[at(0, 'conductorTempK')]).toBe(301.5);
      expect(reading.connectionStatus[0]).toBe(1);
    }
  });

  it('reads nothing for a connection whose kind has no schema in the descriptor (joined by kind)', () => {
    const orphan: TopologyDescriptor = {
      ...d,
      connections: [{ connection: 1, kind: 'toString', recordOffset: 0, branch: 1 }],
    };
    const r = NetlistReadout.of(orphan);
    const reading = r.createReading();
    r.read(
      fakeSnapshotView({ descriptor: orphan, connections: connectionBytes([{ currentA: 3, status: 1 }]) }),
      reading,
    );
    expect(reading.connectionStatus[0]).toBe(0);
    expect(reading.connectionValues[at(0, 'currentA')]).toBe(0);
  });
});
