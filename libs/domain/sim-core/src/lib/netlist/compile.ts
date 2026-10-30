import type { Catalog } from '@controls/catalog';
import { isBuiltinPropRef, type World } from '@controls/save-format';
import { computeTopologyHash } from './hash';
import {
  BUILTIN_NETLIST_MODELS,
  type DeviceNetlistModel,
  type ElementSpec,
  type NetlistModels,
  ownModel,
} from './models';
import type {
  AbsentConnectionReason,
  ElementKind,
  IslandKind,
  Netlist,
  NetlistBranch,
  NetlistDevice,
  NetlistDiagnostic,
  NetlistIsland,
  NetlistNode,
  SourceDomain,
  StateBag,
  TerminalRef,
} from './types';
import { UnionFind } from './union-find';

/*
 * The netlist compiler (plan F2.1). It turns the as-built world (entities, catalogue terminals,
 * `connections` and commanded device state, plus the engine's sim-owned topology state) into nodes,
 * branches and islands. **Wired, not drawn:** positions, orientations, the renderer and prints never
 * enter it; only connections and ideal joins inside devices connect terminals.
 *
 * 1. Each netlisted entity contributes a fragment: its sorted terminals, the groups of them it joins
 *    ideally and its elements (`DeviceNetlistModel.topology`). Props, unknown refs and kinds without a
 *    model are absent (ADR 0013).
 * 2. Union-find merges the ideal joins only. Terminals are visited in canonical order (entity id, then
 *    terminal id), so numbering each node when its first member is visited numbers nodes by their
 *    smallest member, whatever the union order.
 * 3. Branches: entity elements (entity id, then part), then each netlisted connection by id, exactly
 *    one branch each (ADR 0011 §7). A connection with an end on an absent entity is absent itself.
 * 4. Islands: connected components over the branches, numbered by their smallest node, classified by
 *    the sources they hold.
 *
 * `NetlistCompiler` keeps fragments between compiles and takes two shortcuts, both proven against a
 * from-scratch compile by property tests: when the structure is unchanged it returns the previous
 * netlist (or rebuilds only the branch values), and unchanged entities and connections reuse their
 * fragments. A structural change renumbers everything, because the canonical order is global.
 */

/** Part names: lower camelCase, so the topology text stays unambiguous. */
const PART_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

export interface CompileOptions {
  /**
   * The engine's sim-owned state of an entity (ADR 0011 §1). Only the keys a model lists in
   * `simTopologyKeys` are read (a blown fuse, a tripped breaker). When it returns `undefined`, or is
   * left out, the world's own `sim` bag is used, which is right at a session's start or a load, when
   * the bags hold what was materialised; during play the engine must pass its live state.
   */
  readonly sim?: (entity: number) => StateBag | undefined;
}

export interface NetlistCompilerOptions {
  /** The netlist models (default {@link BUILTIN_NETLIST_MODELS}); tests pass synthetic kinds. */
  readonly models?: NetlistModels;
}

/** How each {@link NetlistCompiler.compile} call was answered. For tests and diagnostics only. */
export interface NetlistCompilerStats {
  /** The structure changed (or there was no previous netlist): renumbered and rehashed. */
  structural: number;
  /** Same structure, new values: the branches were rebuilt, nothing else. */
  valuesOnly: number;
  /** Nothing the netlist holds changed: the previous netlist was returned as is. */
  unchanged: number;
}

interface ElementFragment {
  readonly part: string;
  readonly kind: ElementKind;
  readonly source: SourceDomain | null;
  /** Indices into the fragment's `terminals`. */
  readonly a: number;
  readonly b: number;
  readonly values: Readonly<Record<string, number>>;
}

interface DeviceFragment {
  readonly kind: string;
  /** Terminal ids, sorted by code units. */
  readonly terminals: readonly string[];
  /** Ideal joins, as indices into `terminals`. */
  readonly joins: readonly (readonly number[])[];
  /** Sorted by part. */
  readonly elements: readonly ElementFragment[];
}

