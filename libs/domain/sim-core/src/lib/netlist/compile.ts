import type { Catalog, DeviceDefinition, TerminalMethodSpec } from '@controls/catalog';
import { isBuiltinPropRef, type World } from '@controls/save-format';
import { toHex, sha256 } from '@controls/world-model';
import { TopologyWriter } from './encode';
import {
  BUILTIN_NETLIST_MODELS,
  CLIP_END,
  type ConnectionEndInput,
  type ConnectionNetlistModel,
  type DeviceNetlistModel,
  type ElementSpec,
  type NetlistModels,
  ownModel,
} from './models';
import type {
  AbsentConnectionReason,
  ElementKind,
  ElementRef,
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

/**
 * What a netlisted entity contributes to every netlist that holds it, built once with its cache
 * entry, so a structural recompile copies it instead of rebuilding it (F2.2 part 3b). The member and
 * element refs are shared by every netlist that reuses the entry, as the values are (netlists are
 * read-only).
 */
interface DeviceParts {
  readonly fragment: DeviceFragment;
  /** Terminal `i` as a node member. */
  readonly members: readonly TerminalRef[];
  /** Element `i`'s ref. */
  readonly elementRefs: readonly ElementRef[];
}

type EntityResult =
  | { readonly netlisted: true; readonly parts: DeviceParts }
  | { readonly netlisted: false; readonly diagnostic: NetlistDiagnostic | null };

interface EntityCacheEntry {
  readonly refId: string;
  readonly refVersion: number;
  readonly state: StateBag;
  readonly model: DeviceNetlistModel | undefined;
  readonly simKey: string;
  readonly result: EntityResult;
  /** A netlisted entity's termination methods per fragment terminal (sorted terminal ids); empty otherwise. */
  readonly methods: readonly (readonly TerminalMethodSpec[])[];
  /** The entity's contribution to the topology, without values: equal keys, equal contribution. */
  readonly structureKey: string;
  /**
   * The compile that last saw this entity (stale entries are pruned). An entry replaced by a rebuilt
   * one is never stamped again, so an `epoch` equal to the current compile's means "this entity's
   * entry, in this world".
   */
  epoch: number;
  /** Where a netlisted entity's terminals start in the plant-wide numbering, as of its `epoch`. */
  base: number;
}

/** What a connection's ref resolves to, fixed while the connection object is the same. */
type ConnectionKindResult =
  | {
      readonly ok: true;
      readonly model: ConnectionNetlistModel;
      readonly device: DeviceDefinition;
      readonly elementRef: ElementRef;
    }
  | { readonly ok: false; readonly reason: AbsentConnectionReason };

/** A netlisted connection's element, as `assemble` and `withValues` read it. */
interface ConnectionElementResult {
  readonly model: string;
  readonly kind: ElementKind;
  readonly values: Readonly<Record<string, number>>;
  /** `kind model`, for the change check. */
  readonly structureKey: string;
  readonly elementRef: ElementRef;
}

interface ConnectionCacheEntry {
  readonly connection: Connection;
  readonly result: ConnectionKindResult;
  epoch: number;
  /**
   * End a resolved: the entity's cache entry and the terminal's index in its fragment (-1: unknown).
   * It holds while that entry's `epoch` is the current compile's (the entity is in this world and
   * this is its entry); otherwise the end is resolved again. So a recompile looks up only the ends on
   * entities whose entries were rebuilt.
   */
  aEntry: EntityCacheEntry | null;
  aTerminal: number;
  /** End a's termination method: its index in the terminal's methods (-1: none) and its spec. */
  aMethod: number;
  aSpec: TerminalMethodSpec | null;
  /** End b, likewise. */
  bEntry: EntityCacheEntry | null;
  bTerminal: number;
  bMethod: number;
  bSpec: TerminalMethodSpec | null;
  /** This compile's landed-count slot of each end (plant terminal × methods + method), or -1. */
  aSlot: number;
  bSlot: number;
  /**
   * The element built for the landed counts and specs it records (ADR 0015 implementation note 3): it
   * is rebuilt when either count or spec differs, so a count change is a values-only compile.
   */
  element: ConnectionElementResult | null;
  elementACount: number;
  elementBCount: number;
  elementASpec: TerminalMethodSpec | null;
  elementBSpec: TerminalMethodSpec | null;
}

/** The most methods a terminal lists (`DeviceTerminal.methods`, catalogue v2): the stride of the landed counts. */
const MAX_TERMINAL_METHODS = 8;

type Entity = World['entities'][number];
type Connection = World['connections'][number];

/** A netlisted entity and where its terminals start in the plant-wide terminal numbering. */
interface PlacedDevice {
  readonly entity: number;
  readonly parts: DeviceParts;
  readonly base: number;
}

/** A netlisted connection, its ends as plant-wide terminal indices. */
interface PlacedConnection {
  readonly id: number;
  readonly result: ConnectionElementResult;
  readonly a: number;
  readonly b: number;
}

/**
 * Everything `assemble` reads except values, recorded in one flat list as each input is placed:
 * per entity `'e', id, structure key` (the fragment's kind, terminals, joins and elements, or why it
 * is absent); per connection `'c', id, end a, end b, structure key` (its element kind and model, or
 * why it is absent). Plant-wide terminal indices follow from the entity entries. So two compiles with
 * equal lists give equal nodes, islands, devices, diagnostics and hash, by construction: an input
 * that isn't recorded here can't reach `assemble`. Ids are recorded with what they resolved to, so an
 * id reused after an undo (a reconnect to other terminals) can never match a stale entry.
 */
type Structure = (number | string)[];

const ABSENT_KEYS: Readonly<Record<AbsentConnectionReason, string>> = {
  'unknown-ref': 'absent unknown-ref',
  'not-a-connection': 'absent not-a-connection',
  'no-model': 'absent no-model',
  'absent-end': 'absent absent-end',
  'unknown-terminal': 'absent unknown-terminal',
  unlanded: 'absent unlanded',
};

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
  /**
   * The previous compile's structure list. The next compile overwrites it in place and compares as
   * it writes, so a recompile allocates no list and makes no second pass. It means something only
   * while `previous` is set: a compile clears `previous` before writing, so a compile that throws
   * part-way leaves no half-written list to be compared against.
   */
  private readonly structure: Structure = [];
  private previous: Netlist | null = null;
  /** Buffers `assemble` reuses between structural recompiles. */
  private readonly scratch = new AssembleScratch();
  /** This compile's connection entries in id order (emptied after each compile). */
  private readonly entries: ConnectionCacheEntry[] = [];
  /** Conductor ends landed per (plant terminal, method), `terminal × MAX_TERMINAL_METHODS + method`. */
  private counts = new Int32Array(0);
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
    const previous = this.previous;
    this.previous = null;
    const structure = this.structure;
    let length = 0;
    let same = previous !== null;
    /** Records `value` at the next position, noting whether the previous compile had another there. */
    const record = (value: number | string): void => {
      if (structure[length] !== value) {
        structure[length] = value;
        same = false;
      }
      length++;
    };
    const entityDiagnostics: NetlistDiagnostic[] = [];
    const connectionDiagnostics: NetlistDiagnostic[] = [];

    // 1. Fragments, in entity id order. Terminal i of a device is plant terminal `base + i`.
    const devices: PlacedDevice[] = [];
    let terminalCount = 0;
    const entities = byId(world.entities);
    for (const entity of entities) {
      const entry = this.entityEntry(entity, options, epoch);
      record('e');
      record(entity.id);
      record(entry.structureKey);
      if (entry.result.netlisted) {
        entry.base = terminalCount;
        devices.push({ entity: entity.id, parts: entry.result.parts, base: terminalCount });
        terminalCount += entry.result.parts.fragment.terminals.length;
      } else if (entry.result.diagnostic) {
        entityDiagnostics.push(entry.result.diagnostic);
      }
    }

    // 2. Connections, resolved against the netlisted entities. First every landed end is resolved and
    // counted per (terminal, method), netlisted or not; lead clips (no termination) never count
    // (ADR 0015 implementation note 3). The counts are values: they never reach the structure list.
    const sortedConnections = byId(world.connections);
    const entries = this.entries;
    entries.length = sortedConnections.length;
    const slots = terminalCount * MAX_TERMINAL_METHODS;
    const counts = (this.counts = atLeast(this.counts, slots));
    counts.fill(0, 0, slots);
    for (let i = 0; i < sortedConnections.length; i++) {
      const cached = this.connectionEntry(sortedConnections[i], epoch);
      this.resolveEnds(cached, epoch);
      if (cached.aSlot >= 0) counts[cached.aSlot]++;
      if (cached.bSlot >= 0) counts[cached.bSlot]++;
      entries[i] = cached;
    }
    const connections: PlacedConnection[] = [];
    for (const cached of entries) {
      const connection = cached.connection;
      const result = cached.result;
      let reason: AbsentConnectionReason | null = null;
      let a = -1;
      let b = -1;
      if (!result.ok) {
        reason = result.reason;
      } else if (connection.a === null || connection.b === null) {
        // World v3 (ADR 0015): a connection with a free end is wired to nothing, so it isn't netlisted.
        reason = 'unlanded';
      } else {
        a = plantTerminal(cached.aEntry, cached.aTerminal);
        b = plantTerminal(cached.bEntry, cached.bTerminal);
        if (a === ABSENT_END || b === ABSENT_END) reason = 'absent-end';
        else if (a < 0 || b < 0) reason = 'unknown-terminal';
      }
      record('c');
      record(connection.id);
      record(a);
      record(b);
      if (reason !== null || !result.ok) {
        const absentReason = reason as AbsentConnectionReason;
        record(ABSENT_KEYS[absentReason]);
        connectionDiagnostics.push({ code: 'absent-connection', connection: connection.id, reason: absentReason });
      } else {
        const element = this.connectionElement(cached, result, counts);
        record(element.structureKey);
        connections.push({ id: connection.id, result: element, a, b });
      }
    }
    entries.length = 0;
    if (structure.length !== length) {
      structure.length = length;
      same = false;
    }
    prune(this.entityCache, entities.length, epoch);
    prune(this.connectionCache, sortedConnections.length, epoch);

    // Same structure as last time: the partition, islands, devices, hash and diagnostics are unchanged.
    if (same) {
      const netlist = withValues(previous as Netlist, devices, connections);
      if (netlist === previous) this.stats.unchanged++;
      else this.stats.valuesOnly++;
      this.previous = netlist;
      return netlist;
    }

    this.stats.structural++;
    const diagnostics = [...entityDiagnostics, ...connectionDiagnostics];
    const netlist = assemble(devices, terminalCount, connections, diagnostics, this.scratch);
    this.previous = netlist;
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
    const base = { refId: entity.ref.id, refVersion: entity.ref.version, state: entity.state, epoch, base: 0 };
    const absent = (diagnostic: NetlistDiagnostic | null): EntityCacheEntry => ({
      ...base,
      model: undefined,
      simKey: '',
      result: { netlisted: false, diagnostic },
      methods: NO_METHODS,
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
      result: { netlisted: true, parts: deviceParts(entity.id, fragment) },
      methods: terminals.map((id) => device.terminals.find((t) => t.id === id)?.methods ?? NO_SPECS),
      structureKey: fragmentKey(fragment),
    };
  }

  /** Entity `id`'s cache entry if this compile has seen it (it is in the world), else null. */
  private currentEntry(id: number, epoch: number): EntityCacheEntry | null {
    const entry = this.entityCache.get(id);
    return entry !== undefined && entry.epoch === epoch ? entry : null;
  }

  private connectionEntry(connection: Connection, epoch: number): ConnectionCacheEntry {
    const cached = this.connectionCache.get(connection.id);
    if (cached !== undefined && cached.connection === connection) {
      cached.epoch = epoch;
      return cached;
    }
    const kind = this.catalog.kindOf(connection.ref);
    const model = kind ? ownModel(this.models.connections, kind.kind) : undefined;
    let result: ConnectionKindResult;
    if (!kind) result = { ok: false, reason: 'unknown-ref' };
    else if (kind.placement !== 'connection') result = { ok: false, reason: 'not-a-connection' };
    else if (!model) result = { ok: false, reason: 'no-model' };
    else {
      const device = this.catalog.device(connection.ref) as NonNullable<ReturnType<Catalog['device']>>;
      result = { ok: true, model, device, elementRef: { kind: 'connection', connection: connection.id } };
    }
    const entry: ConnectionCacheEntry = {
      connection,
      result,
      epoch,
      aEntry: null,
      aTerminal: -1,
      aMethod: -1,
      aSpec: null,
      bEntry: null,
      bTerminal: -1,
      bMethod: -1,
      bSpec: null,
      aSlot: -1,
      bSlot: -1,
      element: null,
      elementACount: -1,
      elementBCount: -1,
      elementASpec: null,
      elementBSpec: null,
    };
    this.connectionCache.set(connection.id, entry);
    return entry;
  }

  /**
   * Resolves each landed end of `cached` against this compile's entity entries (only ends on entities
   * whose entries were rebuilt are looked up again) and sets its landed-count slot.
   */
  private resolveEnds(cached: ConnectionCacheEntry, epoch: number): void {
    const { a: endA, b: endB } = cached.connection;
    cached.aSlot = -1;
    cached.bSlot = -1;
    if (endA !== null) {
      if (cached.aEntry === null || cached.aEntry.epoch !== epoch) {
        cached.aEntry = this.currentEntry(endA.entity, epoch);
        cached.aTerminal = terminalOf(cached.aEntry, endA.terminal);
        cached.aMethod = methodOf(cached.aEntry, cached.aTerminal, endA.termination?.method);
        cached.aSpec =
          cached.aMethod < 0 ? null : (cached.aEntry as EntityCacheEntry).methods[cached.aTerminal][cached.aMethod];
      }
      cached.aSlot = countSlot(cached.aEntry, cached.aTerminal, cached.aMethod);
    }
    if (endB !== null) {
      if (cached.bEntry === null || cached.bEntry.epoch !== epoch) {
        cached.bEntry = this.currentEntry(endB.entity, epoch);
        cached.bTerminal = terminalOf(cached.bEntry, endB.terminal);
        cached.bMethod = methodOf(cached.bEntry, cached.bTerminal, endB.termination?.method);
        cached.bSpec =
          cached.bMethod < 0 ? null : (cached.bEntry as EntityCacheEntry).methods[cached.bTerminal][cached.bMethod];
      }
      cached.bSlot = countSlot(cached.bEntry, cached.bTerminal, cached.bMethod);
    }
  }

  /**
   * The element of a netlisted connection for this compile's landed counts: the cached one while the
   * counts and specs it was built for are unchanged, else rebuilt (a values-only change).
   */
  private connectionElement(
    cached: ConnectionCacheEntry,
    kind: Extract<ConnectionKindResult, { ok: true }>,
    counts: Int32Array,
  ): ConnectionElementResult {
    const aCount = cached.aSlot < 0 ? 0 : counts[cached.aSlot];
    const bCount = cached.bSlot < 0 ? 0 : counts[cached.bSlot];
    const previous = cached.element;
    if (
      previous !== null &&
      cached.elementACount === aCount &&
      cached.elementBCount === bCount &&
      cached.elementASpec === cached.aSpec &&
      cached.elementBSpec === cached.bSpec
    ) {
      return previous;
    }
    const { connection } = cached;
    const { device, model } = kind;
    const end = (
      termination: ConnectionEndInput['termination'],
      spec: TerminalMethodSpec | null,
      landedCount: number,
    ) => (termination === null ? CLIP_END : { termination, spec, landedCount });
    const element = model.element({
      params: device.model.params,
      device,
      catalog: this.catalog,
      lengthMm: connection.lengthMm,
      ends: {
        a: end(connection.a?.termination ?? null, cached.aSpec, aCount),
        b: end(connection.b?.termination ?? null, cached.bSpec, bCount),
      },
    });
    const result: ConnectionElementResult = {
      model: model.kind,
      kind: element.kind,
      values: sortedValues(element.values),
      structureKey: `${element.kind} ${model.kind}`,
      elementRef: kind.elementRef,
    };
    cached.element = result;
    cached.elementACount = aCount;
    cached.elementBCount = bCount;
    cached.elementASpec = cached.aSpec;
    cached.elementBSpec = cached.bSpec;
    return result;
  }
}

