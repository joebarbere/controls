import { LATEST_SLOT_INDEX, PUBLISH_SEQ_INDEX, readBufferHeader, SLOT_COUNT, slotOffset } from './buffer';
import type { FieldRef, TopologyDescriptor } from './descriptor';
import {
  BRANCH_ENTRY_BYTES,
  ISLAND_ENTRY_BYTES,
  ISLAND_OFFSETS,
  NO_REFERENCE_NODE,
  NODE_ENTRY_BYTES,
  SLOT_HASHED_START,
  SLOT_HEADER_BYTES,
  SLOT_OFFSETS,
} from './layout';
import { MAX_READ_ATTEMPTS } from './timing';

/*
 * The reading side of the transport (ADR 0011 §6.2, §6.3): `SnapshotReader` copies the latest
 * complete slot into a private, preallocated buffer under the seqlock and joins it with its
 * generation's descriptor; `SnapshotView` reads the copy. One reader per worker, owned by `SimHost`.
 * A read is one `set()` and a few `Atomics.load`s, and allocates nothing once a generation's views exist.
 */

/** ADR 0011 §6.3: the latest snapshot, backed by the reader's private copy. Valid until the next read. */
export interface SnapshotView {
  readonly tick: number;
  readonly lastSolveTick: number;
  readonly generation: number;
  readonly descriptor: TopologyDescriptor;
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly islandCount: number;
  readonly deviceCount: number;
  /** The slot flags (`SNAPSHOT_FLAG_*`). */
  readonly flags: number;
  /** A node voltage's part: 0 = re, 1 = im (V, against the solver's ground). */
  voltage(node: number, part: 0 | 1): number;
  /** A branch current's part: 0 = re, 1 = im (A, positive from end `a` to end `b`). */
  current(branch: number, part: 0 | 1): number;
  islandKind(island: number): 0 | 1 | 2 | 3;
  islandFlags(island: number): number;
  /** −1 for none. */
  islandReference(island: number): number;
  islandIterations(island: number): number;
  /** An index into `NOMINAL_BANDS`. */
  islandBand(island: number): number;
  /** A device field; u8 enums return the code (the descriptor's schemas give the names). */
  read(field: FieldRef): number;
  /** The slot's hashed bytes (tests and `snapshot.hash` only): a view, no copy. */
  hashedBytes(): Uint8Array;
}

/**
 * The private copy and its accessors: one per reader, reused for every read. It holds two buffers:
 * reads are copied into the back one and swapped to the front only when accepted, so a rejected
 * copy (a generation with no descriptor yet) never disturbs the view the listeners hold.
 */
class CopiedSnapshot implements SnapshotView {
  /** What the view reads. */
  private front: Uint8Array;
  private data: DataView;
  /** Where the next read is copied. */
  back: Uint8Array;
  private backData: DataView;
  private nodesAt = SLOT_HEADER_BYTES;
  private branchesAt = SLOT_HEADER_BYTES;
  private islandsAt = SLOT_HEADER_BYTES;
  private devicesAt = SLOT_HEADER_BYTES;
  descriptor!: TopologyDescriptor;
  tick = 0;
  lastSolveTick = 0;
  generation = 0;
  nodeCount = 0;
  branchCount = 0;
  islandCount = 0;
  deviceCount = 0;
  flags = 0;
  payloadBytes = 0;

  constructor(capacity: number) {
    this.front = new Uint8Array(capacity);
    this.data = new DataView(this.front.buffer);
    this.back = new Uint8Array(capacity);
    this.backData = new DataView(this.back.buffer);
  }

  get capacity(): number {
    return this.back.byteLength;
  }

  /** Grows both buffers, keeping the front's bytes (the view stays valid). Rare: a bigger slot. */
  grow(capacity: number): void {
    const front = new Uint8Array(capacity);
    front.set(this.front);
    this.front = front;
    this.data = new DataView(front.buffer);
    this.back = new Uint8Array(capacity);
    this.backData = new DataView(this.back.buffer);
  }

