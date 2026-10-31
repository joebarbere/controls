import {
  createSnapshotBuffer,
  DescriptorIndex,
  encodeSnapshot,
  type FieldRef,
  LATEST_SLOT_INDEX,
  PUBLISH_SEQ_INDEX,
  slotCapacityFor,
  snapshotSlotBytes,
  SnapshotReader,
  type SnapshotSource,
  SLOTS_OFFSET,
  SIM_PROTOCOL_VERSION,
  type TopologyDescriptor,
} from '@controls/sim-protocol';
import { GCProfiler, getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/*
 * The main thread's per-frame snapshot read (ADR 0011 §9.2, plan F2.3b), as `sim bench` measures it:
 * `SnapshotReader.latest()` copying a fresh slot of a 500-device plant out of a shared buffer, then
 * the 500 device fields a renderer would draw. Each "frame" first announces a publish (both slots are
 * encoded once, up front, and the announcement only flips `latestSlot` and bumps `publishSeq`), so
 * every read is a real copy and nothing but the reader runs in the measured window.
 */

/** The plant: 500 devices of one 24-byte record each, 1,000 nodes, 1,500 branches, 50 islands. */
export const READ_PLANT = Object.freeze({ devices: 500, nodes: 1_000, branches: 1_500, islands: 50 });

/**
 * The allocation gate, in bytes per read. A read that allocates anything allocates at least one heap
 * object, 12 B or more (a boxed double), so every-read garbage measures 12+; a step of one scavenge's
 * bookkeeping in one window shows as up to about 1 B per read at 20,000 reads (0.88 measured; 0.000 in
 * a quiet process). 4 B fails the first and never the second: "a read allocates nothing".
 */
export const READ_ALLOCATION_GATE_BYTES = 4;

/** A reader on a shared buffer whose two slots hold the plant, and the fields a frame reads. */
export interface SnapshotReadRig {
  /** Announces a publish of the other slot (no allocation: two Atomics stores). */
  announce(): void;
  /** One frame's read: `latest()` and every device field into a preallocated array (`readAll`). */
  read(): void;
  /** The sum of the last read's fields (a checksum; outside any measured window). */
  sum(): number;
}

export function snapshotReadRig(plant = READ_PLANT): SnapshotReadRig {
  const { devices, nodes, branches, islands } = plant;
  const source: SnapshotSource = {
    topologyGeneration: 0,
    tick: 1,
    lastSolveTick: 0,
    topologyHash: 'ab'.repeat(32),
    nodeCount: nodes,
    branchCount: branches,
    nodes: new Float64Array(2 * nodes).fill(1.5),
    branches: new Float64Array(2 * branches).fill(0.25),
    islandCount: islands,
    islandKinds: new Uint8Array(islands).fill(1),
    islandFlags: new Uint8Array(islands),
    islandIterations: new Uint16Array(islands).fill(1),
    islandReferences: new Int32Array(islands),
    islandUnknowns: new Uint32Array(islands).fill(3),
    islandBands: new Uint8Array(islands),
    deviceCount: devices,
    deviceDataBytes: 24 * devices,
    writeDevices(view, offset) {
      for (let i = 0; i < devices; i++) view.setFloat64(offset + 24 * i + 8, (i % 7) / 8, true);
    },
  };
  const slotBytes = slotCapacityFor(snapshotSlotBytes(source)) as number;
  const buffer = createSnapshotBuffer(slotBytes, true);
  for (const slot of [0, 1])
    encodeSnapshot(source, new Uint8Array(buffer, SLOTS_OFFSET + slot * slotBytes, slotBytes), 2);
  const i32 = new Int32Array(buffer);
  Atomics.store(i32, LATEST_SLOT_INDEX, 0);
  const schema = {
    kind: 'lamp.incandescent',
    recordBytes: 24,
    fields: [{ name: 'lightOutputRel', type: 'f64' as const, offset: 8, unit: null, values: null }],
  };
  const descriptor: TopologyDescriptor = {
    protocol: SIM_PROTOCOL_VERSION,
    generation: 0,
    topologyHash: 'ab'.repeat(32),
    nodes: [],
    branches: [],
    islands: [],
    devices: Array.from({ length: devices }, (_, i) => ({ entity: i + 1, kind: schema.kind, recordOffset: 24 * i })),
    schemas: { [schema.kind]: schema },
  };
  const index = DescriptorIndex.of(descriptor);
  const refs = descriptor.devices.map((d) => index.field(d.entity, 'lightOutputRel') as FieldRef);
  const out = new Float64Array(devices);
  const reader = new SnapshotReader();
  reader.attach(buffer);
  reader.setDescriptor(descriptor);
  return {
    announce() {
      Atomics.store(i32, LATEST_SLOT_INDEX, 1 - Atomics.load(i32, LATEST_SLOT_INDEX));
      Atomics.add(i32, PUBLISH_SEQ_INDEX, 1);
    },
    read() {
      const before = reader.stats.reads;
      const view = reader.latest();
      if (view === null || reader.stats.reads === before) throw new Error('the read copied nothing');
      view.readAll(refs, out);
    },
    sum() {
      let sum = 0;
      for (let i = 0; i < out.length; i++) sum += out[i];
      return sum;
    },
  };
}

/**
 * Bytes allocated per frame's read, by the method of the simulation caveats: `--expose-gc` at run
 * time, a collection before each window, heap growth plus what each GC freed (`GCProfiler`), and the
 * smallest of several windows (code not yet optimised allocates more). Returned as the slope between
 * windows of `reads` and `2 × reads` reads, so the profiler's own fixed cost per window cancels out
 * and only what each read adds is left.
 */
export function bytesPerRead(rig: SnapshotReadRig, reads = 20_000, windows = 6): number {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  // Long enough for the read to reach optimised code: before that it may box what it returns.
  for (let i = 0; i < 20_000; i++) {
    rig.announce();
    rig.read();
  }
  const window = (count: number) => {
    collect();
    const profiler = new GCProfiler();
    const start = getHeapStatistics().used_heap_size;
    profiler.start();
    for (let i = 0; i < count; i++) {
      rig.announce();
      rig.read();
    }
    const stats = profiler.stop()?.statistics ?? [];
    const freed = stats.reduce(
      (sum, s) => sum + s.beforeGC.heapStatistics.usedHeapSize - s.afterGC.heapStatistics.usedHeapSize,
      0,
    );
    return getHeapStatistics().used_heap_size - start + freed;
  };
  const smallest = (count: number) => Math.min(...Array.from({ length: windows }, () => window(count)));
  return Math.max(0, (smallest(2 * reads) - smallest(reads)) / reads);
}