type EntityResult =
  | { readonly netlisted: true; readonly fragment: DeviceFragment }
  | { readonly netlisted: false; readonly diagnostic: NetlistDiagnostic | null };

interface EntityCacheEntry {
  readonly refId: string;
  readonly refVersion: number;
  readonly state: StateBag;
  readonly model: DeviceNetlistModel | undefined;
  readonly simKey: string;
  readonly result: EntityResult;
  /** The entity's contribution to the topology, without values: equal keys, equal contribution. */
  readonly structureKey: string;
  /** The compile that last saw this entity (stale entries are pruned). */
  epoch: number;
}

type ConnectionResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly kind: ElementKind;
      readonly values: Readonly<Record<string, number>>;
      /** `kind model`, for the change check. */
      readonly structureKey: string;
    }
  | { readonly ok: false; readonly reason: AbsentConnectionReason };

interface ConnectionCacheEntry {
  readonly connection: Connection;
  readonly result: ConnectionResult;
  epoch: number;
}

type Entity = World['entities'][number];
type Connection = World['connections'][number];

/** A netlisted entity and where its terminals start in the plant-wide terminal numbering. */
interface PlacedDevice {
  readonly entity: number;
  readonly fragment: DeviceFragment;
  readonly base: number;
}

/** A netlisted connection, its ends as plant-wide terminal indices. */
interface PlacedConnection {
  readonly id: number;
  readonly result: Extract<ConnectionResult, { ok: true }>;
  readonly a: number;
  readonly b: number;
}

/**
 * What the netlist's structure is a function of, as flat arrays compared element by element: per
 * entity its id and structure key; per connection its id, its plant-wide ends and its structure key
 * (or why it is absent). Equal structures give equal nodes, islands, devices, diagnostics and hash.
 */
interface Structure {
  readonly entityIds: number[];
  readonly entityKeys: string[];
  readonly connectionNumbers: number[];
  readonly connectionKeys: string[];
}

const ABSENT_KEYS: Readonly<Record<AbsentConnectionReason, string>> = {
  'unknown-ref': 'absent unknown-ref',
  'not-a-connection': 'absent not-a-connection',
  'no-model': 'absent no-model',
  'absent-end': 'absent absent-end',
  'unknown-terminal': 'absent unknown-terminal',
};

const sameArray = <T>(x: readonly T[], y: readonly T[]): boolean => {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

const sameStructure = (x: Structure, y: Structure): boolean =>
  sameArray(x.entityIds, y.entityIds) &&
  sameArray(x.entityKeys, y.entityKeys) &&
  sameArray(x.connectionNumbers, y.connectionNumbers) &&
  sameArray(x.connectionKeys, y.connectionKeys);

const byId = <T extends { readonly id: number }>(items: readonly T[]): readonly T[] => {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1].id > items[i].id) return [...items].sort((x, y) => x.id - y.id);
  }
  return items;
};

/** A netlist compiler bound to one catalogue, keeping fragments between compiles (incremental recompile). */
export class NetlistCompiler {
  private readonly models: NetlistModels;
  private readonly entityCache = new Map<number, EntityCacheEntry>();
  private readonly connectionCache = new Map<number, ConnectionCacheEntry>();
  private epoch = 0;
  private previous: { readonly structure: Structure; readonly netlist: Netlist } | null = null;
  readonly stats: NetlistCompilerStats = { structural: 0, valuesOnly: 0, unchanged: 0 };

  constructor(
    private readonly catalog: Catalog,
    options: NetlistCompilerOptions = {},
  ) {
    this.models = options.models ?? BUILTIN_NETLIST_MODELS;
  }