  /** The back copy's generation (read before a descriptor is chosen). */
  copiedGeneration(): number {
    return this.backData.getUint32(SLOT_OFFSETS.topologyGeneration, true);
  }

  /** Makes the back copy the front one and re-reads its header and section offsets. */
  swapIn(descriptor: TopologyDescriptor): void {
    const front = this.front;
    const data = this.data;
    this.front = this.back;
    this.data = this.backData;
    this.back = front;
    this.backData = data;
    const d = this.data;
    const o = SLOT_OFFSETS;
    this.descriptor = descriptor;
    this.generation = d.getUint32(o.topologyGeneration, true);
    this.tick = d.getFloat64(o.tick, true);
    this.lastSolveTick = d.getFloat64(o.lastSolveTick, true);
    this.nodeCount = d.getUint32(o.nodeCount, true);
    this.branchCount = d.getUint32(o.branchCount, true);
    this.islandCount = d.getUint32(o.islandCount, true);
    this.deviceCount = d.getUint32(o.deviceCount, true);
    this.flags = d.getUint32(o.flags, true);
    this.payloadBytes = d.getUint32(o.payloadBytes, true);
    this.nodesAt = SLOT_HEADER_BYTES;
    this.branchesAt = this.nodesAt + this.nodeCount * NODE_ENTRY_BYTES;
    this.islandsAt = this.branchesAt + this.branchCount * BRANCH_ENTRY_BYTES;
    this.devicesAt = this.islandsAt + this.islandCount * ISLAND_ENTRY_BYTES;
  }

  voltage(node: number, part: 0 | 1): number {
    return this.data.getFloat64(this.nodesAt + node * NODE_ENTRY_BYTES + part * 8, true);
  }

  current(branch: number, part: 0 | 1): number {
    return this.data.getFloat64(this.branchesAt + branch * BRANCH_ENTRY_BYTES + part * 8, true);
  }

  islandKind(island: number): 0 | 1 | 2 | 3 {
    return this.data.getUint8(this.islandsAt + island * ISLAND_ENTRY_BYTES + ISLAND_OFFSETS.kind) as 0 | 1 | 2 | 3;
  }

  islandFlags(island: number): number {
    return this.data.getUint8(this.islandsAt + island * ISLAND_ENTRY_BYTES + ISLAND_OFFSETS.flags);
  }

  islandReference(island: number): number {
    const reference = this.data.getUint32(
      this.islandsAt + island * ISLAND_ENTRY_BYTES + ISLAND_OFFSETS.referenceNode,
      true,
    );
    return reference === NO_REFERENCE_NODE ? -1 : reference;
  }

  islandIterations(island: number): number {
    return this.data.getUint16(this.islandsAt + island * ISLAND_ENTRY_BYTES + ISLAND_OFFSETS.iterations, true);
  }

  islandBand(island: number): number {
    return this.data.getUint8(this.islandsAt + island * ISLAND_ENTRY_BYTES + ISLAND_OFFSETS.band);
  }

  read(field: FieldRef): number {
    const at = this.devicesAt + field.offset;
    switch (field.type) {
      case 'f64':
        return this.data.getFloat64(at, true);
      case 'u32':
        return this.data.getUint32(at, true);
      case 'i32':
        return this.data.getInt32(at, true);
      case 'u8':
        return this.data.getUint8(at);
    }
  }

  hashedBytes(): Uint8Array {
    return this.front.subarray(SLOT_HASHED_START, SLOT_HEADER_BYTES + this.payloadBytes);
  }
}

/** Counters a reader keeps (the dev HUD and `sim.stats`; the bench e2e asserts no misses). */
export interface SnapshotReaderStats {
  /** Reads that found both slots busy for every attempt and kept the previous snapshot. */
  misses: number;
  /** Accepted reads. */
  reads: number;
}

/**
 * One reader per worker (ADR 0011 §6.2). Shared-buffer mode: {@link attach} the worker's buffer,
 * then call {@link latest} on each wake-up. Fallback mode: hand each transferred slot to
 * {@link acceptSlot}. Either way the returned view is the same object every time, backed by the
 * private copy: copy out what you need, never keep it across reads.
 */
