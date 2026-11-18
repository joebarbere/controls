import type { Catalog } from '@controls/catalog';
import type { World } from '@controls/save-format';
import { NetlistCompiler } from './compile';
import { BUILTIN_NETLIST_MODELS, type NetlistModels, ownModel } from './models';
import type { Netlist, TerminalRef } from './types';
import { UnionFind } from './union-find';

/*
 * `wiringGraph` (engine 8, D13, ADR 0019 "What the netlist compiler reads"): what is connected to what
 * as wired, for the inspector (P4 PR 20), by **the compiler's own joins and contact rules**, so the
 * inspector and the simulator never disagree about connectivity. It compiles the world's wiring view
 * (`NetlistCompilerOptions.view: 'wiring'`): every switching device closed (a model's `wiring`
 * topology), every protective device intact whatever its handle or trip, every landed connection present
 * whatever its ends' sim state, every mount, plug and earth contact as the electrical netlist has them.
 * Then two terminals are **joined** when they are in one node, or in nodes linked by connections,
 * contacts and the elements of kinds marked `wiringPath` (a breaker's or fuse's line → load), never
 * through a load's or a source's element.
 *
 * Derived, never stored or hashed (ADR 0019 "Hash scope"); not on any per-tick path. The property that
 * ties it to `compileNetlist` (every pair of terminals in one electrical node, with switches closed,
 * is joined here) is in `wiring-graph.spec.ts`.
 */

/** The wiring view of a world (see the file comment). */
export interface WiringGraph {
  /** The wiring view's netlist: the compiler's nodes, branches and islands with switches closed. */
  readonly netlist: Netlist;
  /** The node terminal `ref` is in, or −1 when it isn't netlisted. */
  nodeOf(ref: TerminalRef): number;
  /** The wiring component of node `node`: its smallest node joined by wiring. */
  component(node: number): number;
  /** Whether two terminals are joined by wiring (one node, or nodes linked by conductors, contacts and protective paths). */
  joined(a: TerminalRef, b: TerminalRef): boolean;
}

export interface WiringGraphOptions {
  /** The netlist models (default the built-in ones); tests pass synthetic kinds. */
  readonly models?: NetlistModels;
}

/** The wiring graph of `world` (see the file comment). Pure: the same world and catalogue give the same graph. */
export function wiringGraph(world: World, catalog: Catalog, options: WiringGraphOptions = {}): WiringGraph {
  const models = options.models ?? BUILTIN_NETLIST_MODELS;
  const netlist = new NetlistCompiler(catalog, { models, view: 'wiring' }).compile(world);
  const nodeIndex = new Map<string, number>();
  for (const node of netlist.nodes) {
    for (const member of node.members) nodeIndex.set(`${member.entity}:${member.terminal}`, node.index);
  }
  const sets = new UnionFind(netlist.nodes.length);
  for (const branch of netlist.branches) {
    const element = branch.element;
    const path = element.kind !== 'entity' || ownModel(models.devices, branch.model)?.wiringPath === true;
    if (path && branch.a !== branch.b) sets.union(branch.a, branch.b);
  }
  // Each component by its smallest node (union-find roots are arbitrary).
  const smallest = new Int32Array(netlist.nodes.length).fill(-1);
  for (let node = 0; node < netlist.nodes.length; node++) {
    const root = sets.find(node);
    if (smallest[root] < 0) smallest[root] = node;
  }
  const component = (node: number): number => smallest[sets.find(node)];
  const nodeOf = (ref: TerminalRef): number => nodeIndex.get(`${ref.entity}:${ref.terminal}`) ?? -1;
  return {
    netlist,
    nodeOf,
    component,
    joined: (a, b) => {
      const na = nodeOf(a);
      const nb = nodeOf(b);
      return na >= 0 && nb >= 0 && component(na) === component(nb);
    },
  };
}
