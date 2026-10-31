import {
  SIM_PROTOCOL_VERSION,
  SLOT_HEADER_BYTES,
  SLOT_OFFSETS,
  SLOTS_OFFSET,
  SNAPSHOT_MAGIC,
  slotBytesFor,
} from './layout';
import { MAX_SLOT_BYTES } from './timing';

/*
 * The snapshot buffer (ADR 0011 §5.1, §5.6, §6.1): a buffer header, an unhashed diagnostics area
 * and two slots, written by the sim worker with a seqlock. `SharedArrayBuffer` and `Atomics` are
 * ECMAScript, so this is domain code. The same layout over a plain `ArrayBuffer` is what the
 * `postMessage` fallback's slots are cut from (one slot per message, §8).
 */

/** The buffer header's size (bytes 0–63). */
export const BUFFER_HEADER_BYTES = 64;

/** Buffer header offsets (ADR 0011 §5.1). */
export const BUFFER_OFFSETS = Object.freeze({
  /** `u32`: {@link SNAPSHOT_MAGIC}. */
  magic: 0,
  /** `u32`: `SIM_PROTOCOL_VERSION`. */
  protocolVersion: 4,
  /** `u32`: the byte offset of slot 0 (`SLOTS_OFFSET`). */
  slotsOffset: 8,
  /** `u32`: one slot's capacity, a multiple of 64. */
  slotBytes: 12,
  /** `u32`: 2. */
  slotCount: 16,
  /** `i32`, Atomics: incremented after each publish (wraps; compare with `!==`). */
  publishSeq: 24,
  /** `i32`, Atomics: 0 or 1, the last slot fully written; −1 before the first. */
  latestSlot: 28,
  /** `i32`, Atomics: the diagnostics area's seqlock word. */
  diagSeq: 32,
});

/** `Int32Array` indices of the three Atomics words. */
export const PUBLISH_SEQ_INDEX = BUFFER_OFFSETS.publishSeq / 4;
export const LATEST_SLOT_INDEX = BUFFER_OFFSETS.latestSlot / 4;
export const DIAG_SEQ_INDEX = BUFFER_OFFSETS.diagSeq / 4;

/** Two slots: the writer never writes the one readers are pointed at. */
export const SLOT_COUNT = 2;

/** Diagnostics offsets (ADR 0011 §5.6, bytes 64–255, all `f64`, unhashed, guarded by `diagSeq`). */
export const DIAG_OFFSETS = Object.freeze({
  lastSolveMs: 64,
  maxSolveMs: 72,
  meanTickUs: 80,
  ticksPerSecond: 88,
  busyFraction: 96,
  solveCount: 104,
  throttledPublishes: 112,
});

/** The diagnostics fields by name (what `sim.stats` and the dev HUD show). Never hashed or saved. */
export type SimDiagnostics = { -readonly [K in keyof typeof DIAG_OFFSETS]: number };

/** The smallest slot the worker allocates (ADR 0011 §7): 1 024 nodes, 2 048 branches, 256 islands, 64 KiB of records. */
export const MIN_SLOT_BYTES = align64(slotBytesFor(1024, 2048, 256, 64 * 1024));

/** Rounds `n` up to a multiple of 64. */
export function align64(n: number): number {
  return Math.ceil(n / 64) * 64;
}

/** A slot's byte offset in the buffer. */
export function slotOffset(slot: number, slotBytes: number): number {
  return SLOTS_OFFSET + slot * slotBytes;
}

/**
 * The slot capacity for a generation that needs `needed` bytes (ADR 0011 §7): twice that, at least
 * {@link MIN_SLOT_BYTES}, a multiple of 64. `null` when even `needed` is over {@link MAX_SLOT_BYTES}
 * (`error {code: 'capacity'}`); a doubled size over the cap is clamped to it.
 */