  /**
   * Compiles `world`, reusing what an earlier compile already derived. The result equals
   * `compileNetlist(world, catalog, options)` exactly, whatever was compiled before.
   */
  compile(world: World, options: CompileOptions = {}): Netlist {
    const epoch = ++this.epoch;
    const structure: Structure = { entityIds: [], entityKeys: [], connectionNumbers: [], connectionKeys: [] };
    const entityDiagnostics: NetlistDiagnostic[] = [];
    const connectionDiagnostics: NetlistDiagnostic[] = [];

    // 1. Fragments, in entity id order. Terminal i of a device is plant terminal `base + i`.
    const devices: PlacedDevice[] = [];
    const deviceOf = new Map<number, PlacedDevice>();
    let terminalCount = 0;
    const entities = byId(world.entities);
    for (const entity of entities) {
      const entry = this.entityEntry(entity, options, epoch);
      structure.entityIds.push(entity.id);
      structure.entityKeys.push(entry.structureKey);
      if (entry.result.netlisted) {
        const placed = { entity: entity.id, fragment: entry.result.fragment, base: terminalCount };
        devices.push(placed);
        deviceOf.set(entity.id, placed);
        terminalCount += entry.result.fragment.terminals.length;
      } else if (entry.result.diagnostic) {
        entityDiagnostics.push(entry.result.diagnostic);
      }
    }

    // 2. Connections, resolved against the netlisted entities.
    const connections: PlacedConnection[] = [];
    const sortedConnections = byId(world.connections);
    for (const connection of sortedConnections) {
      const result = this.connectionEntry(connection, epoch).result;
      let reason: AbsentConnectionReason | null = null;
      let a = -1;
      let b = -1;
      if (!result.ok) {
        reason = result.reason;
      } else {
        a = terminalIndex(deviceOf, connection.a);
        b = terminalIndex(deviceOf, connection.b);
        if (a === ABSENT_END || b === ABSENT_END) reason = 'absent-end';
        else if (a < 0 || b < 0) reason = 'unknown-terminal';
      }
      structure.connectionNumbers.push(connection.id, a, b);
      if (reason !== null || !result.ok) {
        const absentReason = reason as AbsentConnectionReason;
        structure.connectionKeys.push(ABSENT_KEYS[absentReason]);
        connectionDiagnostics.push({ code: 'absent-connection', connection: connection.id, reason: absentReason });
      } else {
        structure.connectionKeys.push(result.structureKey);
        connections.push({ id: connection.id, result, a, b });
      }
    }
    prune(this.entityCache, entities.length, epoch);
    prune(this.connectionCache, sortedConnections.length, epoch);

    // Same structure as last time: the partition, islands, devices, hash and diagnostics are unchanged.
    const previous = this.previous;
    if (previous !== null && sameStructure(previous.structure, structure)) {
      const netlist = withValues(previous.netlist, devices, connections);
      if (netlist === previous.netlist) this.stats.unchanged++;
      else this.stats.valuesOnly++;
      this.previous = { structure, netlist };
      return netlist;
    }

    this.stats.structural++;
    const netlist = assemble(devices, terminalCount, connections, [...entityDiagnostics, ...connectionDiagnostics]);
    this.previous = { structure, netlist };
    return netlist;
  }

  private entityEntry(entity: Entity, options: CompileOptions, epoch: number): EntityCacheEntry {
    const cached = this.entityCache.get(entity.id);
    if (
      cached !== undefined &&
      cached.refId === entity.ref.id &&
      cached.refVersion === entity.ref.version &&
      cached.state === entity.state
    ) {
      // A model with sim topology keys is recompiled when the engine's values of them change.
      const model = cached.model;
      if (
        model === undefined ||
        model.simTopologyKeys.length === 0 ||
        simKeyOf(model, simTopologyView(model, options.sim?.(entity.id) ?? entity.sim)) === cached.simKey
      ) {
        cached.epoch = epoch;
        return cached;
      }
    }
    const entry = this.buildEntityEntry(entity, options, epoch);
    this.entityCache.set(entity.id, entry);
    return entry;
  }

