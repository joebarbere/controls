/*
 * The snapshot layout (ADR 0011 §5, `SIM_PROTOCOL_VERSION` 2): byte offsets and codes. Shared by the
 * engine's encoder (headless and, from F2.3b, the sim worker), the reader and the tests, so every
 * runtime writes and reads the same bytes. Every multi-byte value is little-endian.
 *
 * F2.3a implements the slot (its header and payload: what is hashed). The buffer header, the
 * diagnostics area and the seqlock transport over `SharedArrayBuffer` are F2.3b's.
 */

/**
 * The protocol version (ADR 0011 §12). Any change to the layout, the island encoding, the nominal
 * bands, a device output schema, the message union or the descriptor bumps it, even an additive one.
 */
export const SIM_PROTOCOL_VERSION = 2; // 2: `error.reason` (F2.3b review); nothing hashed changed

/** The buffer header's magic: the bytes `CSIM` read as a little-endian `u32` (F2.3b writes it). */
export const SNAPSHOT_MAGIC = 0x4d495343;

/** The byte offset of slot 0 in the shared buffer (after the header and the diagnostics area). */
export const SLOTS_OFFSET = 256;

/** A slot header's size: the payload starts here. */
export const SLOT_HEADER_BYTES = 96;

/** Where a slot's hashed region starts: `slotSeq` and `topologyGeneration` (bytes 0–7) are never hashed. */
export const SLOT_HASHED_START = 8;

/** Slot header offsets (ADR 0011 §5.2). */
export const SLOT_OFFSETS = Object.freeze({
  /** `i32`, Atomics: the seqlock word, odd while being written. Not hashed. */
  slotSeq: 0,
  /** `u32`: topology changes since this engine started. Not hashed. */
  topologyGeneration: 4,
  /** `f64`: the tick this snapshot describes. */
  tick: 8,
  /** `f64`: the tick of the electrical solution in it. */
  lastSolveTick: 16,
  nodeCount: 24,
  branchCount: 28,
  islandCount: 32,
  deviceCount: 36,
  /** `u32`, a multiple of 8. */
  deviceDataBytes: 40,
  /** `u32`: {@link SNAPSHOT_FLAG_SINGULAR} | {@link SNAPSHOT_FLAG_NON_CONVERGED} | {@link SNAPSHOT_FLAG_MIXED}. */
  flags: 44,
  /** `u8[32]`: the raw SHA-256 bytes of the netlist's `topologyHash`. */
  topologyHash: 48,
  /** `u32`: the bytes used after the header. */
  payloadBytes: 80,
  /** Bytes 84–95 are reserved, written as zero (and hashed). */
  reserved: 84,
});

/** A node entry: `f64 re`, `f64 im` (V, against the solver's ground). */
export const NODE_ENTRY_BYTES = 16;
/** A branch entry: `f64 re`, `f64 im` (A, positive from end `a` to end `b`). */
export const BRANCH_ENTRY_BYTES = 16;
/** An island entry (ADR 0011 §5.3). */
export const ISLAND_ENTRY_BYTES = 16;

/** Island entry offsets. */
export const ISLAND_OFFSETS = Object.freeze({
  /** `u8`: an `ISLAND_KIND_*` code. */
  kind: 0,
  /** `u8`: `ISLAND_FLAG_*` bits. */
  flags: 1,
  /** `u16`: outer-loop iterations of the island's last solve; **0 means the island was not solved**. */
  iterations: 2,
  /** `u32`: the reference node, or {@link NO_REFERENCE_NODE}. */
  referenceNode: 4,
  /** `u32`: the order of the island's MNA system (0 when not solved). */
  unknowns: 8,
  /** `u8`: an index into `NOMINAL_BANDS`. Bytes 13–15 are reserved (zero). */
  band: 12,
});

export const ISLAND_KIND_EMPTY = 0;
export const ISLAND_KIND_DC = 1;
export const ISLAND_KIND_AC = 2;
export const ISLAND_KIND_MIXED = 3;

/** The island kinds by code (`ISLAND_KIND_*`), as F2.1 names them. */
export const ISLAND_KINDS = Object.freeze(['empty', 'dc', 'ac', 'mixed'] as const);
export type SnapshotIslandKind = (typeof ISLAND_KINDS)[number];

/** Island flag bits (the solver's `ISLAND_FLAG_*` in `sim-core` are the same bits). */
export const ISLAND_FLAG_SINGULAR = 1;
export const ISLAND_FLAG_NON_CONVERGED = 2;

/** Slot flag bits: some island is singular, didn't converge, or is mixed. */
export const SNAPSHOT_FLAG_SINGULAR = 1;
export const SNAPSHOT_FLAG_NON_CONVERGED = 2;
export const SNAPSHOT_FLAG_MIXED = 4;

/** An island with no reference node. */
export const NO_REFERENCE_NODE = 0xffff_ffff;

/** Rounds `n` up to a multiple of 8 (sections and device records start 8-aligned). */
export function align8(n: number): number {
  return (n + 7) & ~7;
}

/**
 * The bytes a slot needs for these counts: the header plus every section (ADR 0011 §5.3). Each
 * section's entries are a multiple of 8 bytes, so the sections are packed with no padding between them.
 */
export function slotBytesFor(nodeCount: number, branchCount: number, islandCount: number, deviceDataBytes: number) {
  return (
    SLOT_HEADER_BYTES +
    nodeCount * NODE_ENTRY_BYTES +
    branchCount * BRANCH_ENTRY_BYTES +
    islandCount * ISLAND_ENTRY_BYTES +
    align8(deviceDataBytes)
  );
}
