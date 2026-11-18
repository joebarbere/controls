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
 * mount and plug contacts, the elements of kinds marked `wiringPath` (a breaker's or fuse's line →
 * load) and the parts a model lists in `wiringPathParts` (the service's drop neutral), never through a
 * load's or a source's element, and **never through soil**: an `earth` contact joins nothing, so two
 * ground rods with no conductor between them are not joined (a missing GEC or bonding jumper stays
 * visible to the inspector). Whether a terminal reaches an electrode by wiring is `earthed`.
 *
 * Derived, never stored or hashed (ADR 0019 "Hash scope"); not on any per-tick path. The properties
 * that tie it to `compileNetlist` (every pair of terminals in one electrical node, with switches
 * closed, is joined here; unconnected rods are not) are in `contacts-properties.spec.ts`.
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
  /** Whether a terminal's wiring component holds an earth link (a rod's clamp, the service's x0): it reaches an electrode by wiring. */
  earthed(ref: TerminalRef): boolean;
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
    let path: boolean;
    if (element.kind === 'connection') path = true;
    else if (element.kind === 'contact') path = element.relation !== 'earth';
    else {
      const model = ownModel(models.devices, branch.model);
      path = model?.wiringPath === true || model?.wiringPathParts?.includes(element.part) === true;
    }
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
  // The components that hold an earth link's device end (a rod's clamp, the service's x0).
  const grounded = new Set<number>();
  for (const branch of netlist.branches) {
    if (branch.element.kind === 'contact' && branch.element.relation === 'earth') grounded.add(component(branch.a));
  }
  return {
    netlist,
    nodeOf,
    component,
    joined: (a, b) => {
      const na = nodeOf(a);
      const nb = nodeOf(b);
      return na >= 0 && nb >= 0 && component(na) === component(nb);
    },
    earthed: (ref) => {
      const node = nodeOf(ref);
      return node >= 0 && grounded.has(component(node));
    },
  };
}