  private buildEntityEntry(entity: Entity, options: CompileOptions, epoch: number): EntityCacheEntry {
    const base = { refId: entity.ref.id, refVersion: entity.ref.version, state: entity.state, epoch };
    const absent = (diagnostic: NetlistDiagnostic | null): EntityCacheEntry => ({
      ...base,
      model: undefined,
      simKey: '',
      result: { netlisted: false, diagnostic },
      structureKey: diagnostic === null ? 'prop' : JSON.stringify(diagnostic),
    });
    if (isBuiltinPropRef(entity.ref)) return absent(null);
    const kind = this.catalog.kindOf(entity.ref);
    if (!kind) return absent({ code: 'unknown-device', entity: entity.id });
    const model = ownModel(this.models.devices, kind.kind);
    if (!model || kind.placement !== 'entity') return absent({ code: 'no-model', entity: entity.id, kind: kind.kind });
    // The catalogue resolves every ref its `kindOf` resolves.
    const device = this.catalog.device(entity.ref) as NonNullable<ReturnType<Catalog['device']>>;
    const sim = simTopologyView(model, options.sim?.(entity.id) ?? entity.sim);
    const terminals = device.terminals.map((t) => t.id).sort();
    const fragment = buildFragment(model, terminals, device.model.params, entity.state, sim);
    return {
      ...base,
      model,
      simKey: simKeyOf(model, sim),
      result: { netlisted: true, fragment },
      structureKey: fragmentKey(fragment),
    };
  }

  private connectionEntry(connection: Connection, epoch: number): ConnectionCacheEntry {
    const cached = this.connectionCache.get(connection.id);
    if (cached !== undefined && cached.connection === connection) {
      cached.epoch = epoch;
      return cached;
    }
    const kind = this.catalog.kindOf(connection.ref);
    const model = kind ? ownModel(this.models.connections, kind.kind) : undefined;
    let result: ConnectionResult;
    if (!kind) result = { ok: false, reason: 'unknown-ref' };
    else if (kind.placement !== 'connection') result = { ok: false, reason: 'not-a-connection' };
    else if (!model) result = { ok: false, reason: 'no-model' };
    else {
      const device = this.catalog.device(connection.ref) as NonNullable<ReturnType<Catalog['device']>>;
      const element = model.element(device.model.params);
      result = {
        ok: true,
        model: kind.kind,
        kind: element.kind,
        values: sortedValues(element.values),
        structureKey: `${element.kind} ${kind.kind}`,
      };
    }
    const entry = { connection, result, epoch };
    this.connectionCache.set(connection.id, entry);
    return entry;
  }
}

/**
 * Compiles the as-built `world` into its netlist (plan F2.1). Pure: the same world, catalogue and sim
 * state give a deeply equal netlist, whatever the order of `world.entities` and `world.connections`.
 */
export function compileNetlist(
  world: World,
  catalog: Catalog,
  options: CompileOptions & NetlistCompilerOptions = {},
): Netlist {
  return new NetlistCompiler(catalog, options).compile(world, options);
}

/** Whether a netlist has nothing to solve: such a world exports `sim: null` (ADR 0013). */
export function isEmptyNetlist(netlist: Netlist): boolean {
  return netlist.nodes.length === 0;
}

/** Drops cache entries the compile at `epoch` didn't see (deleted entities and connections). */
function prune<T extends { epoch: number }>(cache: Map<number, T>, seen: number, epoch: number): void {
  if (cache.size <= seen) return;
  for (const [id, entry] of cache) if (entry.epoch !== epoch) cache.delete(id);
}

/** An end on an entity that isn't netlisted. Unknown terminals are -1. */
const ABSENT_END = -2;

function terminalIndex(deviceOf: ReadonlyMap<number, PlacedDevice>, end: TerminalRef): number {
  const device = deviceOf.get(end.entity);
  if (!device) return ABSENT_END;
  const index = device.fragment.terminals.indexOf(end.terminal);
  return index < 0 ? -1 : device.base + index;
}

const NO_SIM: StateBag = Object.freeze({});