export class SnapshotReader {
  readonly stats: SnapshotReaderStats = { misses: 0, reads: 0 };
  private buffer: ArrayBufferLike | null = null;
  private i32: Int32Array | null = null;
  private slotBytes = 0;
  private copy: CopiedSnapshot | null = null;
  /** Per slot: a view of the used length, rebuilt only when the length changes (once per generation). */
  private readonly sources: (Uint8Array | null)[] = [null, null];
  private readonly seqIndex: number[] = [0, 0];
  private lastSeen: number | null = null;
  private currentDescriptor: TopologyDescriptor | null = null;
  private previousDescriptor: TopologyDescriptor | null = null;
  private view: CopiedSnapshot | null = null;
  /** A slot of a generation with no descriptor yet was read: the `topology` message is still on its way. */
  awaitingDescriptor = false;

  constructor(private readonly maxAttempts = MAX_READ_ATTEMPTS) {}

  /** The latest accepted view, or `null` before the first. */
  get current(): SnapshotView | null {
    return this.view;
  }

  /** The newest descriptor. */
  get descriptor(): TopologyDescriptor | null {
    return this.currentDescriptor;
  }

  /** The last `publishSeq` accepted (shared mode), for `Atomics.waitAsync`. */
  get publishSeq(): number {
    return this.lastSeen ?? 0;
  }

