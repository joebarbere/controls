import fc from 'fast-check';
import { Worker } from 'node:worker_threads';
import {
  BUFFER_OFFSETS,
  createSnapshotBuffer,
  DIAG_OFFSETS,
  LATEST_SLOT_INDEX,
  MIN_SLOT_BYTES,
  PUBLISH_SEQ_INDEX,
  readBufferHeader,
  readDiagnostics,
  SLOT_COUNT,
  slotCapacityFor,
  slotOffset,
  SnapshotBufferError,
  snapshotBufferBytes,
  SnapshotWriter,
  isSharedArrayBuffer,
} from './buffer';
import type { TopologyDescriptor } from './descriptor';
import {
  ISLAND_KIND_AC,
  ISLAND_KIND_DC,
  ISLAND_KIND_MIXED,
  SIM_PROTOCOL_VERSION,
  SLOT_HEADER_BYTES,
  SLOT_OFFSETS,
  SLOTS_OFFSET,
  SNAPSHOT_MAGIC,
} from './layout';
import { SnapshotReader, snapshotViewFromBytes } from './reader';
import {
  decodeSnapshot,
  encodeSnapshot,
  snapshotHashedBytes,
  snapshotSlotBytes,
  type SnapshotSource,
} from './snapshot';

/*
 * The transport (ADR 0011 §5.1, §6, §8): the shared buffer's header, the seqlock writer and reader,
 * the generation join and the `postMessage` fallback. Plan F2.3b's codec properties: a snapshot
 * round-trips, a torn read is detected and retried (with a simulated and a real concurrent writer),
 * and the fallback gives identical bytes.
 */

/** A snapshot source over plain arrays; device records are one f64 each. */
function source(o: {
  generation?: number;
  tick?: number;
  nodes?: readonly number[];
  branches?: readonly number[];
  islands?: readonly { kind: number; flags: number; iterations: number; reference: number; band: number }[];
  devices?: readonly number[];
}): SnapshotSource {
  const nodes = o.nodes ?? [0, 0, 12, 0];
  const branches = o.branches ?? [0.5, 0];
  const islands = o.islands ?? [{ kind: ISLAND_KIND_DC, flags: 0, iterations: 1, reference: 0, band: 0 }];
  const devices = o.devices ?? [];
  return {
    topologyGeneration: o.generation ?? 0,
    tick: o.tick ?? 10,
    lastSolveTick: o.tick ?? 10,
    topologyHash: 'cd'.repeat(32),
    nodeCount: nodes.length / 2,
    branchCount: branches.length / 2,
    nodes,
    branches,
    islandCount: islands.length,
    islandKinds: islands.map((i) => i.kind),
    islandFlags: islands.map((i) => i.flags),
    islandIterations: islands.map((i) => i.iterations),
    islandReferences: islands.map((i) => i.reference),
    islandUnknowns: islands.map((i) => (i.iterations > 0 ? 3 : 0)),
    islandBands: islands.map((i) => i.band),
    deviceCount: devices.length,
    deviceDataBytes: 8 * devices.length,
    writeDevices(view, offset) {
      devices.forEach((value, i) => view.setFloat64(offset + 8 * i, value, true));
    },
  };
}

/** A descriptor for a generation, with `devices` records of one f64 field `value` each. */
function descriptor(generation: number, devices = 0): TopologyDescriptor {
  const schema = {
    kind: 'test.value',
    recordBytes: 8,
    fields: [{ name: 'value', type: 'f64' as const, offset: 0, unit: null, values: null }],
  };
  return {
    protocol: SIM_PROTOCOL_VERSION,
    generation,
    topologyHash: 'cd'.repeat(32),
    nodes: [],
    branches: [],
    islands: [],
    devices: Array.from({ length: devices }, (_, i) => ({ entity: i + 1, kind: 'test.value', recordOffset: 8 * i })),
    schemas: devices > 0 ? { 'test.value': schema } : {},
  };
}

const writeWith = (s: SnapshotSource) => (slot: Uint8Array, seq: number) => void encodeSnapshot(s, slot, seq);