const NO_METHODS: readonly (readonly TerminalMethodSpec[])[] = Object.freeze([]);
const NO_SPECS: readonly TerminalMethodSpec[] = Object.freeze([]);

/** The index of `method` in a resolved terminal's methods, or -1 (no termination, unknown terminal or method). */
function methodOf(entry: EntityCacheEntry | null, terminal: number, method: string | undefined): number {
  if (entry === null || terminal < 0 || method === undefined) return -1;
  const methods = entry.methods[terminal];
  for (let i = 0; i < methods.length; i++) if (methods[i].method === method) return i;
  return -1;
}

/** A resolved end's landed-count slot this compile, or -1 when it isn't on a netlisted terminal by a known method. */
function countSlot(entry: EntityCacheEntry | null, terminal: number, method: number): number {
  if (method < 0) return -1;
  const plant = plantTerminal(entry, terminal);
  return plant < 0 ? -1 : plant * MAX_TERMINAL_METHODS + method;
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

/** Whether a netlist has no nodes (`nodes.length === 0`): such a world exports `sim: null` (ADR 0013). */
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

/** `terminal`'s index in a netlisted entry's fragment, or -1 (unknown, or no fragment). */
function terminalOf(entry: EntityCacheEntry | null, terminal: string): number {
  return entry !== null && entry.result.netlisted ? entry.result.parts.fragment.terminals.indexOf(terminal) : -1;
}

/** A resolved end's plant-wide terminal index this compile: {@link ABSENT_END}, -1 (unknown terminal) or ≥ 0. */
function plantTerminal(entry: EntityCacheEntry | null, terminal: number): number {
  if (entry === null || !entry.result.netlisted) return ABSENT_END;
  return terminal < 0 ? -1 : entry.base + terminal;
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
  // Frozen: one values object is shared by the cache and every netlist that reuses the fragment.
  return Object.freeze(sorted);
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

/** Entity `entity`'s {@link DeviceParts}: its members, element refs and their encoded pieces. */
function deviceParts(entity: number, fragment: DeviceFragment): DeviceParts {
  return {
    fragment,
    members: fragment.terminals.map((terminal) => ({ entity, terminal })),
    elementRefs: fragment.elements.map((e) => ({ kind: 'entity', entity, part: e.part })),
  };
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
  for (const { parts } of devices) for (const element of parts.fragment.elements) visit(element.values);
  for (const connection of connections) visit(connection.result.values);
  return branches === null ? previous : { ...previous, branches };
}

function sameValues(x: Readonly<Record<string, number>>, y: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(y, key) && Object.is(x[key], y[key]));
}

/** An `Int32Array` of at least `length` elements: `array` itself if it is long enough. */
function atLeast(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  return array.length >= length ? array : new Int32Array(Math.max(length, 2 * array.length));
}

/**
 * The working storage of `assemble`, kept by a compiler so that a structural recompile reuses it
 * (F2.2 part 3b): the union-finds, the per-terminal and per-branch index arrays and the encoding
 * buffer. They grow to the largest plant seen and never shrink. Nothing in a returned netlist refers
 * to them.
 */
class AssembleScratch {
  readonly terminals = new UnionFind(0);
  readonly nodeSets = new UnionFind(0);
  readonly writer = new TopologyWriter();
  nodeOfRoot = new Int32Array(0);
  nodeOfTerminal = new Int32Array(0);
  endA = new Int32Array(0);
  endB = new Int32Array(0);
  islandOfRoot = new Int32Array(0);
  islandOfNode = new Int32Array(0);
}

function assemble(
  devices: readonly PlacedDevice[],
  terminalCount: number,
  connections: readonly PlacedConnection[],
  diagnostics: NetlistDiagnostic[],
  scratch: AssembleScratch,
): Netlist {
  // Partition: ideal joins only.
  const terminals = scratch.terminals;
  terminals.reset(terminalCount);
  for (const { parts, base } of devices) {
    for (const group of parts.fragment.joins) {
      for (let i = 1; i < group.length; i++) terminals.union(base + group[0], base + group[i]);
    }
  }
  // Nodes, numbered as their smallest member is reached in canonical terminal order.
  const nodeOfRoot = (scratch.nodeOfRoot = atLeast(scratch.nodeOfRoot, terminalCount));
  nodeOfRoot.fill(-1, 0, terminalCount);
  const nodeOfTerminal = (scratch.nodeOfTerminal = atLeast(scratch.nodeOfTerminal, terminalCount));
  const members: TerminalRef[][] = [];
  for (const { parts, base } of devices) {
    const count = parts.members.length;
    for (let i = 0; i < count; i++) {
      const root = terminals.find(base + i);
      if (nodeOfRoot[root] < 0) {
        nodeOfRoot[root] = members.length;
        members.push([]);
      }
      nodeOfTerminal[base + i] = nodeOfRoot[root];
      members[nodeOfRoot[root]].push(parts.members[i]);
    }
  }
  const nodeCount = members.length;

  // Branch ends as nodes, in canonical branch order: entity elements, then connections.
  let branchCount = connections.length;
  for (const { parts } of devices) branchCount += parts.fragment.elements.length;
  const endA = (scratch.endA = atLeast(scratch.endA, branchCount));
  const endB = (scratch.endB = atLeast(scratch.endB, branchCount));
  let index = 0;
  for (const { parts, base } of devices) {
    for (const element of parts.fragment.elements) {
      endA[index] = nodeOfTerminal[base + element.a];
      endB[index++] = nodeOfTerminal[base + element.b];
    }
  }
  for (const { a, b } of connections) {
    endA[index] = nodeOfTerminal[a];
    endB[index++] = nodeOfTerminal[b];
  }

  // Islands: connected components of the nodes over the branches, numbered by their smallest node.
  const nodeSets = scratch.nodeSets;
  nodeSets.reset(nodeCount);
  for (let i = 0; i < branchCount; i++) nodeSets.union(endA[i], endB[i]);
  const islandOfRoot = (scratch.islandOfRoot = atLeast(scratch.islandOfRoot, nodeCount));
  islandOfRoot.fill(-1, 0, nodeCount);
  const islandOfNode = (scratch.islandOfNode = atLeast(scratch.islandOfNode, nodeCount));
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

  const nodes: NetlistNode[] = new Array<NetlistNode>(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodes[i] = { index: i, island: islandOfNode[i], members: members[i] };
  const islandBranches: number[][] = islandNodes.map(() => []);
  const hasDc = new Uint8Array(islandNodes.length);
  const hasAc = new Uint8Array(islandNodes.length);
  const branches: NetlistBranch[] = new Array<NetlistBranch>(branchCount);
  const addBranch = (
    i: number,
    element: ElementRef,
    model: string,
    kind: ElementKind,
    source: SourceDomain | null,
    values: Readonly<Record<string, number>>,
  ) => {
    const island = islandOfNode[endA[i]];
    islandBranches[island].push(i);
    if (source === 'dc') hasDc[island] = 1;
    else if (source === 'ac') hasAc[island] = 1;
    branches[i] = { index: i, element, kind, model, source, a: endA[i], b: endB[i], island, values };
  };
  index = 0;
  for (const { parts } of devices) {
    const { fragment, elementRefs } = parts;
    for (let j = 0; j < fragment.elements.length; j++) {
      const e = fragment.elements[j];
      addBranch(index++, elementRefs[j], fragment.kind, e.kind, e.source, e.values);
    }
  }
  for (const { result } of connections) {
    addBranch(index++, result.elementRef, result.model, result.kind, null, result.values);
  }

  const islands: NetlistIsland[] = islandNodes.map((n, i) => {
    const kind: IslandKind = hasDc[i] && hasAc[i] ? 'mixed' : hasDc[i] ? 'dc' : hasAc[i] ? 'ac' : 'empty';
    if (kind === 'mixed') diagnostics.push({ code: 'mixed-island', island: i });
    return { index: i, kind, nodes: n, branches: islandBranches[i] };
  });
  const deviceList: NetlistDevice[] = devices.map(({ entity, parts }) => ({ entity, kind: parts.fragment.kind }));
  return {
    nodes,
    branches,
    islands,
    devices: deviceList,
    topologyHash: toHex(sha256(scratch.writer.encode(nodes, branches))),
    diagnostics,
  };
}