/** The keys of `sim` that `model` lists in `simTopologyKeys`, in that order; a missing key is `null`. */
function simTopologyView(model: DeviceNetlistModel, sim: StateBag): StateBag {
  if (model.simTopologyKeys.length === 0) return NO_SIM;
  const view: Record<string, StateBag[string]> = {};
  for (const key of model.simTopologyKeys) view[key] = Object.prototype.hasOwnProperty.call(sim, key) ? sim[key] : null;
  return view;
}

const simKeyOf = (model: DeviceNetlistModel, view: StateBag): string =>
  model.simTopologyKeys.length === 0 ? '' : JSON.stringify(view);

function sortedValues(values: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(values).sort()) sorted[key] = values[key];
  return sorted;
}

function buildFragment(
  model: DeviceNetlistModel,
  terminals: readonly string[],
  params: Readonly<Record<string, number>>,
  state: StateBag,
  sim: StateBag,
): DeviceFragment {
  const topology = model.topology({ params, state, sim });
  const index = (terminal: string): number => {
    const i = terminals.indexOf(terminal);
    if (i < 0) throw new Error(`Netlist model ${model.kind} names terminal "${terminal}", which the device lacks`);
    return i;
  };
  const joins = topology.joins.map((group) => group.map(index));
  const elements = [...topology.elements]
    .sort((x, y) => (x.part < y.part ? -1 : x.part > y.part ? 1 : 0))
    .map((element: ElementSpec, i, sorted): ElementFragment => {
      if (!PART_PATTERN.test(element.part) || (i > 0 && sorted[i - 1].part === element.part)) {
        throw new Error(`Netlist model ${model.kind} has an invalid or repeated part "${element.part}"`);
      }
      return {
        part: element.part,
        kind: element.kind,
        source: element.source,
        a: index(element.a),
        b: index(element.b),
        values: sortedValues(element.values),
      };
    });
  return { kind: model.kind, terminals, joins, elements };
}

/** A fragment's structure without its values. */
function fragmentKey(fragment: DeviceFragment): string {
  return [
    fragment.kind,
    fragment.terminals.join(','),
    fragment.joins.map((group) => group.join(',')).join(';'),
    fragment.elements.map((e) => `${e.part}:${e.kind}:${e.source ?? '-'}:${e.a}:${e.b}`).join(';'),
  ].join('|');
}

/**
 * The previous netlist with this compile's branch values, or the previous netlist itself when no value
 * changed. Called only when the structure is unchanged, so branch `i` is the same element in both.
 */
function withValues(
  previous: Netlist,
  devices: readonly PlacedDevice[],
  connections: readonly PlacedConnection[],
): Netlist {
  let branches: NetlistBranch[] | null = null;
  let i = 0;
  const visit = (values: Readonly<Record<string, number>>) => {
    const old = previous.branches[i];
    if (old.values !== values && !sameValues(old.values, values)) {
      branches ??= previous.branches.slice();
      branches[i] = { ...old, values };
    }
    i++;
  };
  for (const { fragment } of devices) for (const element of fragment.elements) visit(element.values);
  for (const connection of connections) visit(connection.result.values);
  return branches === null ? previous : { ...previous, branches };
}

function sameValues(x: Readonly<Record<string, number>>, y: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(y, key) && Object.is(x[key], y[key]));
}

