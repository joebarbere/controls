import type { TopologyDescriptor } from './descriptor';
import { fakeSnapshotView } from './fake-snapshot';
import { ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR, SIM_PROTOCOL_VERSION } from './layout';
import { NetlistReadout, READING_NONE, READING_SOLVED, READING_STATUSES, readingStatusCode } from './netlist-readout';

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
});

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