/** A shared buffer with room for `s`, a writer and a reader attached to it with `d` set. */
function rig(s: SnapshotSource, d: TopologyDescriptor = descriptor(s.topologyGeneration)) {
  const buffer = createSnapshotBuffer(slotCapacityFor(snapshotSlotBytes(s)) as number, true);
  const writer = new SnapshotWriter(buffer);
  const reader = new SnapshotReader();
  reader.attach(buffer);
  reader.setDescriptor(d);
  return { buffer, writer, reader };
}

const hashed = (s: SnapshotSource) => {
  const slot = new Uint8Array(snapshotSlotBytes(s));
  encodeSnapshot(s, slot);
  return snapshotHashedBytes(slot).slice();
};

const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const islandArb = fc.record({
  kind: fc.constantFrom(0, ISLAND_KIND_DC, ISLAND_KIND_AC, ISLAND_KIND_MIXED),
  flags: fc.nat({ max: 3 }),
  iterations: fc.nat({ max: 0xffff }),
  reference: fc.integer({ min: -1, max: 50 }),
  band: fc.nat({ max: 255 }),
});
const sourceArb = fc
  .record({
    generation: fc.nat({ max: 9 }),
    tick: fc.nat({ max: 2 ** 40 }),
    nodes: fc.array(finite, { maxLength: 24 }).map((a) => (a.length % 2 === 0 ? a : a.slice(1))),
    branches: fc.array(finite, { maxLength: 24 }).map((a) => (a.length % 2 === 0 ? a : a.slice(1))),
    islands: fc.array(islandArb, { maxLength: 6 }),
    devices: fc.array(finite, { maxLength: 6 }),
  })
  .map((r) => source(r));

describe('the snapshot buffer', () => {
  it('writes the header of ADR 0011 §5.1, and reads it back', () => {
    const buffer = createSnapshotBuffer(MIN_SLOT_BYTES, true);
    expect(isSharedArrayBuffer(buffer)).toBe(true);
    expect(buffer.byteLength).toBe(SLOTS_OFFSET + 2 * MIN_SLOT_BYTES);
    const view = new DataView(buffer);
    expect(view.getUint32(BUFFER_OFFSETS.magic, true)).toBe(SNAPSHOT_MAGIC);
    expect(String.fromCharCode(...new Uint8Array(buffer, 0, 4))).toBe('CSIM');
    expect(view.getUint32(BUFFER_OFFSETS.protocolVersion, true)).toBe(SIM_PROTOCOL_VERSION);
    expect(view.getUint32(BUFFER_OFFSETS.slotsOffset, true)).toBe(256);
    expect(view.getUint32(BUFFER_OFFSETS.slotCount, true)).toBe(2);
    expect(new Int32Array(buffer)[LATEST_SLOT_INDEX]).toBe(-1);
    expect(readBufferHeader(buffer)).toEqual({ slotBytes: MIN_SLOT_BYTES });
    expect(isSharedArrayBuffer(createSnapshotBuffer(128, false))).toBe(false);
    expect(snapshotBufferBytes(128)).toBe(512);
  });

  it('refuses a buffer that is not one of this protocol', () => {
    expect(() => createSnapshotBuffer(100, false)).toThrow(RangeError);
    expect(() => readBufferHeader(new ArrayBuffer(10))).toThrow(SnapshotBufferError);
    const bad = createSnapshotBuffer(128, false);
    new DataView(bad).setUint32(BUFFER_OFFSETS.magic, 1, true);
    expect(() => readBufferHeader(bad)).toThrow(/magic/);
    const other = createSnapshotBuffer(128, false);
    new DataView(other).setUint32(BUFFER_OFFSETS.protocolVersion, SIM_PROTOCOL_VERSION + 1, true);
    expect(() => readBufferHeader(other)).toThrow(/protocol/);
    const geometry = createSnapshotBuffer(128, false);
    new DataView(geometry).setUint32(BUFFER_OFFSETS.slotCount, 3, true);
    expect(() => readBufferHeader(geometry)).toThrow(/geometry/);
  });

  it('sizes slots at twice the first topology, with minimums, up to the cap (ADR 0011 §7)', () => {
    expect(MIN_SLOT_BYTES % 64).toBe(0);
    expect(slotCapacityFor(1000)).toBe(MIN_SLOT_BYTES);
    const big = MIN_SLOT_BYTES * 3 + 8;
    expect(slotCapacityFor(big)).toBe(Math.ceil((2 * big) / 64) * 64);
    expect(slotCapacityFor(5000, 4096)).toBeNull();
    expect(slotCapacityFor(4000, 4096)).toBe(4096); // doubled past the cap: clamped
    expect(slotCapacityFor(4090, 4095)).toBeNull(); // the cap isn't a multiple of 64
  });

  it('alternates slots, publishes even sequence words, and counts publishes', () => {
    const s = source({});
    const { buffer, writer } = rig(s);
    const i32 = new Int32Array(buffer);
    const seqOf = (slot: number) => i32[(slotOffset(slot, writer.slotBytes) + SLOT_OFFSETS.slotSeq) / 4];
    expect(writer.latestSlot).toBe(-1);
    writer.publish(writeWith(s));
    expect([writer.latestSlot, writer.publishSeq, seqOf(0), seqOf(1)]).toEqual([0, 1, 2, 0]);
    writer.publish(writeWith(s));
    expect([writer.latestSlot, writer.publishSeq, seqOf(0), seqOf(1)]).toEqual([1, 2, 2, 2]);
    writer.publish(writeWith(s));
    expect([writer.latestSlot, writer.publishSeq, seqOf(0)]).toEqual([0, 3, 4]);
  });

  it('never publishes a slot whose encoding threw: it stays odd and readers keep the last one', () => {
    const s = source({ tick: 7 });
    const { writer, reader } = rig(s);
    writer.publish(writeWith(s));
    expect(reader.latest()?.tick).toBe(7);
    expect(() =>
      writer.publish(() => {
        throw new Error('engine bug');
      }),
    ).toThrow('engine bug');
    expect(writer.latestSlot).toBe(0);
    expect(reader.latest()?.tick).toBe(7);
  });

  it('round-trips the diagnostics area under its own seqlock', () => {
    const buffer = createSnapshotBuffer(128, true);
    const writer = new SnapshotWriter(buffer);
    const values = {
      lastSolveMs: 0.25,
      maxSolveMs: 1.5,
      meanTickUs: 3,
      ticksPerSecond: 1000,
      busyFraction: 0.1,
      solveCount: 42,
      throttledPublishes: 2,
    };
    writer.writeDiagnostics(values);
    expect(readDiagnostics(buffer)).toEqual(values);
    expect(new DataView(buffer).getFloat64(DIAG_OFFSETS.solveCount, true)).toBe(42);
    new Int32Array(buffer)[BUFFER_OFFSETS.diagSeq / 4] = 3; // a writer stuck mid-write
    expect(readDiagnostics(buffer)).toBeNull();
  });
});

