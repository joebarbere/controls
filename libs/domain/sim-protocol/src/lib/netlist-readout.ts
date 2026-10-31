import type { TopologyDescriptor } from './descriptor';
import { islandStatus, type IslandStatus } from './island-status';
import { ISLAND_KIND_AC, ISLAND_KIND_MIXED } from './layout';
import type { SnapshotView } from './reader';

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
 * Built once per descriptor (cached by identity, like `DescriptorIndex`); {@link NetlistReadout.read}
 * allocates nothing, so a renderer may call it on every snapshot (`sim bench`'s `overlay-read` case
 * gates it at 0 B per read).
 */

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

  private constructor(readonly descriptor: TopologyDescriptor) {
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
  }
}
