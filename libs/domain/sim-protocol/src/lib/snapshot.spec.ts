import fc from 'fast-check';
import { DEVICE_OUTPUT_SCHEMAS, deviceOutputSchemaProblems, NOMINAL_BANDS } from './device-output';
import {
  align8,
  ISLAND_KIND_AC,
  ISLAND_KIND_DC,
  ISLAND_KIND_EMPTY,
  ISLAND_KIND_MIXED,
  SIM_PROTOCOL_VERSION,
  SLOT_HASHED_START,
  SLOT_HEADER_BYTES,
  SLOT_OFFSETS,
  SNAPSHOT_FLAG_MIXED,
  SNAPSHOT_FLAG_NON_CONVERGED,
  SNAPSHOT_FLAG_SINGULAR,
  slotBytesFor,
} from './layout';
import {
  decodeSnapshot,
  encodeSnapshot,
  SnapshotDecodeError,
  SnapshotEncodeError,
  snapshotHash,
  snapshotHashedBytes,
  snapshotSlotBytes,
  type SnapshotSource,
} from './snapshot';

/** A snapshot source over plain arrays, with device records written as one f64 per device. */
function source(overrides: Partial<SnapshotSource> & { readonly devices?: readonly number[] } = {}): SnapshotSource {
  const devices = overrides.devices ?? [];
  return {
    topologyGeneration: 3,
    tick: 1234,
    lastSolveTick: 1230,
    topologyHash: 'ab'.repeat(32),
    nodeCount: 2,
    branchCount: 1,
    nodes: [0, 0, 12, 0],
    branches: [0.25, 0],
    islandCount: 1,
    islandKinds: [ISLAND_KIND_DC],
    islandFlags: [0],
    islandIterations: [1],
    islandReferences: [0],
    islandUnknowns: [2],
    islandBands: [0],
    deviceCount: devices.length,
    deviceDataBytes: 8 * devices.length,
    writeDevices(view, offset) {
      devices.forEach((value, i) => view.setFloat64(offset + 8 * i, value, true));
    },
    ...overrides,
  };
}

const finiteArb = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(-0, 5e-324, -Number.MAX_VALUE, 0.1 + 0.2),
);
const islandArb = fc.record({
  kind: fc.integer({ min: 0, max: 3 }),
  flags: fc.integer({ min: 0, max: 3 }),
  iterations: fc.integer({ min: 0, max: 0xffff }),
  reference: fc.oneof(fc.constant(-1), fc.nat({ max: 1000 })),
  unknowns: fc.nat({ max: 5000 }),
  band: fc.constant(0),
});
/** Counts come from the array lengths (no `.chain`): nodes and branches are `re, im` pairs. */
const snapshotArb = fc.record({
  nodes: fc.array(finiteArb, { maxLength: 80, size: 'large' }),
  branches: fc.array(finiteArb, { maxLength: 80, size: 'large' }),
  islands: fc.array(islandArb, { maxLength: 8 }),
  devices: fc.array(finiteArb, { maxLength: 6 }),
  ticks: fc.tuple(fc.nat({ max: Number.MAX_SAFE_INTEGER }), fc.nat({ max: Number.MAX_SAFE_INTEGER })),
  hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
});
type GeneratedSnapshot = typeof snapshotArb extends fc.Arbitrary<infer T> ? T : never;

function sourceOf(g: GeneratedSnapshot): SnapshotSource {
  return source({
    tick: Math.max(...g.ticks),
    lastSolveTick: Math.min(...g.ticks),
    topologyHash: [...g.hash].map((b) => b.toString(16).padStart(2, '0')).join(''),
    nodeCount: g.nodes.length >> 1,
    nodes: g.nodes,
    branchCount: g.branches.length >> 1,
    branches: g.branches,
    islandCount: g.islands.length,
    islandKinds: g.islands.map((i) => i.kind),
    islandFlags: g.islands.map((i) => i.flags),
    islandIterations: g.islands.map((i) => i.iterations),
    islandReferences: g.islands.map((i) => i.reference),
    islandUnknowns: g.islands.map((i) => i.unknowns),
    islandBands: g.islands.map((i) => i.band),
    devices: g.devices,
  });
}

function encode(s: SnapshotSource, slotSeq = 0): Uint8Array {
  const slot = new Uint8Array(snapshotSlotBytes(s));
  encodeSnapshot(s, slot, slotSeq);
  return slot;
}

const hashed = (s: SnapshotSource) => snapshotHashedBytes(encode(s));

