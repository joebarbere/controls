import { CONNECTION_OUTPUT_FIELDS } from './connection-output';
import type { TopologyDescriptor } from './descriptor';
import { islandStatus, type IslandStatus } from './island-status';
import { ISLAND_KIND_AC, ISLAND_KIND_MIXED } from './layout';
import { type ConnectionReadPlan, READ_F64, READ_I32, READ_NONE, READ_U32, READ_U8, type SnapshotView } from './reader';

/*
 * The netlist readout (plan F2.6): every node's |V| against its island's reference and every branch's
 * |I| and direction, read out of a `SnapshotView` into preallocated arrays, with each island's status
 * and nominal band. It is what the voltage and current overlays draw and what the netlist inspector
 * lists, so both agree on which values are a reading (ADR 0011 §5.3, `islandStatus`).
 *
 * Readers compute no electrical quantity beyond ADR 0011 §5.3's: a node's voltage is
 * `|V(node) − V(islandReference)|` (a complex magnitude for AC), a branch's current is `|I|`, and the
 * direction of a DC current is the sign of its real part (positive from the descriptor's end `a` to
 * end `b`). AC has no direction here: a phasor's sign is a phase, not a flow (rendering caveats).
 *
 * Protocol 7 adds every **connection record** (F3.6 part 3): the descriptor's `connections`, in its
 * order, each record's fields copied into `connectionValues` in `CONNECTION_OUTPUT_FIELDS` order, so
 * the overlays and the inspector read drops and temperatures from records, never from `connection.sim`
 * (ADR 0011's F3.6 part 1 amendment). A record's electrical fields (current, drops, end voltages) are
 * a reading only when their bit is set in its `readings` value (`CONNECTION_READING_*`): never read a
 * clear field as 0 A or 0 V. An `open` record's current is a reading of 0, but a gap (an
 * `intermittentOpen` end, a fused lead) carries the voltage across it, or no reading; a free end has no
 * end voltage. An end whose state is `none` has no temperature or contact.
 *
 * Built once per descriptor (cached by identity, like `DescriptorIndex`); {@link NetlistReadout.read}
 * allocates nothing, so a renderer may call it on every snapshot (`sim bench`'s `overlay-read` case
 * gates it at 0 B per read).
 */

/** The number of values per connection in {@link NetlistReading.connectionValues}. */
export const CONNECTION_VALUE_COUNT = CONNECTION_OUTPUT_FIELDS.length;

/** Each connection field's index within a connection's values (`CONNECTION_OUTPUT_FIELDS` order). */
export const CONNECTION_VALUE_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(CONNECTION_OUTPUT_FIELDS.map((field, i) => [field.name, i])),
);
const STATUS_INDEX = CONNECTION_VALUE_INDEX['status'];
/** Whether `kind`'s schema in `descriptor` is `CONNECTION_OUTPUT_FIELDS` exactly (names, types, offsets, order). */
function isProtocolLayout(descriptor: TopologyDescriptor, kind: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(descriptor.connectionSchemas, kind)) return false;
  const fields = descriptor.connectionSchemas[kind].fields;
  return (
    fields.length === CONNECTION_OUTPUT_FIELDS.length &&
    CONNECTION_OUTPUT_FIELDS.every(
      (f, i) => fields[i].name === f.name && fields[i].type === f.type && fields[i].offset === f.offset,
    )
  );
}

const READ_TYPES: Readonly<Record<string, number>> = { f64: READ_F64, u32: READ_U32, i32: READ_I32, u8: READ_U8 };

/** {@link NetlistReading.islandStatus} codes; 0 is "no reading yet", so a zeroed array is never a reading. */
export const READING_STATUSES = Object.freeze([
  'none',
  'solved',
  'singular',
  'nonConverged',
  'unmodelled',
  'mixed',
] as const);
export type ReadingStatus = (typeof READING_STATUSES)[number];
export const READING_NONE = 0;
export const READING_SOLVED = 1;

const STATUS_CODE: Readonly<Record<IslandStatus, number>> = Object.freeze({
  solved: 1,
  singular: 2,
  nonConverged: 3,
  unmodelled: 4,
  mixed: 5,
});

/** The code of an {@link IslandStatus} in {@link READING_STATUSES}. */
export const readingStatusCode = (status: IslandStatus): number => STATUS_CODE[status];

/**
 * One snapshot's readout, in arrays sized for one descriptor (index = the descriptor's numbering).
 * Values of an island that isn't `solved` are written 0 and must not be shown as 0 V or 0 A: check
 * `islandStatus` (and `islandReferenced` for voltages) first.
 */