export function slotCapacityFor(
  needed: number,
  maxSlotBytes = MAX_SLOT_BYTES,
  minSlotBytes = MIN_SLOT_BYTES,
): number | null {
  const cap = Math.floor(maxSlotBytes / 64) * 64;
  const size = Math.min(align64(Math.max(minSlotBytes, 2 * needed)), cap);
  return size >= needed ? size : null;
}

/** The byte length of a buffer with two slots of `slotBytes`. */
export function snapshotBufferBytes(slotBytes: number): number {
  return SLOTS_OFFSET + SLOT_COUNT * slotBytes;
}

/** A buffer that isn't a snapshot buffer of this protocol (bad magic or version, too short). */
export class SnapshotBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotBufferError';
  }
}

/** Whether `value` is a `SharedArrayBuffer`, safe where the global is missing (a page that isn't isolated). */
export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return Object.prototype.toString.call(value) === '[object SharedArrayBuffer]';
}

/**
 * Allocates a snapshot buffer for slots of `slotBytes` (a multiple of 64) and writes its header:
 * shared (`SharedArrayBuffer`, the fast path) or not (a plain `ArrayBuffer`, for tests). Every other
 * byte is zero; `latestSlot` starts at −1.
 */
export function createSnapshotBuffer(slotBytes: number, shared: boolean): ArrayBufferLike {
  if (!Number.isInteger(slotBytes) || slotBytes < SLOT_HEADER_BYTES || slotBytes % 64 !== 0) {
    throw new RangeError(`slotBytes must be a multiple of 64 of at least ${SLOT_HEADER_BYTES}, got ${slotBytes}`);
  }
  const length = snapshotBufferBytes(slotBytes);
  const buffer = shared ? new SharedArrayBuffer(length) : new ArrayBuffer(length);
  const view = new DataView(buffer);
  view.setUint32(BUFFER_OFFSETS.magic, SNAPSHOT_MAGIC, true);
  view.setUint32(BUFFER_OFFSETS.protocolVersion, SIM_PROTOCOL_VERSION, true);
  view.setUint32(BUFFER_OFFSETS.slotsOffset, SLOTS_OFFSET, true);
  view.setUint32(BUFFER_OFFSETS.slotBytes, slotBytes, true);
  view.setUint32(BUFFER_OFFSETS.slotCount, SLOT_COUNT, true);
  new Int32Array(buffer)[LATEST_SLOT_INDEX] = -1;
  return buffer;
}

/** Reads and checks a snapshot buffer's header; returns its slot capacity. */
export function readBufferHeader(buffer: ArrayBufferLike): { readonly slotBytes: number } {
  if (buffer.byteLength < SLOTS_OFFSET) throw new SnapshotBufferError('not a snapshot buffer: too short');
  const view = new DataView(buffer);
  if (view.getUint32(BUFFER_OFFSETS.magic, true) !== SNAPSHOT_MAGIC) {
    throw new SnapshotBufferError('not a snapshot buffer: bad magic');
  }
  const version = view.getUint32(BUFFER_OFFSETS.protocolVersion, true);
  if (version !== SIM_PROTOCOL_VERSION) {
    throw new SnapshotBufferError(`snapshot protocol ${version}, this build reads ${SIM_PROTOCOL_VERSION}`);
  }
  const slotBytes = view.getUint32(BUFFER_OFFSETS.slotBytes, true);
  if (
    view.getUint32(BUFFER_OFFSETS.slotsOffset, true) !== SLOTS_OFFSET ||
    view.getUint32(BUFFER_OFFSETS.slotCount, true) !== SLOT_COUNT ||
    slotBytes % 64 !== 0 ||
    buffer.byteLength < snapshotBufferBytes(slotBytes)
  ) {
    throw new SnapshotBufferError('not a snapshot buffer: bad geometry');
  }
  return { slotBytes };
}

/**
 * The seqlock writer (ADR 0011 §6.1), used only by the sim worker, the one writer. Each publish
 * writes the slot readers are **not** pointed at: its `slotSeq` goes odd, the slot is encoded with
 * plain stores, `slotSeq` goes even, then `latestSlot` and `publishSeq` move and readers are woken.
 */