describe('the snapshot layout (ADR 0011 §5)', () => {
  it('is protocol version 1, with a 96-byte slot header whose hashed region starts at byte 8', () => {
    expect(SIM_PROTOCOL_VERSION).toBe(2);
    expect([SLOT_HEADER_BYTES, SLOT_HASHED_START]).toStrictEqual([96, 8]);
    expect(SLOT_OFFSETS).toMatchObject({ tick: 8, lastSolveTick: 16, flags: 44, topologyHash: 48, payloadBytes: 80 });
    expect(slotBytesFor(3, 4, 2, 24)).toBe(96 + 48 + 64 + 32 + 24);
    expect([align8(0), align8(1), align8(8), align8(9)]).toStrictEqual([0, 8, 8, 16]);
  });

  it('pins the bytes of a fixed snapshot (a layout or encoding change moves this golden)', () => {
    // Re-pin only with a SIM_PROTOCOL_VERSION bump and the snapshot goldens (ADR 0011 §12).
    // Spelled out, little-endian: tick 1234 and lastSolveTick 1230 (f64); counts 2 nodes, 1 branch,
    // 1 island, 1 device, 8 device bytes; flags 0; the topology hash (ab × 32); payloadBytes 72; 12
    // reserved zeros; nodes (0, 0), (12, 0); branch (0.25, 0); the island (dc, flags 0, 1 iteration,
    // reference 0, 2 unknowns, band 0, 3 reserved); the device record (0.5).
    const bytes = hashed(source({ devices: [0.5] }));
    expect(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      [
        '0000000000489340',
        '0000000000389340',
        '02000000010000000100000001000000',
        '0800000000000000',
        'ab'.repeat(32),
        '48000000',
        '00'.repeat(12),
        '0000000000000000',
        '0000000000000000',
        '0000000000002840',
        '0000000000000000',
        '000000000000d03f',
        '0000000000000000',
        '01000100000000000200000000000000',
        '000000000000e03f',
      ].join(''),
    );
    expect(snapshotHash(bytes)).toBe('dd9ff86422c9ea982ddeb9eb58acb8cd1fedb31ecc016a882f9b7dd386541bf1');
  });
});

describe('encodeSnapshot and decodeSnapshot', () => {
  it('round-trip a snapshot: header, sections and device bytes', () => {
    const s = source({ devices: [0.5, -3] });
    const decoded = decodeSnapshot(hashed(s));
    expect(decoded).toMatchObject({
      tick: 1234,
      lastSolveTick: 1230,
      flags: 0,
      topologyHash: 'ab'.repeat(32),
      deviceCount: 2,
    });
    expect([...decoded.nodes]).toStrictEqual([0, 0, 12, 0]);
    expect([...decoded.branches]).toStrictEqual([0.25, 0]);
    expect(decoded.islands).toStrictEqual([
      { kind: 'dc', flags: 0, iterations: 1, referenceNode: 0, unknowns: 2, band: 0 },
    ]);
    const devices = new DataView(decoded.devices.buffer);
    expect([devices.getFloat64(0, true), devices.getFloat64(8, true)]).toStrictEqual([0.5, -3]);
  });

  it('never hashes slotSeq or the topology generation, and zeroes every unused byte', () => {
    const s = source();
    const clean = encode(s, 2);
    const dirty = new Uint8Array(snapshotSlotBytes(s)).fill(0xa5);
    encodeSnapshot({ ...s, topologyGeneration: 99 }, dirty, 40);
    expect(snapshotHashedBytes(dirty)).toStrictEqual(snapshotHashedBytes(clean));
    expect(new DataView(dirty.buffer).getInt32(0, true)).toBe(40);
    expect(new DataView(dirty.buffer).getUint32(4, true)).toBe(99);
  });

  it('writes -0 as +0, and ORs the island flags and a mixed island into the slot flags', () => {
    const s = source({
      nodes: [-0, 0, 1, -0],
      islandCount: 4,
      islandKinds: [ISLAND_KIND_EMPTY, ISLAND_KIND_DC, ISLAND_KIND_AC, ISLAND_KIND_MIXED],
      islandFlags: [0, 1, 2, 0],
      islandIterations: [1, 1, 0, 0],
      islandReferences: [0, 1, -1, -1],
      islandUnknowns: [0, 1, 0, 0],
      islandBands: [0, 0, 0, 0],
    });
    const decoded = decodeSnapshot(hashed(s));
    expect(Object.is(decoded.nodes[0], 0) && Object.is(decoded.nodes[3], 0)).toBe(true);
    expect(decoded.flags).toBe(SNAPSHOT_FLAG_SINGULAR | SNAPSHOT_FLAG_NON_CONVERGED | SNAPSHOT_FLAG_MIXED);
    expect(decoded.islands.map((i) => [i.kind, i.referenceNode])).toStrictEqual([
      ['empty', 0],
      ['dc', 1],
      ['ac', -1],
      ['mixed', -1],
    ]);
  });

  it('refuses values the layout cannot hold, and a slot that is too small', () => {
    const bad: Partial<SnapshotSource>[] = [
      { nodes: [0, 0, Number.NaN, 0] },
      { branches: [Number.POSITIVE_INFINITY, 0] },
      { tick: Number.NaN },
      { topologyHash: 'AB'.repeat(32) },
      { topologyHash: 'ab' },
      { islandKinds: [4] },
      { islandFlags: [256] },
      { islandIterations: [70_000] },
      { islandBands: [-1] },
      { islandUnknowns: [1.5] },
      { topologyGeneration: -1 },
    ];
    for (const overrides of bad) expect(() => encode(source(overrides))).toThrow(SnapshotEncodeError);
    expect(() => encode({ ...source(), deviceDataBytes: 4, deviceCount: 1 })).toThrow(SnapshotEncodeError);
    expect(() => encodeSnapshot(source(), new Uint8Array(100))).toThrow(RangeError);
  });

  it('decodeSnapshot refuses truncated or tampered bytes', () => {
    const good = hashed(source());
    expect(() => decodeSnapshot(good.subarray(0, 40))).toThrow(SnapshotDecodeError);
    expect(() => decodeSnapshot(good.subarray(0, good.length - 8))).toThrow(SnapshotDecodeError);
    const tampered = (at: number, value: number) => {
      const copy = good.slice();
      copy[at] = value;
      return () => decodeSnapshot(copy);
    };
    expect(tampered(84 - SLOT_HASHED_START, 1)).toThrow(/reserved/); // the slot header's reserved bytes
    const island = SLOT_HEADER_BYTES - SLOT_HASHED_START + 2 * 16 + 16;
    expect(tampered(island, 7)).toThrow(/kind/);
    expect(tampered(island + 13, 1)).toThrow(/reserved/);
    expect(() => snapshotHashedBytes(new Uint8Array(10))).toThrow(RangeError);
    const slot = encode(source());
    expect(() => snapshotHashedBytes(slot.subarray(0, slot.length - 1))).toThrow(RangeError);
  });

  it('round-trips any snapshot bit for bit, -0 as +0 (property)', () => {
    fc.assert(
      fc.property(snapshotArb, (g) => {
        const s = sourceOf(g);
        const bytes = hashed(s);
        const decoded = decodeSnapshot(bytes);
        expect(decoded.tick).toBe(s.tick);
        expect(decoded.lastSolveTick).toBe(s.lastSolveTick);
        expect(decoded.topologyHash).toBe(s.topologyHash);
        expect([...decoded.nodes]).toStrictEqual(g.nodes.slice(0, 2 * s.nodeCount).map((v) => v + 0));
        expect([...decoded.branches]).toStrictEqual(g.branches.slice(0, 2 * s.branchCount).map((v) => v + 0));
        expect(decoded.islands.map((i) => i.referenceNode)).toStrictEqual(g.islands.map((i) => i.reference));
        expect(decoded.devices.length).toBe(8 * g.devices.length);
        // Encoding again gives the same bytes: the hashed region is a pure function of the content.
        expect(hashed(s)).toStrictEqual(bytes);
      }),
      { numRuns: 60 },
    );
  });

  it('the property covers big counts, -0 and every island kind (generator health)', () => {
    const samples = fc.sample(snapshotArb, { seed: 20261031, numRuns: 60 }).map((g) => ({ g, s: sourceOf(g) }));
    expect(samples.filter(({ s }) => s.nodeCount > 20).length).toBeGreaterThan(15);
    expect(samples.filter(({ g }) => g.nodes.some((v) => Object.is(v, -0))).length).toBeGreaterThan(5);
    expect(new Set(samples.flatMap(({ g }) => g.islands.map((i) => i.kind))).size).toBe(4);
  });
});

