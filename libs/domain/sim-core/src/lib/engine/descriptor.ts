import { type DeviceOutputSchema, SIM_PROTOCOL_VERSION, type TopologyDescriptor } from '@controls/sim-protocol';
import type { Netlist } from '../netlist/types';

/** One device record in the snapshot's device section, as the engine laid it out. */
export interface DescriptorRecord {
  readonly entity: number;
  /** The byte offset of its record within the device section. */
  readonly offset: number;
  readonly output: DeviceOutputSchema;
}

/**
 * The topology descriptor of `netlist` (ADR 0011 §7): what a snapshot of this generation's indices
 * mean. Nodes, branches and islands in F2.1's order, each node's members sorted (as the compiler
 * keeps them); devices are the records the engine writes, entity ascending, with the output schema
 * of every kind they use. Plain JSON-compatible data, deep-frozen.
 */
export function buildTopologyDescriptor(
  netlist: Netlist,
  generation: number,
  records: readonly DescriptorRecord[],
): TopologyDescriptor {
  const schemas: Record<string, DeviceOutputSchema> = {};
  for (const record of records) schemas[record.output.kind] = record.output;
  const descriptor: TopologyDescriptor = {
    protocol: SIM_PROTOCOL_VERSION,
    generation,
    topologyHash: netlist.topologyHash,
    nodes: netlist.nodes.map((node) => ({
      island: node.island,
      members: node.members.map((m) => ({ entity: m.entity, terminal: m.terminal })),
    })),
    branches: netlist.branches.map((branch) => ({
      element:
        branch.element.kind === 'entity'
          ? { kind: 'entity', entity: branch.element.entity, part: branch.element.part }
          : { kind: 'connection', connection: branch.element.connection },
      a: branch.a,
      b: branch.b,
      island: branch.island,
    })),
    islands: netlist.islands.map((island) => ({ kind: island.kind, nodes: [...island.nodes] })),
    devices: records.map((record) => ({
      entity: record.entity,
      kind: record.output.kind,
      recordOffset: record.offset,
    })),
    schemas,
  };
  return deepFreeze(descriptor);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
