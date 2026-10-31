import { sha256, toHex } from '@controls/world-model';
import {
  ISLAND_ENTRY_BYTES,
  ISLAND_FLAG_NON_CONVERGED,
  ISLAND_FLAG_SINGULAR,
  ISLAND_KIND_MIXED,
  ISLAND_KINDS,
  ISLAND_OFFSETS,
  NO_REFERENCE_NODE,
  SLOT_HASHED_START,
  SLOT_HEADER_BYTES,
  SLOT_OFFSETS,
  SNAPSHOT_FLAG_MIXED,
  SNAPSHOT_FLAG_NON_CONVERGED,
  SNAPSHOT_FLAG_SINGULAR,
  slotBytesFor,
  type SnapshotIslandKind,
} from './layout';

/*
 * The snapshot slot codec (ADR 0011 §5): `encodeSnapshot` writes one slot (its header and payload)
 * from the engine's state, and `decodeSnapshot` reads the hashed bytes back (tests and tools; the
 * renderer's allocation-free `SnapshotReader` and `SnapshotView` are F2.3b's). The hashed region is a
 * pure function of the snapshot's content, so the same engine state gives the same bytes in every
 * runtime and through either transport.
 *
 * Little-endian `DataView` stores, so the bytes don't depend on the platform's byte order. Every
 * reserved and padding byte is zero (hashed padding is hashed). `-0` is written as `+0`, and a
 * non-finite value is refused (`SnapshotEncodeError`): the engine never stores one, so one reaching
 * the encoder is an engine bug (`engine-threw`, ADR 0011 §5.3).
 */

/**
 * What a slot describes, as struct-of-arrays the engine keeps preallocated, so encoding a snapshot
 * allocates nothing. Arrays may be longer than their counts (capacity); only the counted entries are
 * read.
 */
export interface SnapshotSource {
  /** Not hashed: counts topology changes since the engine started. */
  readonly topologyGeneration: number;
  readonly tick: number;
  readonly lastSolveTick: number;
  /** The netlist's `topologyHash`: 64 lower-case hex digits. */
  readonly topologyHash: string;
  readonly nodeCount: number;
  readonly branchCount: number;
  /** `re, im` per node, in the netlist's order. */
  readonly nodes: ArrayLike<number>;
  /** `re, im` per branch, in the netlist's order. */
  readonly branches: ArrayLike<number>;
  readonly islandCount: number;
  /** Per island: an `ISLAND_KIND_*` code. */
  readonly islandKinds: ArrayLike<number>;
  /** Per island: `ISLAND_FLAG_*` bits. */
  readonly islandFlags: ArrayLike<number>;
  /** Per island: outer-loop iterations of its last solve, 0 when it wasn't solved. */
  readonly islandIterations: ArrayLike<number>;
  /** Per island: its reference node, or −1 for none. */
  readonly islandReferences: ArrayLike<number>;
  /** Per island: the order of its MNA system, 0 when not solved. */
  readonly islandUnknowns: ArrayLike<number>;
  /** Per island: an index into `NOMINAL_BANDS`. */
  readonly islandBands: ArrayLike<number>;
  readonly deviceCount: number;
  /** A multiple of 8. */
  readonly deviceDataBytes: number;
  /** Writes every device record into `[offset, offset + deviceDataBytes)`, which arrives zeroed. */
  writeDevices(view: DataView, offset: number): void;
}

/** A value the snapshot can't hold (non-finite, out of range): an engine bug, never a world error. */
export class SnapshotEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotEncodeError';
  }
}

/** The bytes a slot for `source` needs. */
export function snapshotSlotBytes(source: SnapshotSource): number {
  return slotBytesFor(source.nodeCount, source.branchCount, source.islandCount, source.deviceDataBytes);
}

function u32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new SnapshotEncodeError(`${name} must be a u32, got ${value}`);
  }
  return value;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new SnapshotEncodeError(`${name} must be finite, got ${value}`);
  return value + 0; // -0 → +0
}

/** A lower-case hex digit's value, or −1. */
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

function writeHashBytes(view: DataView, offset: number, hex: string): void {
  if (hex.length !== 64) throw new SnapshotEncodeError('topologyHash must be 64 lower-case hex digits');
  for (let i = 0; i < 32; i++) {
    const high = hexDigit(hex.charCodeAt(2 * i));
    const low = hexDigit(hex.charCodeAt(2 * i + 1));
    if (high < 0 || low < 0) throw new SnapshotEncodeError('topologyHash must be 64 lower-case hex digits');
    view.setUint8(offset + i, (high << 4) | low);
  }
}

/**
 * Writes one slot for `source` at `slot`'s start, with `slotSeq` (even: complete) in the unhashed
 * seqlock word. Returns the bytes used (`snapshotSlotBytes`). Throws a `RangeError` if `slot` is too
 * small, and a {@link SnapshotEncodeError} for a value the layout can't hold.
 */
