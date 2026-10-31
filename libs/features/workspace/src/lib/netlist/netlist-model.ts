import {
  type DescriptorElementRef,
  type DescriptorTerminalRef,
  NetlistReadout,
  type NetlistReading,
  NOMINAL_BANDS,
  READING_SOLVED,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';

/*
 * The netlist inspector's model (plan F2.6), framework-free so it is unit-tested without Angular:
 *
 * - the **tree**: islands, then each island's nodes (with their member terminals) and branches, from
 *   the snapshot's topology descriptor (ADR 0011 §7), named as `netlist.dump` (`formatNetlist`) names
 *   them: node and branch indices, `entity:terminal` members, `e<entity>.<part>` and `c<connection>`
 *   elements, `a -> b` ends;
 * - the **values**: one display string per island, node and branch, read through `NetlistReadout`
 *   (the overlays' readout, so both agree on what is a reading). An island that isn't `solved`, and a
 *   node of an island with no reference, read "no reading", never 0 V or 0 A.
 */

/** What a value cell shows when there is no reading (the validity rule, ADR 0011 §5.3). */
export const NO_READING = 'no reading';

const STATUS_TEXT: readonly string[] = ['no reading yet', 'solved', 'singular', 'not converged', 'unmodelled', 'mixed'];

const PREFIXES = [
  { exp: 6, prefix: 'M' },
  { exp: 3, prefix: 'k' },
  { exp: 0, prefix: '' },
  { exp: -3, prefix: 'm' },
  { exp: -6, prefix: 'µ' },
  { exp: -9, prefix: 'n' },
  { exp: -12, prefix: 'p' },
] as const;

/**
 * `value` (≥ 0, finite) in `unit` to three significant figures with an SI prefix: `12.8 V`, `391 mA`,
 * `0 A`. Below a picounit it is written in exponent form (`3.20e-14 A`), so a tiny solved leakage
 * never reads as zero.
 */
export function formatQuantity(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`;
  // Largest prefix first; rounding first, so 999.96 mA reads 1.00 A, not 1.00e+3 mA.
  for (const { exp, prefix } of PREFIXES) {
    const scaled = Number((value / 10 ** exp).toPrecision(3));
    if (scaled >= 1)
      return scaled < 1000 ? `${scaled.toPrecision(3)} ${prefix}${unit}` : `${value.toExponential(2)} ${unit}`;
  }
  return `${value.toExponential(2)} ${unit}`;
}

/** A descriptor element as `netlist.dump` writes it: `e3.filament`, `c2`. */
export function elementKey(element: DescriptorElementRef): string {
  return element.kind === 'entity' ? `e${element.entity}.${element.part}` : `c${element.connection}`;
}

/** A terminal as `netlist.dump` writes it: `3:a`. */
export const terminalKey = (t: DescriptorTerminalRef): string => `${t.entity}:${t.terminal}`;

/** The display name of a nominal band index (`none`, `dc12`, …), or `band <n>` past the table. */
export const bandName = (band: number): string => NOMINAL_BANDS[band] ?? `band ${band}`;

/** The display text of a `READING_STATUSES` code. */
export const statusText = (code: number): string => STATUS_TEXT[code] ?? STATUS_TEXT[0];

export type NetlistItemKind = 'island' | 'nodes' | 'branches' | 'node' | 'branch';

/** One row of the inspector's tree, flattened in display order (`aria-level` carries the hierarchy). */
export interface NetlistTreeItem {
  /** Stable across generations while the item's identity (its first member, its element) is. */
  readonly key: string;
  readonly kind: NetlistItemKind;
  /** 1 island, 2 its Nodes and Branches groups, 3 a node or branch. */
  readonly level: 1 | 2 | 3;
  /** The parent's key, or `null` for an island. */
  readonly parent: string | null;
  /** The island, node or branch index (the island's for a group). */
  readonly index: number;
  /** The static part of the row's text. */
  readonly label: string;
  /** A node's member terminals (empty for every other kind). */
  readonly members: readonly DescriptorTerminalRef[];
  readonly setSize: number;
  readonly posInSet: number;
  readonly expandable: boolean;
}

/** The tree of one descriptor, in display order: island, Nodes, its nodes, Branches, its branches. */
export function buildNetlistTree(descriptor: TopologyDescriptor): readonly NetlistTreeItem[] {
  const items: NetlistTreeItem[] = [];
  const nodesOf = descriptor.islands.map(() => [] as number[]);
  const branchesOf = descriptor.islands.map(() => [] as number[]);
  descriptor.nodes.forEach((n, i) => nodesOf[n.island]?.push(i));
  descriptor.branches.forEach((b, i) => branchesOf[b.island]?.push(i));
  const nodeKey = (n: number) => `n:${terminalKey(descriptor.nodes[n].members[0])}`;
  descriptor.islands.forEach((island, i) => {
    const nodes = nodesOf[i];
    const branches = branchesOf[i];
    const key = nodes.length > 0 ? `i:${nodeKey(nodes[0])}` : `i:#${i}`;
    items.push({
      key,
      kind: 'island',
      level: 1,
      parent: null,
      index: i,
      label: `Island ${i} · ${island.kind.toUpperCase()}`,
      members: [],
      setSize: descriptor.islands.length,
      posInSet: i + 1,
      expandable: nodes.length + branches.length > 0,
    });
    const groups = (nodes.length > 0 ? 1 : 0) + (branches.length > 0 ? 1 : 0);
    if (nodes.length > 0) {
      const group = `${key}/nodes`;
      items.push({
        key: group,
        kind: 'nodes',
        level: 2,
        parent: key,
        index: i,
        label: `Nodes (${nodes.length})`,
        members: [],
        setSize: groups,
        posInSet: 1,
        expandable: true,
      });
      nodes.forEach((n, j) => {
        const members = descriptor.nodes[n].members;
        items.push({
          key: nodeKey(n),
          kind: 'node',
          level: 3,
          parent: group,
          index: n,
          label: `Node ${n}: ${members.map(terminalKey).join(' ')}`,
          members,
          setSize: nodes.length,
          posInSet: j + 1,
          expandable: false,
        });
      });
    }
    if (branches.length > 0) {
      const group = `${key}/branches`;
      items.push({
        key: group,
        kind: 'branches',
        level: 2,
        parent: key,
        index: i,
        label: `Branches (${branches.length})`,
        members: [],
        setSize: groups,
        posInSet: groups,
        expandable: true,
      });
      branches.forEach((b, j) => {
        const branch = descriptor.branches[b];
        items.push({
          key: `b:${elementKey(branch.element)}`,
          kind: 'branch',
          level: 3,
          parent: group,
          index: b,
          label: `Branch ${b} ${elementKey(branch.element)}: ${branch.a} -> ${branch.b}`,
          members: [],
          setSize: branches.length,
          posInSet: j + 1,
          expandable: false,
        });
      });
    }
  });
  return items;
}