  /** Points the reader at a (new) shared buffer. Keeps the descriptors; drops the cached slot views. */
  attach(buffer: ArrayBufferLike): void {
    const { slotBytes } = readBufferHeader(buffer);
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer);
    this.slotBytes = slotBytes;
    this.sources[0] = this.sources[1] = null;
    for (let i = 0; i < SLOT_COUNT; i++) this.seqIndex[i] = (slotOffset(i, slotBytes) + SLOT_OFFSETS.slotSeq) / 4;
    this.ensureCopy(slotBytes);
    this.lastSeen = null;
  }

  /** A generation's descriptor arrived. Keeps it and the one before (slots may still be of that one). */
  setDescriptor(descriptor: TopologyDescriptor): void {
    if (this.currentDescriptor !== null && descriptor.generation <= this.currentDescriptor.generation) {
      this.currentDescriptor = descriptor; // a replacement for the same generation (a new worker never reuses a reader)
      return;
    }
    this.previousDescriptor = this.currentDescriptor;
    this.currentDescriptor = descriptor;
    this.awaitingDescriptor = false;
  }

  /** Whether a `publishSeq` other than the last one accepted is waiting (shared mode). */
  hasNew(): boolean {
    return this.i32 !== null && Atomics.load(this.i32, PUBLISH_SEQ_INDEX) !== this.lastSeen;
  }

  /**
   * Shared mode: the latest complete snapshot, copied under the seqlock (ADR 0011 §6.2). Returns the
   * previous view when nothing new was published, when both slots stayed busy (a miss), or when the
   * slot's generation has no descriptor yet ({@link awaitingDescriptor}).
   */
  latest(): SnapshotView | null {
    const i32 = this.i32;
    if (i32 === null || this.buffer === null) return this.view;
    const published = Atomics.load(i32, PUBLISH_SEQ_INDEX);
    if (published === this.lastSeen) return this.view;
    const latest = Atomics.load(i32, LATEST_SLOT_INDEX);
    if (latest < 0) return this.view;
    const copy = this.copy as CopiedSnapshot;
    for (let k = 0; k < SLOT_COUNT; k++) {
      const slot = k === 0 ? latest : 1 - latest;
      const index = this.seqIndex[slot];
      for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
        const s1 = Atomics.load(i32, index);
        if ((s1 & 1) !== 0) continue;
        const source = this.usedView(slot);
        if (source === null) continue;
        copy.back.set(source);
        if (Atomics.load(i32, index) === s1) return this.accept(published);
      }
    }
    this.stats.misses++;
    return this.view;
  }

  /**
   * Fallback mode: one transferred slot (`snapshot` message). Copies it into the private buffer as
   * the shared path does; the caller sends the buffer back with `release`.
   */
  acceptSlot(slot: Uint8Array): SnapshotView | null {
    const used = usedBytes(slot, slot.byteLength);
    if (used === null) return this.view;
    this.ensureCopy(slot.byteLength);
    (this.copy as CopiedSnapshot).back.set(slot.subarray(0, used));
    return this.accept(null);
  }

  /** Re-reads after a late descriptor (shared mode): forgets the last `publishSeq` so the slot is read again. */
  retry(): SnapshotView | null {
    if (this.i32 === null) return this.view;
    this.lastSeen = null;
    return this.latest();
  }

  /** Forgets the snapshot (a source reset: `null` to listeners). */
  reset(): void {
    this.view = null;
    this.lastSeen = null;
    this.currentDescriptor = this.previousDescriptor = null;
    this.awaitingDescriptor = false;
  }

  private ensureCopy(capacity: number): void {
    if (this.copy === null) this.copy = new CopiedSnapshot(capacity);
    else if (this.copy.capacity < capacity) this.copy.grow(capacity);
  }

  /** The used bytes of a slot in the shared buffer, as a cached view; `null` if its header is torn nonsense. */
  private usedView(slot: number): Uint8Array | null {
    const start = slotOffset(slot, this.slotBytes);
    const buffer = this.buffer as ArrayBufferLike;
    const header = new DataView(buffer, start, SLOT_HEADER_BYTES);
    const payload = header.getUint32(SLOT_OFFSETS.payloadBytes, true);
    const used = SLOT_HEADER_BYTES + payload;
    if (used > this.slotBytes) return null;
    let source = this.sources[slot];
    if (source === null || source.byteLength !== used)
      this.sources[slot] = source = new Uint8Array(buffer, start, used);
    return source;
  }

  private accept(published: number | null): SnapshotView | null {
    const copy = this.copy as CopiedSnapshot;
    const generation = copy.copiedGeneration();
    const descriptor =
      this.currentDescriptor?.generation === generation
        ? this.currentDescriptor
        : this.previousDescriptor?.generation === generation
          ? this.previousDescriptor
          : null;
    if (descriptor === null) {
      // A newer generation than any descriptor: wait for its `topology` message (lastSeen unchanged).
      if (this.currentDescriptor === null || generation > this.currentDescriptor.generation) {
        this.awaitingDescriptor = true;
      } else if (published !== null) {
        this.lastSeen = published; // an older generation than the descriptors held: ignored
      }
      return this.view;
    }
    copy.swapIn(descriptor);
    if (published !== null) this.lastSeen = published;
    this.view = copy;
    this.stats.reads++;
    return copy;
  }
}

/** A slot's used length (header plus payload), or `null` if it doesn't fit `capacity`. */
function usedBytes(slot: Uint8Array, capacity: number): number | null {
  if (slot.byteLength < SLOT_HEADER_BYTES) return null;
  const payload = new DataView(slot.buffer, slot.byteOffset, SLOT_HEADER_BYTES).getUint32(
    SLOT_OFFSETS.payloadBytes,
    true,
  );
  const used = SLOT_HEADER_BYTES + payload;
  return used <= capacity ? used : null;
}

/**
 * A view over a slot's hashed bytes (`game.snapshot()`, tests, and fake snapshots for renderer and
 * UI development): the same `SnapshotView` as the transport's. Allocates a private copy.
 */
export function snapshotViewFromBytes(hashed: Uint8Array, descriptor: TopologyDescriptor): SnapshotView {
  const slot = new Uint8Array(SLOT_HASHED_START + hashed.byteLength);
  slot.set(hashed, SLOT_HASHED_START);
  new DataView(slot.buffer).setUint32(SLOT_OFFSETS.topologyGeneration, descriptor.generation, true);
  const reader = new SnapshotReader();
  reader.setDescriptor(descriptor);
  const view = reader.acceptSlot(slot);
  if (view === null) throw new RangeError('not a snapshot: shorter than its payload');
  return view;
}
