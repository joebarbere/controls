import { elementKey } from './hash';
import type { Netlist, NetlistDiagnostic } from './types';

/*
 * `formatNetlist` (plan F2.1): a deterministic, line-oriented text of a netlist, for F2.6's
 * `netlist.dump` console command and for golden tests. The same netlist gives the same text in every
 * runtime: numbers are written with `String(n)`, which ECMAScript defines exactly (the shortest
 * round-tripping decimal), and every list is in the netlist's canonical order.
 *
 * ```text
 * netlist 3 nodes, 3 branches, 1 island
 * topology 4f0c…
 * island 0 dc nodes 0 1 2 branches 0 1 2
 * node 0 island 0: 1:neg 3:b
 * branch 0 e1.cell vsource battery dc 0 -> 1 island 0 internalResistanceOhm=0.023 nominalVoltageV=12
 * branch 1 c1 resistor lead 1 -> 2 island 0 resistanceOhm=0.04094…
 * diagnostic mixed-island island 2
 * ```
 */

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function formatDiagnostic(diagnostic: NetlistDiagnostic): string {
  switch (diagnostic.code) {
    case 'unknown-device':
      return `diagnostic unknown-device entity ${diagnostic.entity}`;
    case 'no-model':
      return `diagnostic no-model entity ${diagnostic.entity} kind ${diagnostic.kind}`;
    case 'absent-connection':
      return `diagnostic absent-connection connection ${diagnostic.connection} ${diagnostic.reason}`;
    case 'mixed-island':
      return `diagnostic mixed-island island ${diagnostic.island}`;
  }
}

/** The netlist as text, one item per line, ending with a newline. */
export function formatNetlist(netlist: Netlist): string {
  const lines = [
    `netlist ${count(netlist.nodes.length, 'node', 'nodes')}, ${count(netlist.branches.length, 'branch', 'branches')}, ${count(netlist.islands.length, 'island', 'islands')}`,
    `topology ${netlist.topologyHash}`,
  ];
  for (const island of netlist.islands) {
    lines.push(
      `island ${island.index} ${island.kind} nodes ${island.nodes.join(' ')} branches ${island.branches.join(' ')}`.trimEnd(),
    );
  }
  for (const node of netlist.nodes) {
    lines.push(
      `node ${node.index} island ${node.island}: ${node.members.map((m) => `${m.entity}:${m.terminal}`).join(' ')}`,
    );
  }
  for (const branch of netlist.branches) {
    const values = Object.keys(branch.values)
      .sort()
      .map((key) => ` ${key}=${String(branch.values[key])}`)
      .join('');
    const source = branch.source === null ? '' : ` ${branch.source}`;
    lines.push(
      `branch ${branch.index} ${elementKey(branch.element)} ${branch.kind} ${branch.model}${source} ${branch.a} -> ${branch.b} island ${branch.island}${values}`,
    );
  }
  for (const diagnostic of netlist.diagnostics) lines.push(formatDiagnostic(diagnostic));
  return `${lines.join('\n')}\n`;
}