export interface NetlistReading {
  /** The descriptor these arrays are sized and numbered for. */
  readonly descriptor: TopologyDescriptor;
  /** Per island: a {@link READING_STATUSES} code; {@link READING_NONE} until the first read. */
  readonly islandStatus: Uint8Array;
  /** Per island: an index into `NOMINAL_BANDS` (0 = `none`, no scale). */
  readonly islandBand: Uint8Array;
  /** Per island: 1 if it is AC (an AC or mixed island, ADR 0011 §5.3: "a mixed island is shown as AC"). */
  readonly islandAc: Uint8Array;
  /** Per island: 1 if it has a reference node (voltages are relative to it), else 0. */
  readonly islandReferenced: Uint8Array;
  /** Per node: |V(node) − V(reference)| in V (0 unless its island is solved and referenced). */
  readonly nodeVolts: Float64Array;
  /** Per branch: |I| in A (0 unless its island is solved). */
  readonly branchAmps: Float64Array;
  /** Per branch: +1 (from `a` to `b`) or −1 for a DC current with a non-zero real part, else 0 (AC, zero, unsolved). */
  readonly branchDirection: Int8Array;
  /**
   * Per descriptor connection (protocol 7): its record's `status` code (`CONNECTION_RECORD_STATUS_VALUES`;
   * 0 `unsolved` until read, and for a connection whose kind's schema the readout doesn't know).
   */
  readonly connectionStatus: Uint8Array;
  /**
   * Per descriptor connection, {@link CONNECTION_VALUE_COUNT} values in `CONNECTION_OUTPUT_FIELDS`
   * order (`CONNECTION_VALUE_INDEX`); u8 enums as their codes.
   */
  readonly connectionValues: Float64Array;
  /** The snapshot's tick, when read. */
  tick: number;
}

const readouts = new WeakMap<TopologyDescriptor, NetlistReadout>();

/** Lookups and the allocation-free read for one descriptor: `NetlistReadout.of(view.descriptor)`. */
export class NetlistReadout {
  private readonly nodeIsland: Uint32Array;
  private readonly branchIsland: Uint32Array;
  private readonly nodesByTerminal = new Map<number, Map<string, number>>();
  private readonly branchesByConnection = new Map<number, number>();
  private readonly recordsByConnection = new Map<number, number>();
  /**
   * Every connection record's every field, in `connectionValues` order: the batched read's plan,
   * resolved once per descriptor (a connection whose kind has no complete schema reads as zeros).
   */
  private readonly connectionPlan: ConnectionReadPlan;

  private constructor(readonly descriptor: TopologyDescriptor) {
    const byKind = new Map<string, readonly { offset: number; type: number }[] | null>();
    const fieldsOf = (kind: string) => {
      let fields = byKind.get(kind);
      if (fields === undefined) {
        const schema = Object.prototype.hasOwnProperty.call(descriptor.connectionSchemas, kind)
          ? descriptor.connectionSchemas[kind]
          : undefined;
        const resolved = CONNECTION_OUTPUT_FIELDS.map((wanted) => {
          const field = schema?.fields.find((f) => f.name === wanted.name && f.type === wanted.type);
          return field === undefined ? null : { offset: field.offset, type: READ_TYPES[field.type] };
        });
        fields = resolved.every((r) => r !== null) ? (resolved as { offset: number; type: number }[]) : null;
        byKind.set(kind, fields);
      }
      return fields;
    };
    const n = descriptor.connections.length * CONNECTION_VALUE_COUNT;
    const offsets = new Uint32Array(n);
    const types = new Uint8Array(n).fill(READ_NONE);
    descriptor.connections.forEach((c, index) => {
      this.recordsByConnection.set(c.connection, index);
      const fields = fieldsOf(c.kind);
      if (fields === null) return;
      fields.forEach((field, i) => {
        offsets[index * CONNECTION_VALUE_COUNT + i] = c.recordOffset + field.offset;
        types[index * CONNECTION_VALUE_COUNT + i] = field.type;
      });
    });
    let aligned = true;
    for (let k = 0; k < n; k++) if (types[k] === READ_F64 && (offsets[k] & 7) !== 0) aligned = false;
    // The fast path: every kind's schema is the protocol layout itself, every record 8-aligned.
    const canonical =
      aligned &&
      descriptor.connections.every((c) => (c.recordOffset & 7) === 0 && isProtocolLayout(descriptor, c.kind));
    const records = canonical ? Uint32Array.from(descriptor.connections, (c) => c.recordOffset) : null;
    this.connectionPlan = { offsets, types, aligned, records };
    this.nodeIsland = Uint32Array.from(descriptor.nodes, (n) => n.island);
    this.branchIsland = Uint32Array.from(descriptor.branches, (b) => b.island);
    descriptor.nodes.forEach((node, index) => {
      for (const member of node.members) {
        let byTerminal = this.nodesByTerminal.get(member.entity);
        if (byTerminal === undefined) this.nodesByTerminal.set(member.entity, (byTerminal = new Map()));
        byTerminal.set(member.terminal, index);
      }
    });
    descriptor.branches.forEach((branch, index) => {
      if (branch.element.kind === 'connection') this.branchesByConnection.set(branch.element.connection, index);
    });
  }

