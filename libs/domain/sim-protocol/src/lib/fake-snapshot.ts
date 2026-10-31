import type { TopologyDescriptor } from './descriptor';
import { ISLAND_KINDS } from './layout';
import type { SnapshotView } from './reader';
import { snapshotViewFromBytes } from './reader';
import { encodeSnapshot, snapshotHashedBytes, snapshotSlotBytes, type SnapshotSource } from './snapshot';

/*
 * Snapshots from plain values, through the real codec (ADR 0011 §6.3: "the renderer and the UI
 * develop against fake snapshots that `encodeSnapshot` builds from fixtures"). For tests, the bench
 * and UI development: `encodeSnapshot` writes the slot exactly as the worker does, and
 * `snapshotViewFromBytes` reads it back with the transport's `SnapshotView`.
 */

/** One island's entry, by name. Defaults: solved once (`iterations` 1), no flags, band 0. */
export interface FakeIsland {
  readonly flags?: number;
  /** 0 means not solved (`unmodelled`). */
  readonly iterations?: number;
  /** −1 for none. Defaults to the island's first node. */
  readonly reference?: number;
  /** An index into `NOMINAL_BANDS`; the codec doesn't check it, so tests may name bands not yet in the table. */
  readonly band?: number;
}

/** The values a fake snapshot holds; counts and island kinds come from `descriptor`. */
export interface FakeSnapshot {
  readonly descriptor: TopologyDescriptor;
  readonly tick?: number;
  readonly lastSolveTick?: number;
  /** Per node `[re, im]` in V; missing nodes are 0. */
  readonly nodes?: readonly (readonly [number, number])[];
  /** Per branch `[re, im]` in A; missing branches are 0. */
  readonly branches?: readonly (readonly [number, number])[];
  /** Per island; missing islands take the defaults. */
  readonly islands?: readonly FakeIsland[];
  /** The device section's bytes (records at the descriptor's offsets), zero-filled to a multiple of 8. */
  readonly devices?: Uint8Array;
}

/** A `SnapshotView` of `fake`, encoded and decoded by the real codec. Allocates; never per frame. */
export function fakeSnapshotView(fake: FakeSnapshot): SnapshotView {
  const d = fake.descriptor;
  const pairs = (count: number, values: readonly (readonly [number, number])[] = []) => {
    const out = new Float64Array(2 * count);
    values.slice(0, count).forEach(([re, im], i) => {
      out[2 * i] = re;
      out[2 * i + 1] = im;
    });
    return out;
  };
  const islands = d.islands.map((island, i) => ({ island, entry: fake.islands?.[i] ?? {} }));
  const devices = fake.devices ?? new Uint8Array(0);
  const deviceDataBytes = (devices.byteLength + 7) & ~7;
  const source: SnapshotSource = {
    topologyGeneration: d.generation,
    tick: fake.tick ?? 1,
    lastSolveTick: fake.lastSolveTick ?? fake.tick ?? 1,
    topologyHash: d.topologyHash,
    nodeCount: d.nodes.length,
    branchCount: d.branches.length,
    nodes: pairs(d.nodes.length, fake.nodes),
    branches: pairs(d.branches.length, fake.branches),
    islandCount: islands.length,
    islandKinds: islands.map(({ island }) => ISLAND_KINDS.indexOf(island.kind)),
    islandFlags: islands.map(({ entry }) => entry.flags ?? 0),
    islandIterations: islands.map(({ entry }) => entry.iterations ?? 1),
    islandReferences: islands.map(({ island, entry }) => entry.reference ?? island.nodes[0] ?? -1),
    islandUnknowns: islands.map(({ island, entry }) => ((entry.iterations ?? 1) === 0 ? 0 : island.nodes.length)),
    islandBands: islands.map(({ entry }) => entry.band ?? 0),
    deviceCount: d.devices.length,
    deviceDataBytes,
    writeDevices(view, offset) {
      for (let i = 0; i < devices.byteLength; i++) view.setUint8(offset + i, devices[i]);
    },
  };
  const slot = new Uint8Array(snapshotSlotBytes(source));
  encodeSnapshot(source, slot);
  return snapshotViewFromBytes(snapshotHashedBytes(slot), d);
}