describe('the seqlock reader (ADR 0011 §6.2)', () => {
  it('round-trips any snapshot through the shared buffer: the view and its hashed bytes', () => {
    fc.assert(
      fc.property(sourceArb, (s) => {
        const { writer, reader } = rig(s, descriptor(s.topologyGeneration, s.deviceCount));
        writer.publish(writeWith(s));
        const view = reader.latest();
        expect(view).not.toBeNull();
        if (view === null) return;
        expect(view.hashedBytes()).toEqual(hashed(s));
        const decoded = decodeSnapshot(view.hashedBytes());
        expect([view.tick, view.generation, view.nodeCount, view.branchCount, view.islandCount]).toEqual([
          s.tick,
          s.topologyGeneration,
          s.nodeCount,
          s.branchCount,
          s.islandCount,
        ]);
        for (let n = 0; n < s.nodeCount; n++) {
          expect(Object.is(view.voltage(n, 0), decoded.nodes[2 * n])).toBe(true);
          expect(Object.is(view.voltage(n, 1), decoded.nodes[2 * n + 1])).toBe(true);
        }
        for (let b = 0; b < s.branchCount; b++)
          expect(Object.is(view.current(b, 0), decoded.branches[2 * b])).toBe(true);
        decoded.islands.forEach((island, i) => {
          expect(view.islandKind(i)).toBe(['empty', 'dc', 'ac', 'mixed'].indexOf(island.kind));
          expect(view.islandFlags(i)).toBe(island.flags);
          expect(view.islandIterations(i)).toBe(island.iterations);
          expect(view.islandReference(i)).toBe(island.referenceNode);
          expect(view.islandBand(i)).toBe(island.band);
        });
        expect(view.flags).toBe(decoded.flags);
      }),
      { numRuns: 60 },
    );
  });

  it('returns the same view object, does no work when nothing was published, and reads device fields', () => {
    const s = source({ devices: [1.5, -2] });
    const d = descriptor(0, 2);
    const { writer, reader } = rig(s, d);
    expect(reader.latest()).toBeNull(); // nothing published yet
    writer.publish(writeWith(s));
    expect(reader.hasNew()).toBe(true);
    const view = reader.latest();
    expect(reader.hasNew()).toBe(false);
    expect(reader.latest()).toBe(view);
    expect(reader.stats.reads).toBe(1); // the second call found nothing new
    writer.publish(writeWith(source({ tick: 20, devices: [3, 4] })));
    expect(reader.latest()).toBe(view);
    expect(view?.tick).toBe(20);
    const field = { offset: 8, type: 'f64' as const, field: d.schemas['test.value'].fields[0] };
    expect(view?.read(field)).toBe(4);
    expect(view?.descriptor).toBe(d);
  });

  it('reads every field type a device schema can use', () => {
    const typed: SnapshotSource = {
      ...source({}),
      deviceCount: 1,
      deviceDataBytes: 16,
      writeDevices(view, offset) {
        view.setFloat64(offset, 0.5, true);
        view.setUint32(offset + 8, 4_000_000_000, true);
        view.setInt32(offset + 12, -7, true);
      },
    };
    const view = snapshotViewFromBytes(hashed(typed), descriptor(0));
    const ref = (offset: number, type: 'f64' | 'u32' | 'i32' | 'u8') => ({
      offset,
      type,
      field: { name: 'x', type, offset, unit: null, values: null },
    });
    expect(view.read(ref(0, 'f64'))).toBe(0.5);
    expect(view.read(ref(8, 'u32'))).toBe(4_000_000_000);
    expect(view.read(ref(12, 'i32'))).toBe(-7);
    expect(view.read(ref(12, 'u8'))).toBe(0xf9);
  });

  it('retries a torn read: a publish that lands during the copy is discarded (simulated concurrent writer)', () => {
    const first = source({ tick: 100, nodes: [1, 1, 1, 1] });
    const { buffer, writer, reader } = rig(first);
    writer.publish(writeWith(first)); // slot 0
    writer.publish(writeWith(first)); // slot 1: latest; slot 0 is next to be written
    const i32 = new Int32Array(buffer);
    const seqIndex = (slotOffset(1, writer.slotBytes) + SLOT_OFFSETS.slotSeq) / 4;
    const slot1 = new DataView(buffer, slotOffset(1, writer.slotBytes), writer.slotBytes);
    // A concurrent writer laps the reader: it publishes slot 0, then starts rewriting slot 1 (the one
    // the reader is copying) right after the reader's first load of its sequence word, so the copy
    // takes half-written bytes; it finishes before the reader's second load.
    const realLoad = Atomics.load as (array: Int32Array, index: number) => number;
    const even = realLoad(i32, seqIndex);
    let loads = 0;
    const fake = (array: Int32Array, index: number): number => {
      if (array.buffer !== buffer || index !== seqIndex) return realLoad(array, index);
      loads++;
      if (loads === 1) {
        // The reader has its even s1; now the writer laps it.
        writer.publish(writeWith(source({ tick: 150, nodes: [5, 5, 5, 5] }))); // slot 0
        Atomics.store(i32, index, even + 1); // slot 1: odd, being written…
        slot1.setFloat64(SLOT_OFFSETS.tick, 200, true);
        slot1.setFloat64(SLOT_HEADER_BYTES, 2, true); // …the first value done, the rest still 1
        return even;
      }
      if (loads === 2) {
        for (let i = 1; i < 4; i++) slot1.setFloat64(SLOT_HEADER_BYTES + 8 * i, 2, true);
        Atomics.store(i32, index, even + 2); // complete
        Atomics.store(i32, LATEST_SLOT_INDEX, 1);
        Atomics.add(i32, PUBLISH_SEQ_INDEX, 1);
      }
      return realLoad(array, index);
    };
    const spy = vi.spyOn(Atomics, 'load').mockImplementation(fake as unknown as typeof Atomics.load);
    try {
      const view = reader.latest();
      expect(loads).toBeGreaterThanOrEqual(3); // s1, s2 (changed: retry), s1 again…
      // Never the torn mix (tick 200 with nodes 2, 1, 1, 1): the retry reads the finished slot.
      expect([view?.tick, view?.voltage(0, 0), view?.voltage(0, 1), view?.voltage(1, 1)]).toEqual([200, 2, 2, 2]);
      expect(reader.stats.misses).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the previous slot while the latest is mid-write, and counts a miss when both are', () => {
    const s = source({ tick: 5 });
    const { buffer, writer, reader } = rig(s);
    writer.publish(writeWith(s)); // slot 0
    writer.publish(writeWith(source({ tick: 6 }))); // slot 1
    const i32 = new Int32Array(buffer);
    const seq = (slot: number) => (slotOffset(slot, writer.slotBytes) + SLOT_OFFSETS.slotSeq) / 4;
    i32[seq(1)] |= 1; // the latest slot is being written
    expect(reader.latest()?.tick).toBe(5);
    Atomics.add(i32, PUBLISH_SEQ_INDEX, 1); // another publish is announced…
    i32[seq(0)] |= 1; // …and now both are busy
    expect(reader.latest()?.tick).toBe(5); // keeps the previous view
    expect(reader.stats.misses).toBe(1);
  });

  it('holds a slot of a new generation until its descriptor arrives, then shows it (ADR 0011 §6.2)', () => {
    const old = source({ generation: 0, tick: 10 });
    const { writer, reader } = rig(old);
    writer.publish(writeWith(old));
    const shown = reader.latest();
    expect(shown?.tick).toBe(10);
    writer.publish(writeWith(source({ generation: 1, tick: 20, nodes: [9, 9, 9, 9] })));
    expect(reader.latest()?.tick).toBe(10); // the slot arrived before its descriptor
    expect(reader.awaitingDescriptor).toBe(true);
    expect(shown?.voltage(1, 0)).toBe(12); // the view still shows generation 0, intact
    expect(reader.latest()?.tick).toBe(10); // and stays put until the descriptor comes
    const next = descriptor(1);
    reader.setDescriptor(next);
    expect(reader.awaitingDescriptor).toBe(false);
    const view = reader.retry();
    expect([view?.tick, view?.generation, view?.descriptor]).toEqual([20, 1, next]);
    // A slot of the previous generation is still shown with the previous descriptor…
    writer.publish(writeWith(source({ generation: 0, tick: 30 })));
    expect(reader.latest()?.descriptor.generation).toBe(0);
    // …but an older one than both descriptors is ignored.
    reader.setDescriptor(descriptor(2));
    writer.publish(writeWith(source({ generation: 0, tick: 40 })));
    expect(reader.latest()?.tick).toBe(30);
    expect(reader.awaitingDescriptor).toBe(false);
  });

  it('a replacement buffer (capacity grew) is read from the next publish on', () => {
    const s = source({ tick: 1 });
    const { reader } = rig(s);
    const bigger = createSnapshotBuffer(2 * MIN_SLOT_BYTES, true);
    const writer = new SnapshotWriter(bigger);
    reader.attach(bigger);
    writer.publish(writeWith(source({ tick: 2 })));
    expect(reader.latest()?.tick).toBe(2);
    reader.reset();
    expect(reader.current).toBeNull();
    expect(reader.descriptor).toBeNull();
  });

  it('the postMessage fallback gives identical bytes and the same view (ADR 0011 §8)', () => {
    fc.assert(
      fc.property(sourceArb, (s) => {
        const d = descriptor(s.topologyGeneration, s.deviceCount);
        const shared = rig(s, d);
        shared.writer.publish(writeWith(s));
        const viaShared = shared.reader.latest()?.hashedBytes().slice();
        // The fallback: the worker encodes one slot into a pooled ArrayBuffer and transfers it.
        const pooled = new ArrayBuffer(shared.writer.slotBytes);
        encodeSnapshot(s, new Uint8Array(pooled), 0);
        const reader = new SnapshotReader();
        reader.setDescriptor(d);
        const view = reader.acceptSlot(new Uint8Array(pooled));
        expect(view?.hashedBytes()).toEqual(viaShared);
        expect(view?.tick).toBe(s.tick);
      }),
      { numRuns: 40 },
    );
  });

  it('ignores a fallback slot that is not one, and the shared calls before attach', () => {
    const reader = new SnapshotReader();
    expect(reader.latest()).toBeNull();
    expect(reader.retry()).toBeNull();
    expect(reader.hasNew()).toBe(false);
    expect(reader.acceptSlot(new Uint8Array(10))).toBeNull();
    const lying = new Uint8Array(SLOT_HEADER_BYTES);
    new DataView(lying.buffer).setUint32(SLOT_OFFSETS.payloadBytes, 1000, true);
    expect(reader.acceptSlot(lying)).toBeNull();
    expect(() => snapshotViewFromBytes(new Uint8Array(4), descriptor(0))).toThrow(RangeError);
  });

  it('never accepts a torn snapshot from a real concurrent writer thread', async () => {
    // A writer thread publishing as fast as it can: each publish fills every node value with its own
    // publish number. A torn copy would mix two numbers; the seqlock must discard every such read.
    const nodes = 100_000;
    const s = source({ nodes: new Array(2 * nodes).fill(0) });
    const slotBytes = slotCapacityFor(snapshotSlotBytes(s)) as number;
    const buffer = createSnapshotBuffer(slotBytes, true);
    const writer = new SnapshotWriter(buffer);
    writer.publish(writeWith(s)); // a valid header in both slots' shape
    writer.publish(writeWith(s));
    const reader = new SnapshotReader(1);
    reader.attach(buffer);
    reader.setDescriptor(descriptor(0));
    const thread = new Worker(WRITER_THREAD, {
      eval: true,
      workerData: { buffer, slotBytes, slotsOffset: SLOTS_OFFSET, count: SLOT_COUNT, header: SLOT_HEADER_BYTES, nodes },
    });
    let accepted = 0;
    try {
      // Wait on conditions, not a clock: the thread is up, then it is publishing.
      const failed = new Promise<never>((_, reject) => thread.once('error', reject));
      await Promise.race([new Promise<void>((resolve) => thread.once('online', () => resolve())), failed]);
      const i32 = new Int32Array(buffer);
      while (Atomics.load(i32, PUBLISH_SEQ_INDEX) < 10) {
        await Promise.race([new Promise((resolve) => setImmediate(resolve)), failed]);
      }
      for (let i = 0; i < 20_000 && accepted < 200; i++) {
        const view = reader.latest();
        if (view === null || view.tick === 10) continue;
        const first = view.voltage(0, 0);
        expect(view.voltage(nodes - 1, 1)).toBe(first); // the last value is from the same publish
        expect(view.voltage(nodes >> 1, 0)).toBe(first);
        expect(view.tick).toBe(first);
        accepted++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      await thread.terminate();
    }
    expect(accepted).toBeGreaterThan(5);
  });
});

/**
 * The concurrent writer thread: the seqlock writer's protocol (ADR 0011 §6.1) by hand, in plain
 * JavaScript (a worker thread can't load the TypeScript sources). Each publish writes `tick` and
 * every node value as its publish number, with plain stores between the odd and even sequence words.
 */
const WRITER_THREAD = `
const { workerData } = require('node:worker_threads');
const { buffer, slotBytes, slotsOffset, count, header, nodes } = workerData;
const i32 = new Int32Array(buffer);
const PUBLISH = ${PUBLISH_SEQ_INDEX}, LATEST = ${LATEST_SLOT_INDEX};
let n = 100;
for (;;) {
  const latest = Atomics.load(i32, LATEST);
  const w = latest === 0 ? 1 : 0;
  const start = slotsOffset + w * slotBytes;
  const seq = start / 4;
  const s = Atomics.load(i32, seq);
  Atomics.store(i32, seq, s + 1);
  new DataView(buffer, start, slotBytes).setFloat64(${SLOT_OFFSETS.tick}, n, true);
  new Float64Array(buffer, start + header, 2 * nodes).fill(n);
  Atomics.store(i32, seq, s + 2);
  Atomics.store(i32, LATEST, w);
  Atomics.add(i32, PUBLISH, 1);
  n++;
  if (count < 0) break;
}
`;