export function encodeSnapshot(source: SnapshotSource, slot: Uint8Array, slotSeq = 0): number {
  const used = snapshotSlotBytes(source);
  if (slot.byteLength < used) throw new RangeError(`the slot holds ${slot.byteLength} bytes; ${used} are needed`);
  if (source.deviceDataBytes % 8 !== 0) throw new SnapshotEncodeError('deviceDataBytes must be a multiple of 8');
  slot.fill(0, 0, used);
  const view = new DataView(slot.buffer, slot.byteOffset, used);
  const o = SLOT_OFFSETS;
  view.setInt32(o.slotSeq, slotSeq, true);
  view.setUint32(o.topologyGeneration, u32('topologyGeneration', source.topologyGeneration), true);
  view.setFloat64(o.tick, finite('tick', source.tick), true);
  view.setFloat64(o.lastSolveTick, finite('lastSolveTick', source.lastSolveTick), true);
  view.setUint32(o.nodeCount, u32('nodeCount', source.nodeCount), true);
  view.setUint32(o.branchCount, u32('branchCount', source.branchCount), true);
  view.setUint32(o.islandCount, u32('islandCount', source.islandCount), true);
  view.setUint32(o.deviceCount, u32('deviceCount', source.deviceCount), true);
  view.setUint32(o.deviceDataBytes, source.deviceDataBytes, true);
  writeHashBytes(view, o.topologyHash, source.topologyHash);
  view.setUint32(o.payloadBytes, used - SLOT_HEADER_BYTES, true);

  let at = SLOT_HEADER_BYTES;
  for (let i = 0; i < 2 * source.nodeCount; i++, at += 8)
    view.setFloat64(at, finite('node voltage', source.nodes[i]), true);
  for (let i = 0; i < 2 * source.branchCount; i++, at += 8) {
    view.setFloat64(at, finite('branch current', source.branches[i]), true);
  }
  let flags = 0;
  for (let i = 0; i < source.islandCount; i++, at += ISLAND_ENTRY_BYTES) {
    const kind = source.islandKinds[i];
    const islandFlags = source.islandFlags[i];
    if (!Number.isInteger(kind) || kind < 0 || kind >= ISLAND_KINDS.length) {
      throw new SnapshotEncodeError(`island ${i}: kind ${kind} is not an island kind code`);
    }
    if (!Number.isInteger(islandFlags) || islandFlags < 0 || islandFlags > 0xff) {
      throw new SnapshotEncodeError(`island ${i}: flags ${islandFlags} don't fit a u8`);
    }
    const iterations = source.islandIterations[i];
    if (!Number.isInteger(iterations) || iterations < 0 || iterations > 0xffff) {
      throw new SnapshotEncodeError(`island ${i}: iterations ${iterations} don't fit a u16`);
    }
    const band = source.islandBands[i];
    if (!Number.isInteger(band) || band < 0 || band > 0xff) throw new SnapshotEncodeError(`island ${i}: band ${band}`);
    const reference = source.islandReferences[i];
    view.setUint8(at + ISLAND_OFFSETS.kind, kind);
    view.setUint8(at + ISLAND_OFFSETS.flags, islandFlags);
    view.setUint16(at + ISLAND_OFFSETS.iterations, iterations, true);
    view.setUint32(
      at + ISLAND_OFFSETS.referenceNode,
      reference < 0 ? NO_REFERENCE_NODE : u32('reference', reference),
      true,
    );
    view.setUint32(at + ISLAND_OFFSETS.unknowns, u32('unknowns', source.islandUnknowns[i]), true);
    view.setUint8(at + ISLAND_OFFSETS.band, band);
    if ((islandFlags & ISLAND_FLAG_SINGULAR) !== 0) flags |= SNAPSHOT_FLAG_SINGULAR;
    if ((islandFlags & ISLAND_FLAG_NON_CONVERGED) !== 0) flags |= SNAPSHOT_FLAG_NON_CONVERGED;
    if (kind === ISLAND_KIND_MIXED) flags |= SNAPSHOT_FLAG_MIXED;
  }
  view.setUint32(o.flags, flags, true);
  if (source.deviceDataBytes > 0) source.writeDevices(view, at);
  return used;
}

/** The hashed region of an encoded slot (`[8, 96 + payloadBytes)`, ADR 0011 §5.2), as a view (no copy). */
export function snapshotHashedBytes(slot: Uint8Array): Uint8Array {
  if (slot.byteLength < SLOT_HEADER_BYTES) throw new RangeError('not a snapshot slot: too short');
  const payload = new DataView(slot.buffer, slot.byteOffset, SLOT_HEADER_BYTES).getUint32(
    SLOT_OFFSETS.payloadBytes,
    true,
  );
  const end = SLOT_HEADER_BYTES + payload;
  if (slot.byteLength < end) throw new RangeError('not a snapshot slot: shorter than its payload');
  return slot.subarray(SLOT_HASHED_START, end);
}