/** One sample's display strings, by island, node and branch index of `descriptor`. */
export interface NetlistValues {
  readonly descriptor: TopologyDescriptor;
  readonly tick: number;
  /** `solved · band none`, `singular · band dc12`, … */
  readonly islands: readonly string[];
  /** `12.8 V` or {@link NO_READING}. */
  readonly nodes: readonly string[];
  /** `391 mA, a -> b` (DC direction against the branch's ends), `2.00 A` (AC) or {@link NO_READING}. */
  readonly branches: readonly string[];
}

/** The display strings of a reading (allocates: call it at the panel rate, never per snapshot). */
export function netlistValues(reading: NetlistReading): NetlistValues {
  const { descriptor } = reading;
  const solved = (island: number) => reading.islandStatus[island] === READING_SOLVED;
  return {
    descriptor,
    tick: reading.tick,
    islands: descriptor.islands.map(
      (_, i) => `${statusText(reading.islandStatus[i])} · band ${bandName(reading.islandBand[i])}`,
    ),
    nodes: descriptor.nodes.map((n, i) =>
      solved(n.island) && reading.islandReferenced[n.island] === 1
        ? formatQuantity(reading.nodeVolts[i], 'V')
        : NO_READING,
    ),
    branches: descriptor.branches.map((b, i) => {
      if (!solved(b.island)) return NO_READING;
      const amps = formatQuantity(reading.branchAmps[i], 'A');
      const direction = reading.branchDirection[i];
      return direction === 0 ? amps : `${amps}, ${direction > 0 ? 'a -> b' : 'b -> a'}`;
    }),
  };
}

/** Whether two samples show the same text (so the panel isn't redrawn for an unchanged sample). */
export function sameNetlistValues(a: NetlistValues | null, b: NetlistValues | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.descriptor !== b.descriptor || a.tick !== b.tick) return false;
  return same(a.islands, b.islands) && same(a.nodes, b.nodes) && same(a.branches, b.branches);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A `SimHost.select` selector: reads `view` through the descriptor's `NetlistReadout` (resolved once
 * per descriptor, the reading's arrays allocated once per generation) and formats it.
 */
export function netlistSampler(): (view: SnapshotView) => NetlistValues {
  let reading: NetlistReading | null = null;
  return (view) => {
    const readout = NetlistReadout.of(view.descriptor);
    if (reading?.descriptor !== view.descriptor) reading = readout.createReading();
    readout.read(view, reading);
    return netlistValues(reading);
  };
}