function assemble(
  devices: readonly PlacedDevice[],
  terminalCount: number,
  connections: readonly PlacedConnection[],
  diagnostics: NetlistDiagnostic[],
): Netlist {
  // Partition: ideal joins only.
  const terminals = new UnionFind(terminalCount);
  for (const { fragment, base } of devices) {
    for (const group of fragment.joins) {
      for (let i = 1; i < group.length; i++) terminals.union(base + group[0], base + group[i]);
    }
  }
  // Nodes, numbered as their smallest member is reached in canonical terminal order.
  const nodeOfRoot = new Int32Array(terminalCount).fill(-1);
  const nodeOfTerminal = new Int32Array(terminalCount);
  const members: TerminalRef[][] = [];
  for (const { entity, fragment, base } of devices) {
    for (let i = 0; i < fragment.terminals.length; i++) {
      const root = terminals.find(base + i);
      if (nodeOfRoot[root] < 0) {
        nodeOfRoot[root] = members.length;
        members.push([]);
      }
      nodeOfTerminal[base + i] = nodeOfRoot[root];
      members[nodeOfRoot[root]].push({ entity, terminal: fragment.terminals[i] });
    }
  }
  const nodeCount = members.length;

  // Branch ends as nodes, in canonical branch order: entity elements, then connections.
  const branchCount = connections.length + devices.reduce((n, d) => n + d.fragment.elements.length, 0);
  const endA = new Int32Array(branchCount);
  const endB = new Int32Array(branchCount);
  let index = 0;
  for (const { fragment, base } of devices) {
    for (const element of fragment.elements) {
      endA[index] = nodeOfTerminal[base + element.a];
      endB[index++] = nodeOfTerminal[base + element.b];
    }
  }
  for (const connection of connections) {
    endA[index] = nodeOfTerminal[connection.a];
    endB[index++] = nodeOfTerminal[connection.b];
  }

  // Islands: connected components of the nodes over the branches, numbered by their smallest node.
  const nodeSets = new UnionFind(nodeCount);
  for (let i = 0; i < branchCount; i++) nodeSets.union(endA[i], endB[i]);
  const islandOfRoot = new Int32Array(nodeCount).fill(-1);
  const islandOfNode = new Int32Array(nodeCount);
  const islandNodes: number[][] = [];
  for (let node = 0; node < nodeCount; node++) {
    const root = nodeSets.find(node);
    if (islandOfRoot[root] < 0) {
      islandOfRoot[root] = islandNodes.length;
      islandNodes.push([]);
    }
    islandOfNode[node] = islandOfRoot[root];
    islandNodes[islandOfRoot[root]].push(node);
  }

  const nodes: NetlistNode[] = members.map((m, i) => ({ index: i, island: islandOfNode[i], members: m }));
  const islandBranches: number[][] = islandNodes.map(() => []);
  const hasDc = new Uint8Array(islandNodes.length);
  const hasAc = new Uint8Array(islandNodes.length);
  const branches: NetlistBranch[] = [];
  const addBranch = (
    element: NetlistBranch['element'],
    model: string,
    e: Omit<ElementFragment, 'part' | 'a' | 'b'>,
  ) => {
    const i = branches.length;
    const island = islandOfNode[endA[i]];
    islandBranches[island].push(i);
    if (e.source === 'dc') hasDc[island] = 1;
    else if (e.source === 'ac') hasAc[island] = 1;
    branches.push({
      index: i,
      element,
      kind: e.kind,
      model,
      source: e.source,
      a: endA[i],
      b: endB[i],
      island,
      values: e.values,
    });
  };
  for (const { entity, fragment } of devices) {
    for (const element of fragment.elements) {
      addBranch({ kind: 'entity', entity, part: element.part }, fragment.kind, element);
    }
  }
  for (const { id, result } of connections) {
    addBranch({ kind: 'connection', connection: id }, result.model, {
      kind: result.kind,
      source: null,
      values: result.values,
    });
  }

  const islands: NetlistIsland[] = islandNodes.map((n, i) => {
    const kind: IslandKind = hasDc[i] && hasAc[i] ? 'mixed' : hasDc[i] ? 'dc' : hasAc[i] ? 'ac' : 'empty';
    if (kind === 'mixed') diagnostics.push({ code: 'mixed-island', island: i });
    return { index: i, kind, nodes: n, branches: islandBranches[i] };
  });
  const deviceList: NetlistDevice[] = devices.map(({ entity, fragment }) => ({ entity, kind: fragment.kind }));
  return {
    nodes,
    branches,
    islands,
    devices: deviceList,
    topologyHash: computeTopologyHash(nodes, branches),
    diagnostics,
  };
}