/** `snapshotHash`: SHA-256 of a slot's hashed bytes, in lower-case hex (ADR 0011 §5.2). */
export function snapshotHash(hashed: Uint8Array): string {
  return toHex(sha256(hashed));
}

/** One island of a decoded snapshot. */
export interface DecodedIsland {
  readonly kind: SnapshotIslandKind;
  readonly flags: number;
  readonly iterations: number;
  /** −1 for none. */
  readonly referenceNode: number;
  readonly unknowns: number;
  readonly band: number;
}

/** A snapshot read back from its hashed bytes. Allocates: for tests, tools and `game.snapshot()` readers. */
export interface DecodedSnapshot {
  readonly tick: number;
  readonly lastSolveTick: number;
  readonly flags: number;
  readonly topologyHash: string;
  /** `re, im` per node. */
  readonly nodes: Float64Array;
  /** `re, im` per branch. */
  readonly branches: Float64Array;
  readonly islands: readonly DecodedIsland[];
  readonly deviceCount: number;
  /** The device section's bytes (a copy). */
  readonly devices: Uint8Array;
}

/** Thrown by {@link decodeSnapshot} for bytes that aren't a well-formed snapshot. */
export class SnapshotDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotDecodeError';
  }
}

/**
 * Reads a slot's hashed bytes (what `snapshotHashedBytes` and `game.snapshot()` give) back into
 * plain data. Checks that the counts, the payload length and the reserved bytes agree; throws a
 * {@link SnapshotDecodeError} otherwise.
 */
export function decodeSnapshot(hashed: Uint8Array): DecodedSnapshot {
  const base = -SLOT_HASHED_START; // hashed byte 0 is slot byte 8
  if (hashed.byteLength < SLOT_HEADER_BYTES - SLOT_HASHED_START) throw new SnapshotDecodeError('too short');
  const view = new DataView(hashed.buffer, hashed.byteOffset, hashed.byteLength);
  const at = (slotOffset: number) => slotOffset + base;
  const o = SLOT_OFFSETS;
  const nodeCount = view.getUint32(at(o.nodeCount), true);
  const branchCount = view.getUint32(at(o.branchCount), true);
  const islandCount = view.getUint32(at(o.islandCount), true);
  const deviceDataBytes = view.getUint32(at(o.deviceDataBytes), true);
  const payload = view.getUint32(at(o.payloadBytes), true);
  const expected = slotBytesFor(nodeCount, branchCount, islandCount, deviceDataBytes) - SLOT_HEADER_BYTES;
  if (payload !== expected || hashed.byteLength !== SLOT_HEADER_BYTES - SLOT_HASHED_START + payload) {
    throw new SnapshotDecodeError("the payload length doesn't match the counts");
  }
  for (let i = o.reserved; i < SLOT_HEADER_BYTES; i++) {
    if (view.getUint8(at(i)) !== 0) throw new SnapshotDecodeError('a reserved byte is not zero');
  }
  const hash = toHex(hashed.subarray(at(o.topologyHash), at(o.topologyHash) + 32));
  let offset = at(SLOT_HEADER_BYTES);
  const nodes = new Float64Array(2 * nodeCount);
  for (let i = 0; i < nodes.length; i++, offset += 8) nodes[i] = view.getFloat64(offset, true);
  const branches = new Float64Array(2 * branchCount);
  for (let i = 0; i < branches.length; i++, offset += 8) branches[i] = view.getFloat64(offset, true);
  const islands: DecodedIsland[] = [];
  for (let i = 0; i < islandCount; i++, offset += ISLAND_ENTRY_BYTES) {
    const code = view.getUint8(offset + ISLAND_OFFSETS.kind);
    if (code >= ISLAND_KINDS.length) throw new SnapshotDecodeError(`island ${i} has an unknown kind`);
    const reference = view.getUint32(offset + ISLAND_OFFSETS.referenceNode, true);
    for (let r = ISLAND_OFFSETS.band + 1; r < ISLAND_ENTRY_BYTES; r++) {
      if (view.getUint8(offset + r) !== 0) throw new SnapshotDecodeError('a reserved byte is not zero');
    }
    islands.push({
      kind: ISLAND_KINDS[code],
      flags: view.getUint8(offset + ISLAND_OFFSETS.flags),
      iterations: view.getUint16(offset + ISLAND_OFFSETS.iterations, true),
      referenceNode: reference === NO_REFERENCE_NODE ? -1 : reference,
      unknowns: view.getUint32(offset + ISLAND_OFFSETS.unknowns, true),
      band: view.getUint8(offset + ISLAND_OFFSETS.band),
    });
  }
  return {
    tick: view.getFloat64(at(o.tick), true),
    lastSolveTick: view.getFloat64(at(o.lastSolveTick), true),
    flags: view.getUint32(at(o.flags), true),
    topologyHash: hash,
    nodes,
    branches,
    islands,
    deviceCount: view.getUint32(at(o.deviceCount), true),
    devices: hashed.slice(offset, offset + deviceDataBytes),
  };
}