  /** The readout of `descriptor`, built on first use and cached by identity. */
  static of(descriptor: TopologyDescriptor): NetlistReadout {
    let readout = readouts.get(descriptor);
    if (readout === undefined) readouts.set(descriptor, (readout = new NetlistReadout(descriptor)));
    return readout;
  }

  /** The node holding terminal `terminal` of entity `entity`, or −1 (not netlisted in this generation). */
  nodeOf(entity: number, terminal: string): number {
    return this.nodesByTerminal.get(entity)?.get(terminal) ?? -1;
  }

  /** The branch a lead (connection id) compiled to, or −1 (absent from this generation, ADR 0011 §7). */
  branchOfConnection(connection: number): number {
    return this.branchesByConnection.get(connection) ?? -1;
  }

  /** The index of connection `connection`'s record in the descriptor's `connections` (and a reading's arrays), or −1. */
  recordOfConnection(connection: number): number {
    return this.recordsByConnection.get(connection) ?? -1;
  }

  /** The island of node `node`. */
  islandOfNode(node: number): number {
    return this.nodeIsland[node];
  }

  /** The island of branch `branch`. */
  islandOfBranch(branch: number): number {
    return this.branchIsland[branch];
  }

  /** Arrays for this descriptor's counts: allocate once per generation, then {@link read} into them. */
  createReading(): NetlistReading {
    const d = this.descriptor;
    const islands = d.islands.length;
    return {
      descriptor: d,
      islandStatus: new Uint8Array(islands),
      islandBand: new Uint8Array(islands),
      islandAc: new Uint8Array(islands),
      islandReferenced: new Uint8Array(islands),
      nodeVolts: new Float64Array(d.nodes.length),
      branchAmps: new Float64Array(d.branches.length),
      branchDirection: new Int8Array(d.branches.length),
      connectionStatus: new Uint8Array(d.connections.length),
      connectionValues: new Float64Array(d.connections.length * CONNECTION_VALUE_COUNT),
      tick: 0,
    };
  }

  /**
   * Reads `view` into `out`. Both must be of this readout's descriptor (a `RangeError` otherwise).
   * Allocation-free. Counts are the descriptor's; a snapshot with fewer entries (never in practice:
   * the counts are constant within a generation) leaves the rest unread as no reading.
   */
  read(view: SnapshotView, out: NetlistReading): void {
    if (view.descriptor !== this.descriptor || out.descriptor !== this.descriptor) {
      throw new RangeError('the snapshot, the reading and the readout must share one descriptor');
    }
    out.tick = view.tick;
    const islands = Math.min(view.islandCount, out.islandStatus.length);
    out.islandStatus.fill(READING_NONE);
    out.nodeVolts.fill(0);
    out.branchAmps.fill(0);
    out.branchDirection.fill(0);
    for (let i = 0; i < islands; i++) {
      const kind = view.islandKind(i);
      out.islandStatus[i] = STATUS_CODE[islandStatus(kind, view.islandFlags(i), view.islandIterations(i))];
      out.islandBand[i] = view.islandBand(i);
      out.islandAc[i] = kind === ISLAND_KIND_AC || kind === ISLAND_KIND_MIXED ? 1 : 0;
      out.islandReferenced[i] = view.islandReference(i) >= 0 ? 1 : 0;
    }
    const nodes = Math.min(view.nodeCount, out.nodeVolts.length);
    for (let n = 0; n < nodes; n++) {
      const island = this.nodeIsland[n];
      if (island >= islands || out.islandStatus[island] !== READING_SOLVED) continue;
      const ref = view.islandReference(island);
      if (ref < 0 || ref >= view.nodeCount) continue;
      const re = view.voltage(n, 0) - view.voltage(ref, 0);
      const im = view.voltage(n, 1) - view.voltage(ref, 1);
      out.nodeVolts[n] = Math.sqrt(re * re + im * im);
    }
    const branches = Math.min(view.branchCount, out.branchAmps.length);
    for (let b = 0; b < branches; b++) {
      const island = this.branchIsland[b];
      if (island >= islands || out.islandStatus[island] !== READING_SOLVED) continue;
      const re = view.current(b, 0);
      const im = view.current(b, 1);
      out.branchAmps[b] = Math.sqrt(re * re + im * im);
      out.branchDirection[b] = out.islandAc[island] === 1 || re === 0 ? 0 : re > 0 ? 1 : -1;
    }
    const values = out.connectionValues;
    const connections = out.connectionStatus.length;
    if (view.connectionCount !== connections) {
      // Never in practice (the counts are the descriptor's): no record is a reading.
      out.connectionStatus.fill(0);
      values.fill(0);
      return;
    }
    view.readConnectionValues(this.connectionPlan, values);
    for (let c = 0; c < connections; c++) out.connectionStatus[c] = values[c * CONNECTION_VALUE_COUNT + STATUS_INDEX];
  }
}