describe('device output schemas and nominal bands', () => {
  const lamp = {
    kind: 'lamp.incandescent',
    recordBytes: 24,
    fields: [
      { name: 'powerW', type: 'f64' as const, offset: 0, unit: 'W', values: null },
      { name: 'lightOutputRel', type: 'f64' as const, offset: 8, unit: null, values: null },
      { name: 'state', type: 'u8' as const, offset: 16, unit: null, values: ['off', 'on'] },
    ],
  };

  it('accepts a well-formed schema and names every problem in a bad one', () => {
    expect(deviceOutputSchemaProblems(lamp)).toStrictEqual([]);
    expect(deviceOutputSchemaProblems({ ...lamp, recordBytes: 20 })).toContain(
      'recordBytes must be a positive multiple of 8',
    );
    const problems = deviceOutputSchemaProblems({
      kind: 'x',
      recordBytes: 16,
      fields: [
        { name: 'Bad', type: 'u8', offset: 0, unit: null, values: null },
        { name: 'a', type: 'f64', offset: 4, unit: null, values: ['x'] },
        { name: 'a', type: 'u32', offset: 10, unit: null, values: null },
        { name: 'z', type: 'u8', offset: 16, unit: null, values: null },
      ],
    });
    expect(problems).toStrictEqual([
      'Bad: not a lower camelCase name',
      'a: not aligned',
      'a: out of order (f64, then 4-byte, then u8)',
      'a: only u8 fields have enum values',
      'a: repeated',
      'a: not aligned',
      'a: overlaps the field before it',
      'z: past the end of the record',
    ]);
  });

  it('every built-in schema is well formed, and band 0 is none', () => {
    for (const schema of Object.values(DEVICE_OUTPUT_SCHEMAS))
      expect(deviceOutputSchemaProblems(schema)).toStrictEqual([]);
    expect(NOMINAL_BANDS[0]).toBe('none');
  });
});