export class SnapshotWriter {
  readonly slotBytes: number;
  private readonly i32: Int32Array;
  private readonly slots: readonly Uint8Array[];
  private readonly seqIndex: readonly number[];
  private readonly shared: boolean;

  constructor(readonly buffer: ArrayBufferLike) {
    this.slotBytes = readBufferHeader(buffer).slotBytes;
    this.i32 = new Int32Array(buffer);
    this.shared = isSharedArrayBuffer(buffer);
    const slots: Uint8Array[] = [];
    const seqIndex: number[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const at = slotOffset(i, this.slotBytes);
      slots.push(new Uint8Array(buffer, at, this.slotBytes));
      seqIndex.push((at + SLOT_OFFSETS.slotSeq) / 4);
    }
    this.slots = slots;
    this.seqIndex = seqIndex;
  }

  /** The slot index the last publish completed, or −1. */
  get latestSlot(): number {
    return Atomics.load(this.i32, LATEST_SLOT_INDEX);
  }

  /** How many publishes have completed (wraps as an `i32`). */
  get publishSeq(): number {
    return Atomics.load(this.i32, PUBLISH_SEQ_INDEX);
  }

  /**
   * Publishes one snapshot. `encode(slot, slotSeq)` writes the whole slot (the codec's
   * `encodeSnapshot`, which also writes the odd `slotSeq` it is given into the seqlock word) and
   * must not keep the view. If it throws, the slot is left odd and is never published: readers
   * keep the previous one.
   */
  publish(encode: (slot: Uint8Array, slotSeq: number) => void): void {
    const latest = this.latestSlot;
    const w = latest === 0 ? 1 : 0;
    const index = this.seqIndex[w];
    const s = Atomics.load(this.i32, index);
    const odd = (s + 1) | 0;
    Atomics.store(this.i32, index, odd); // odd: writing
    encode(this.slots[w], odd);
    Atomics.store(this.i32, index, (s + 2) | 0); // even: complete
    Atomics.store(this.i32, LATEST_SLOT_INDEX, w);
    Atomics.add(this.i32, PUBLISH_SEQ_INDEX, 1);
    // Only a shared buffer has waiters (`Atomics.notify` on a plain buffer returns 0 anyway).
    if (this.shared) Atomics.notify(this.i32, PUBLISH_SEQ_INDEX);
  }

  /** Writes the diagnostics area under its own seqlock (ADR 0011 §5.6). Unhashed, never saved. */
  writeDiagnostics(values: Readonly<SimDiagnostics>): void {
    const s = Atomics.load(this.i32, DIAG_SEQ_INDEX);
    Atomics.store(this.i32, DIAG_SEQ_INDEX, (s + 1) | 0);
    const view = new DataView(this.buffer, 0, SLOTS_OFFSET);
    for (const key of Object.keys(DIAG_OFFSETS) as (keyof SimDiagnostics)[]) {
      view.setFloat64(DIAG_OFFSETS[key], values[key], true);
    }
    Atomics.store(this.i32, DIAG_SEQ_INDEX, (s + 2) | 0);
  }
}

/** Reads the diagnostics area, retrying a torn read; `null` if a writer kept it busy. */
export function readDiagnostics(buffer: ArrayBufferLike, attempts = 4): SimDiagnostics | null {
  const i32 = new Int32Array(buffer, 0, BUFFER_HEADER_BYTES / 4);
  const view = new DataView(buffer, 0, SLOTS_OFFSET);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const s1 = Atomics.load(i32, DIAG_SEQ_INDEX);
    if ((s1 & 1) !== 0) continue;
    const out = {} as SimDiagnostics;
    for (const key of Object.keys(DIAG_OFFSETS) as (keyof SimDiagnostics)[]) {
      out[key] = view.getFloat64(DIAG_OFFSETS[key], true);
    }
    if (Atomics.load(i32, DIAG_SEQ_INDEX) === s1) return out;
  }
  return null;
}
