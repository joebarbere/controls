import {
  type Catalog,
  type DeviceDefinition,
  MAX_TERMINAL_METHODS,
  offeredMounts,
  type TerminalMethodSpec,
} from '@controls/catalog';
import { type DeviceStateValue, isBuiltinPropRef, type World } from '@controls/save-format';
import { busStabIndex, busStabLeg, sha256, sha256Finish, sha256Prefix, toHex } from '@controls/world-model';
import { TopologyWriter } from './encode';
import { RELATION_CODES } from './hash';
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
import {
  type AbsentConnectionReason,
  CONTACT_MODEL,
  type ContactRelation,
  EARTH_ENTITY,
  EARTH_TERMINAL,
  type ElementKind,
  type ElementRef,
  type IslandKind,
  type Netlist,
  type NetlistBranch,
  type NetlistDevice,
  type NetlistDiagnostic,
  type NetlistIsland,
  type NetlistNode,
  type SourceDomain,
  type StateBag,
  type TerminalRef,
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
 *    smallest member, whatever the union order. Joins never cross devices, so each device's partition
 *    is computed once with its fragment (`DeviceParts.localNode`) and a compile only offsets it.
 * 3. Branches: entity elements (entity id, then part), then each netlisted connection by id, exactly
 *    one branch each (ADR 0011 §7). A connection with an end on an absent entity is absent itself.
 *    Then (engine 8, ADR 0019 "What the netlist compiler reads") the relation contacts, by entity id,
 *    relation code and contact id: each contact a device's fit makes with its host's mount
 *    (`mountedOn`; on a bus through `busStabIndex` and `busStabLeg`), each pin of an appliance's plug in
 *    an outlet (`pluggedInto`) and each link a model declares to remote earth, one resistor branch each,
 *    never an ideal join. Remote earth is the implicit one-terminal fragment at entity 0, terminal
 *    `earth`, present only when an earth link compiles; it sorts first, so it is then node 0.
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
  /**
   * One key of an entity's sim-owned state, without building a bag (engine 8): preferred over `sim`
   * when given. `null` for a key the live state lacks; `undefined` when there is no live state for the
   * entity, so the world's own bag is read (as `sim` returning `undefined`). Models see each
   * `simTopologyKeys` value projected to a boolean ({@link simTopologyFlag}).
   */
  readonly simValue?: (entity: number, key: string) => DeviceStateValue | undefined;
  /**
   * The engine's sim-owned state of a connection (ADR 0015, F3.6 part 2): only the keys its model lists
   * in `simTopologyKeys` (`endAState`, `endBState`, a conductor's `fused`) are read, and only whether one
   * is `intermittentOpen` or `fused` is `true` (the connection is then absent, `intermittent-open`). When it returns
   * `undefined`, or is left out, the world's own `sim` bag is used (right at a start or a load).
   */
  readonly connectionSim?: (connection: number) => Readonly<Record<string, unknown>> | undefined;
}

export interface NetlistCompilerOptions {
  /** The netlist models (default {@link BUILTIN_NETLIST_MODELS}); tests pass synthetic kinds. */
  readonly models?: NetlistModels;
  /**
   * `wiring` compiles the wiring view (engine 8, `wiringGraph`): each model's `wiring` topology (a
   * switch closed, a protective device intact) with no sim state, and every landed connection present
   * whatever its ends' sim state. Default `electrical`, what the solvers read.
   */
  readonly view?: 'electrical' | 'wiring';
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

/** A link to remote earth (engine 8): its contact id, its terminal (an index into `terminals`) and values. */
interface EarthFragment {
  readonly contact: string;
  readonly terminal: number;
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
  /** Links to remote earth, sorted by contact id (engine 8); empty for most kinds. */
  readonly earth: readonly EarthFragment[];
}

/**
 * What a netlisted entity contributes to every netlist that holds it, built once with its cache
 * entry, so a structural recompile copies it instead of rebuilding it (F2.2 part 3b). The member lists,
 * element refs and device entry are shared by every netlist that reuses the entry, as the values are
 * (netlists are read-only).
 */
interface DeviceParts {
  readonly fragment: DeviceFragment;
  /** Element `i`'s ref. */
  readonly elementRefs: readonly ElementRef[];
  /**
   * The device's own nodes. Only a device's ideal joins merge terminals (a connection is always a
   * branch), so every node of a netlist lies inside one device, and the partition is a function of the
   * fragment alone: terminal `i` is in local node `localNode[i]`, local nodes numbered as their smallest
   * terminal is reached in terminal order, which is the canonical numbering restricted to the device.
   */
  readonly localNode: readonly number[];
  /** Each local node's members in terminal order: the arrays every netlist that holds the device shares. */
  readonly nodeMembers: readonly (readonly TerminalRef[])[];
  /** Its entry in `Netlist.devices`, shared likewise. */
  readonly device: NetlistDevice;
}

type EntityResult =
  | { readonly netlisted: true; readonly parts: DeviceParts }
  | { readonly netlisted: false; readonly diagnostic: NetlistDiagnostic | null };

interface EntityCacheEntry {
  /** The entity's id. */
  readonly id: number;
  readonly refId: string;
  readonly refVersion: number;
  readonly state: StateBag;
  readonly model: DeviceNetlistModel | undefined;
  /**
   * The catalogue entry, whenever the catalogue knows the ref (netlisted or not): the relation contacts
   * read its fits, offered mounts, outlets and plug (engine 8). `null` for a prop or an unknown ref.
   */
  readonly device: DeviceDefinition | null;
  /** The sim topology keys projected to booleans, one bit per key in `simTopologyKeys` order (engine 8). */
  readonly simCode: number;
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
  /** A netlisted entity's place in a compile's device list (null otherwise). */
  readonly placed: PlacedDevice | null;
  /**
   * A netlisted entity's terminal and element counts (0 otherwise), kept on the entry so the walk reads
   * them without reaching into the fragment (perf only).
   */
  readonly terminals: number;
  readonly elements: number;
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
  /** Its place in a compile's connection list, made the first time it is netlisted. */
  placed: PlacedConnection | null;
}

type Entity = World['entities'][number];
type Connection = World['connections'][number];

/** A contact's host terminal is remote earth (plant terminal {@link EARTH_PLANT_TERMINAL}). */
const HOST_EARTH = -3;
/** Plant terminal 0 is reserved for remote earth: entity 0 sorts first (ADR 0019). */
const EARTH_PLANT_TERMINAL = 0;

type ContactRef = Extract<ElementRef, { kind: 'contact' }>;

/**
 * One relation contact of an entity (engine 8), resolved against the catalogue and the relation's
 * host: the dependent device's terminal and the host's (fragment indices; `-1` when the terminal isn't
 * netlisted, {@link HOST_EARTH} for remote earth). `ref` and `values` are shared by every netlist that
 * holds the contact. `placed` is its place in a compile's contact list, made the first time it compiles.
 */
interface ContactSpec {
  readonly ref: ContactRef;
  readonly code: number;
  readonly own: number;
  readonly host: number;
  readonly values: Readonly<Record<string, number>>;
  placed: PlacedContact | null;
}

/**
 * An entity's resolved contacts, cached while the inputs they were resolved from are the same objects:
 * the entity (its relations and transform), its cache entry (its fragment), and its relation's host
 * entity and entry (its mounts or outlets, its transform for a bus stab). Specs in branch order:
 * mount, then plug, then earth, each by contact id.
 */
interface ContactCacheEntry {
  readonly entity: Entity;
  readonly own: EntityCacheEntry;
  readonly hostEntity: Entity | null;
  readonly host: EntityCacheEntry | null;
  readonly specs: readonly ContactSpec[];
  epoch: number;
}

/** A compiled contact branch: its spec and its ends as plant-wide terminal indices, rewritten per compile. */
interface PlacedContact {
  readonly spec: ContactSpec;
  a: number;
  b: number;
}

/** Remote earth's fragment: one terminal, `earth`, nothing else (engine 8, D5). */
const EARTH_FRAGMENT: DeviceFragment = Object.freeze({
  kind: 'earth',
  terminals: Object.freeze([EARTH_TERMINAL]),
  joins: Object.freeze([]),
  elements: Object.freeze([]),
  earth: Object.freeze([]),
});

/**
 * A netlisted entity and where its terminals start in the plant-wide terminal numbering. One per cache
 * entry, rewritten by each compile that places it (lists of them live only for one compile).
 */
interface PlacedDevice {
  readonly parts: DeviceParts;
  base: number;
}

/**
 * A netlisted connection, its ends as plant-wide terminal indices. One per cache entry, rewritten by
 * each compile that places it, as {@link PlacedDevice} is.
 */
interface PlacedConnection {
  readonly id: number;
  result: ConnectionElementResult;
  a: number;
  b: number;
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
  'intermittent-open': 'absent intermittent-open',
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
  /** Whether this compiler compiles the wiring view (`NetlistCompilerOptions.view`). */
  private readonly wiring: boolean;
  /** Each entity's resolved relation contacts (engine 8), by entity id. */
  private readonly contactCache = new Map<number, ContactCacheEntry>();
  /** This compile's contact branches, in canonical order (rewritten by each compile). */
  private readonly placedContacts: PlacedContact[] = [];
  /** The last full compile's contact diagnostics (the open-toggle path repeats them). */
  private lastContactDiagnostics: readonly NetlistDiagnostic[] = [];
  /** This compile's netlisted devices and connections, in canonical order (rewritten by each compile). */
  private readonly placedDevices: PlacedDevice[] = [];
  private readonly placedConnections: PlacedConnection[] = [];
  /**
   * The entity and connection entries of the last compile that walked the world, in id order, and
   * whether that walk finished (perf only). A compile reads position i as a guess at its i-th input's
   * entry before it overwrites it: one with the same id is that id's cache entry (the walk that wrote it
   * left it in the cache, and only its own input replaces it), so a world of the same shape is matched
   * without a map lookup per input. Anything else falls back to the cache's map.
   */
  private readonly entityHints: EntityCacheEntry[] = [];
  private readonly entries: ConnectionCacheEntry[] = [];
  private hintsValid = false;
  /** Conductor ends landed per (plant terminal, method), `terminal × MAX_TERMINAL_METHODS + method`. */
  private counts = new Int32Array(0);
  readonly stats: NetlistCompilerStats = { structural: 0, valuesOnly: 0, unchanged: 0 };
  /**
   * The open-toggle path's record of the last full compile (F3.6 part 2, see `toggleOnly`): its world,
   * its entities with sim topology keys and their entries, its entity diagnostics and entity branch
   * count, and per connection in id order its entry, plant terminals, structure-list position, state
   * (`SLOT_ABSENT` for a fixed reason, `SLOT_PRESENT`, `SLOT_OPEN`) and fixed absence reason.
   * Meaningful only while `lastWorld` is set (a full compile sets it last, so one that throws leaves none).
   */
  private lastWorld: World | null = null;
  private readonly simEntities: Entity[] = [];
  private readonly simEntries: EntityCacheEntry[] = [];
  private lastEntityDiagnostics: readonly NetlistDiagnostic[] = [];
  private deviceBranchCount = 0;
  private readonly slotEntry: ConnectionCacheEntry[] = [];
  private readonly slotReason: (AbsentConnectionReason | null)[] = [];
  private slotA = new Int32Array(0);
  private slotB = new Int32Array(0);
  private slotKeyPos = new Int32Array(0);
  private slotState = new Uint8Array(0);
  private slotCount = 0;

  constructor(
    private readonly catalog: Catalog,
    options: NetlistCompilerOptions = {},
  ) {
    this.models = options.models ?? BUILTIN_NETLIST_MODELS;
    this.wiring = options.view === 'wiring';
  }

  /**
   * Compiles `world`, reusing what an earlier compile already derived. The result equals
   * `compileNetlist(world, catalog, options)` exactly, whatever was compiled before.
   */
  compile(world: World, options: CompileOptions = {}): Netlist {
    if (this.previous !== null && world === this.lastWorld && !this.wiring) {
      const toggled = this.toggleOnly(options);
      if (toggled !== null) return toggled;
    }
    const epoch = ++this.epoch;
    const hinted = this.hintsValid;
    this.hintsValid = false;
    const previous = this.previous;
    this.previous = null;
    this.lastWorld = null;
    this.simEntities.length = 0;
    this.simEntries.length = 0;
    let deviceBranchCount = 0;
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
    // The device and connection lists are overwritten in place and cut to length at the end: setting an
    // array's length to 0 drops its backing store, so refilling it by `push` reallocated it as it grew.
    const devices = this.placedDevices;
    let deviceCount = 0;
    // Plant terminal 0 is remote earth's, whether or not this world has an earth node (engine 8).
    let terminalCount = EARTH_PLANT_TERMINAL + 1;
    const entities = byId(world.entities);
    const entityHints = this.entityHints;
    const entityHintCount = hinted ? entityHints.length : 0;
    entityHints.length = entities.length;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const hint = i < entityHintCount ? entityHints[i] : undefined;
      const entry = this.entityEntry(entity, options, epoch, hint !== undefined && hint.id === entity.id ? hint : null);
      entityHints[i] = entry;
      record('e');
      record(entity.id);
      record(entry.structureKey);
      const placed = entry.placed;
      if (placed !== null) {
        entry.base = terminalCount;
        placed.base = terminalCount;
        devices[deviceCount++] = placed;
        terminalCount += entry.terminals;
        deviceBranchCount += entry.elements;
        if (!this.wiring && entry.model !== undefined && entry.model.simTopologyKeys.length > 0) {
          this.simEntities.push(entity);
          this.simEntries.push(entry);
        }
      } else if (!entry.result.netlisted && entry.result.diagnostic) {
        entityDiagnostics.push(entry.result.diagnostic);
      }
    }

    // 2. Connections, resolved against the netlisted entities. First every landed end is resolved and
    // counted per (terminal, method), netlisted or not; lead clips (no termination) never count
    // (ADR 0015 implementation note 3). The counts are values: they never reach the structure list.
    const sortedConnections = byId(world.connections);
    const entries = this.entries;
    const connectionHintCount = hinted ? entries.length : 0;
    entries.length = sortedConnections.length;
    const slots = terminalCount * MAX_TERMINAL_METHODS;
    const counts = (this.counts = atLeast(this.counts, slots));
    counts.fill(0, 0, slots);
    for (let i = 0; i < sortedConnections.length; i++) {
      const connection = sortedConnections[i];
      const hint = i < connectionHintCount ? entries[i] : undefined;
      const cached = this.connectionEntry(
        connection,
        epoch,
        hint !== undefined && hint.connection.id === connection.id ? hint : null,
      );
      this.resolveEnds(cached, epoch);
      if (cached.aSlot >= 0) counts[cached.aSlot]++;
      if (cached.bSlot >= 0) counts[cached.bSlot]++;
      entries[i] = cached;
    }
    devices.length = deviceCount;
    const connections = this.placedConnections;
    let connectionCount = 0;
    const slotCount = entries.length;
    if (this.slotState.length < slotCount) {
      const size = Math.max(slotCount, 2 * this.slotState.length);
      this.slotA = new Int32Array(size);
      this.slotB = new Int32Array(size);
      this.slotKeyPos = new Int32Array(size);
      this.slotState = new Uint8Array(size);
    }
    this.slotEntry.length = slotCount;
    this.slotReason.length = slotCount;
    let slot = 0;
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
        else if (!this.wiring && openEnd(result.model, options.connectionSim?.(connection.id) ?? connection.sim)) {
          // An end that is open (intermittent, burned open, a fused lead) or a fused conductor takes the
          // branch out (ADR 0015, ADR 0018 implementation notes).
          reason = 'intermittent-open';
        }
      }
      record('c');
      record(connection.id);
      record(a);
      record(b);
      this.slotEntry[slot] = cached;
      this.slotA[slot] = a;
      this.slotB[slot] = b;
      this.slotKeyPos[slot] = length;
      this.slotState[slot] = reason === null ? SLOT_PRESENT : reason === 'intermittent-open' ? SLOT_OPEN : SLOT_ABSENT;
      this.slotReason[slot++] = reason === 'intermittent-open' ? null : reason;
      if (reason !== null || !result.ok) {
        const absentReason = reason as AbsentConnectionReason;
        record(ABSENT_KEYS[absentReason]);
        connectionDiagnostics.push({ code: 'absent-connection', connection: connection.id, reason: absentReason });
      } else {
        const element = this.connectionElement(cached, result, counts);
        record(element.structureKey);
        connections[connectionCount++] = placeConnection(cached, element, a, b);
      }
    }
    connections.length = connectionCount;

    // 3. Relation contacts (engine 8, ADR 0019): per entity in id order, its mount contacts, its plug's
    // pins, then its earth links, each by contact id. An entity with none (every P3 world's entities,
    // and a device on a contact-less mount such as a DIN rail) adds nothing to the list.
    const contacts = this.placedContacts;
    let contactCount = 0;
    let earthUsed = false;
    const contactDiagnostics: NetlistDiagnostic[] = [];
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const own = entityHints[i];
      if (entity.mountedOn === null && entity.pluggedInto === null && !hasEarth(own)) continue;
      const hostId = entity.mountedOn?.entity ?? entity.pluggedInto?.entity;
      const host = hostId === undefined ? null : this.currentEntry(hostId, epoch);
      const specs = this.contactSpecs(entity, own, host, hostId, entities, epoch);
      for (let k = 0; k < specs.length; k++) {
        const spec = specs[k];
        const a = plantTerminal(own, spec.own);
        const b = spec.host === HOST_EARTH ? EARTH_PLANT_TERMINAL : plantTerminal(host, spec.host);
        record('k');
        record(entity.id);
        record(spec.code);
        record(spec.ref.contact);
        if (a < 0 || b < 0) {
          record('absent');
          const { relation, contact } = spec.ref;
          contactDiagnostics.push({ code: 'absent-contact', entity: entity.id, relation, contact });
          continue;
        }
        record(a);
        record(b);
        if (b === EARTH_PLANT_TERMINAL) earthUsed = true;
        contacts[contactCount++] = placeContact(spec, a, b);
      }
    }
    contacts.length = contactCount;

    if (structure.length !== length) {
      structure.length = length;
      same = false;
    }
    prune(this.entityCache, entities.length, epoch);
    prune(this.connectionCache, sortedConnections.length, epoch);
    prune(this.contactCache, entities.length, epoch);
    this.hintsValid = true;

    this.slotCount = slotCount;
    this.deviceBranchCount = deviceBranchCount;
    this.lastEntityDiagnostics = entityDiagnostics;
    this.lastContactDiagnostics = contactDiagnostics;

    // Same structure as last time: the partition, islands, devices, hash and diagnostics are unchanged.
    if (same) {
      const netlist = withValues(previous as Netlist, devices, connections, contacts);
      if (netlist === previous) this.stats.unchanged++;
      else this.stats.valuesOnly++;
      this.previous = netlist;
      this.lastWorld = world;
      return netlist;
    }

    this.stats.structural++;
    const diagnostics = [...entityDiagnostics, ...connectionDiagnostics, ...contactDiagnostics];
    const netlist = assemble(devices, terminalCount, connections, contacts, earthUsed, diagnostics, this.scratch);
    this.previous = netlist;
    this.lastWorld = world;
    return netlist;
  }

  /**
   * `entity`'s relation contacts (engine 8, ADR 0019 "What the netlist compiler reads" 1, 2, 4 and 6),
   * from the cache while the entity, its entry, its host and the host's entry are the objects they were
   * resolved from. `host` is the entry of the entity its relation names (`hostId`), `entities` this
   * compile's sorted entity list (the host's transform is read from it, for a bus stab).
   */
  private contactSpecs(
    entity: Entity,
    own: EntityCacheEntry,
    host: EntityCacheEntry | null,
    hostId: number | undefined,
    entities: readonly Entity[],
    epoch: number,
  ): readonly ContactSpec[] {
    const hostEntity = hostId === undefined ? null : findById(entities, hostId);
    const cached = this.contactCache.get(entity.id);
    if (
      cached !== undefined &&
      cached.entity === entity &&
      cached.own === own &&
      cached.hostEntity === hostEntity &&
      cached.host === host
    ) {
      cached.epoch = epoch;
      return cached.specs;
    }
    const specs: ContactSpec[] = [];
    if (entity.mountedOn !== null && hostEntity !== null && host !== null) {
      mountContacts(entity, own, hostEntity, host, specs);
    }
    if (entity.pluggedInto !== null && host !== null) plugContacts(entity, own, host, specs);
    if (own.result.netlisted) {
      for (const link of own.result.parts.fragment.earth) {
        specs.push(contactSpec(entity.id, 'earth', link.contact, link.terminal, HOST_EARTH, link.values));
      }
    }
    this.contactCache.set(entity.id, { entity, own, hostEntity, host, specs, epoch });
    return specs;
  }

  /**
   * The open-toggle path (F3.6 part 2, perf only): a compile of the **same world object** as the last
   * full compile, whose entities' sim topology views are unchanged, can differ from it only in which
   * connections have an open end (ADR 0015: the only connection sim state the compiler reads). Then the
   * partition, the devices, every entity and connection entry, the landed counts and every connection's
   * plant terminals are the last compile's, so this re-evaluates only the open ends: no change returns
   * the previous netlist (as the full path's unchanged case does), and a change updates the structure
   * list in place and re-assembles the branches and islands from the previous netlist
   * (`reassemble`), without re-walking the world or re-partitioning the terminals. Returns `null` when
   * an entity's sim view changed (a blown fuse, a tripped breaker): the full path takes it. The result
   * equals a full compile's exactly (property-tested, with its `topologyHash`).
   */
  private toggleOnly(options: CompileOptions): Netlist | null {
    const previous = this.previous as Netlist;
    for (let k = 0; k < this.simEntities.length; k++) {
      const entity = this.simEntities[k];
      const entry = this.simEntries[k];
      const model = entry.model as DeviceNetlistModel;
      if (simCodeOf(model, entity, options) !== entry.simCode) return null;
    }
    const states = this.slotState;
    let changed = false;
    for (let s = 0; s < this.slotCount; s++) {
      const state = states[s];
      if (state === SLOT_ABSENT) continue;
      const entry = this.slotEntry[s];
      const connection = entry.connection;
      const model = (entry.result as Extract<ConnectionKindResult, { ok: true }>).model;
      const now = openEnd(model, options.connectionSim?.(connection.id) ?? connection.sim) ? SLOT_OPEN : SLOT_PRESENT;
      if (now === state) continue;
      changed = true;
      states[s] = now;
      this.structure[this.slotKeyPos[s]] =
        now === SLOT_OPEN
          ? ABSENT_KEYS['intermittent-open']
          : this.connectionElement(entry, entry.result as Extract<ConnectionKindResult, { ok: true }>, this.counts)
              .structureKey;
    }
    if (!changed) {
      this.stats.unchanged++;
      return previous;
    }
    const connections = this.placedConnections;
    let connectionCount = 0;
    const diagnostics: NetlistDiagnostic[] = [...this.lastEntityDiagnostics];
    const contactDiagnostics = this.lastContactDiagnostics;
    for (let s = 0; s < this.slotCount; s++) {
      const entry = this.slotEntry[s];
      const id = entry.connection.id;
      const state = states[s];
      if (state === SLOT_PRESENT) {
        const result = entry.result as Extract<ConnectionKindResult, { ok: true }>;
        const element = this.connectionElement(entry, result, this.counts);
        connections[connectionCount++] = placeConnection(entry, element, this.slotA[s], this.slotB[s]);
      } else {
        const reason = state === SLOT_OPEN ? 'intermittent-open' : (this.slotReason[s] as AbsentConnectionReason);
        diagnostics.push({ code: 'absent-connection', connection: id, reason });
      }
    }
    connections.length = connectionCount;
    for (let i = 0; i < contactDiagnostics.length; i++) diagnostics.push(contactDiagnostics[i]);
    this.stats.structural++;
    const netlist = reassemble(
      previous,
      this.deviceBranchCount,
      connections,
      this.placedContacts,
      diagnostics,
      this.scratch,
    );
    this.previous = netlist;
    return netlist;
  }

  /** `hint`: entity `entity.id`'s cache entry if the caller knows it (see `entityHints`), else null. */
  private entityEntry(
    entity: Entity,
    options: CompileOptions,
    epoch: number,
    hint: EntityCacheEntry | null,
  ): EntityCacheEntry {
    const cached = hint ?? this.entityCache.get(entity.id);
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
        this.wiring ||
        model.simTopologyKeys.length === 0 ||
        simCodeOf(model, entity, options) === cached.simCode
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
    const base = {
      id: entity.id,
      refId: entity.ref.id,
      refVersion: entity.ref.version,
      state: entity.state,
      epoch,
      base: 0,
    };
    const absent = (
      diagnostic: NetlistDiagnostic | null,
      device: DeviceDefinition | null = null,
    ): EntityCacheEntry => ({
      ...base,
      model: undefined,
      device,
      simCode: 0,
      placed: null,
      terminals: 0,
      elements: 0,
      result: { netlisted: false, diagnostic },
      methods: NO_METHODS,
      structureKey: diagnostic === null ? 'prop' : JSON.stringify(diagnostic),
    });
    if (isBuiltinPropRef(entity.ref)) return absent(null);
    const kind = this.catalog.kindOf(entity.ref);
    if (!kind) return absent({ code: 'unknown-device', entity: entity.id });
    // The catalogue resolves every ref its `kindOf` resolves.
    const device = this.catalog.device(entity.ref) as NonNullable<ReturnType<Catalog['device']>>;
    const model = ownModel(this.models.devices, kind.kind);
    if (!model || kind.placement !== 'entity') {
      return absent({ code: 'no-model', entity: entity.id, kind: kind.kind }, device);
    }
    const simCode = this.wiring ? 0 : simCodeOf(model, entity, options);
    const sim = this.wiring ? NO_SIM : simTopologyView(model, simCode);
    const terminals = device.terminals.map((t) => t.id).sort();
    const fragment = buildFragment(model, terminals, device.model.params, entity.state, sim, this.wiring);
    const parts = deviceParts(entity.id, fragment);
    return {
      ...base,
      model,
      device,
      simCode,
      placed: { parts, base: 0 },
      terminals: fragment.terminals.length,
      elements: fragment.elements.length,
      result: { netlisted: true, parts },
      methods: terminals.map((id) => device.terminals.find((t) => t.id === id)?.methods ?? NO_SPECS),
      structureKey: fragmentKey(fragment),
    };
  }

  /** Entity `id`'s cache entry if this compile has seen it (it is in the world), else null. */
  private currentEntry(id: number, epoch: number): EntityCacheEntry | null {
    const entry = this.entityCache.get(id);
    return entry !== undefined && entry.epoch === epoch ? entry : null;
  }

  /** `hint`: connection `connection.id`'s cache entry if the caller knows it (see `entityHints`), else null. */
  private connectionEntry(
    connection: Connection,
    epoch: number,
    hint: ConnectionCacheEntry | null,
  ): ConnectionCacheEntry {
    const cached = hint ?? this.connectionCache.get(connection.id);
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
      placed: null,
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

/** Whether a netlisted entry's fragment links to remote earth. */
const hasEarth = (entry: EntityCacheEntry): boolean =>
  entry.result.netlisted && entry.result.parts.fragment.earth.length > 0;

/** The entity with id `id` in `entities` (sorted by id), by bisection, or null. */
function findById(entities: readonly Entity[], id: number): Entity | null {
  let lo = 0;
  let hi = entities.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = entities[mid].id;
    if (at === id) return entities[mid];
    if (at < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const byContactId = <T extends { readonly id: string }>(items: readonly T[]): readonly T[] =>
  items.length < 2 ? items : [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

function contactSpec(
  entity: number,
  relation: ContactRelation,
  contact: string,
  own: number,
  host: number,
  values: Readonly<Record<string, number>>,
): ContactSpec {
  return {
    ref: Object.freeze({ kind: 'contact', entity, relation, contact }),
    code: RELATION_CODES[relation],
    own,
    host,
    values,
    placed: null,
  };
}

/**
 * A mounted device's contacts with its host (ADR 0019 1–2, ADR 0020): one per contact of the device's
 * fit for the host mount's type whose host contact the mount offers. A bus mount reaches its legs
 * through its stab pattern: the device's stab is `busStabIndex` (world-model's, the one function every
 * reader calls) plus the contact's `positionOffset`, and its leg is `busStabLeg`; a bus contact with no
 * stab (a position the load check would refuse) is kept with host `-1`, so it is absent and diagnosed.
 * A mount that offers none of the fit's host contacts, or a fit with none, adds nothing.
 */
function mountContacts(
  entity: Entity,
  own: EntityCacheEntry,
  hostEntity: Entity,
  host: EntityCacheEntry,
  out: ContactSpec[],
): void {
  const mountedOn = entity.mountedOn;
  if (mountedOn === null || own.device === null || host.device === null) return;
  const mount = offeredMounts(host.device).find((m) => m.id === mountedOn.mount);
  if (mount === undefined) return;
  const fit = own.device.mounts.find((f) => f.type === mount.type);
  if (fit === undefined || fit.contacts.length === 0) return;
  const stab = mount.bus === null ? null : busStabIndex(hostEntity, mount, entity.transform.positionMm, fit);
  for (const contact of byContactId(fit.contacts)) {
    let terminal: string | null;
    if (mount.bus !== null) {
      if (contact.host !== 'stab') continue;
      terminal = stab === null ? null : busStabLeg(mount, stab + contact.positionOffset);
    } else {
      const offered = mount.contacts.find((c) => c.id === contact.host);
      if (offered === undefined) continue;
      terminal = offered.terminal;
    }
    out.push(
      contactSpec(
        entity.id,
        'mount',
        contact.id,
        terminalOf(own, contact.terminal),
        terminal === null ? -1 : terminalOf(host, terminal),
        Object.freeze({ resistanceOhm: contact.contactOhm }),
      ),
    );
  }
}

/**
 * An appliance's plug contacts (ADR 0019 4): one per pin of its plug, by pin id, from the appliance's
 * pin terminal to the outlet's slot terminal for that pin, each the outlet's `contactOhm`. A pin the
 * outlet has no slot for (never, for a configuration that mates) is absent and diagnosed.
 */
function plugContacts(entity: Entity, own: EntityCacheEntry, host: EntityCacheEntry, out: ContactSpec[]): void {
  const plugged = entity.pluggedInto;
  if (plugged === null || own.device === null || own.device.plug === null || host.device === null) return;
  const outlet = host.device.outlets.find((o) => o.id === plugged.outlet);
  if (outlet === undefined) return;
  const values = Object.freeze({ resistanceOhm: outlet.contactOhm });
  const pins = [...own.device.plug.pins].sort((x, y) => (x.pin < y.pin ? -1 : x.pin > y.pin ? 1 : 0));
  for (const pin of pins) {
    const slot = outlet.pins.find((p) => p.pin === pin.pin);
    out.push(
      contactSpec(
        entity.id,
        'plug',
        pin.pin,
        terminalOf(own, pin.terminal),
        slot === undefined ? -1 : terminalOf(host, slot.terminal),
        values,
      ),
    );
  }
}

/** `spec`'s {@link PlacedContact}, rewritten for this compile. */
function placeContact(spec: ContactSpec, a: number, b: number): PlacedContact {
  const placed = spec.placed;
  if (placed === null) return (spec.placed = { spec, a, b });
  placed.a = a;
  placed.b = b;
  return placed;
}

/** `cached`'s {@link PlacedConnection}, rewritten for this compile. */
function placeConnection(
  cached: ConnectionCacheEntry,
  result: ConnectionElementResult,
  a: number,
  b: number,
): PlacedConnection {
  const placed = cached.placed;
  if (placed === null) return (cached.placed = { id: cached.connection.id, result, a, b });
  placed.result = result;
  placed.a = a;
  placed.b = b;
  return placed;
}

/** A connection slot's state in the open-toggle path's record (`toggleOnly`). */
const SLOT_ABSENT = 0;
const SLOT_PRESENT = 1;
const SLOT_OPEN = 2;

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
  if (entry === null || entry.placed === null) return ABSENT_END;
  return terminal < 0 ? -1 : entry.base + terminal;
}

const NO_SIM: StateBag = Object.freeze({});

/**
 * The connection sim keys whose `true` opens the connection: only a conductor's sticky `fused` (ADR 0018,
 * open for good). Any other boolean a model lists in `simTopologyKeys` opens nothing until it is added
 * here, so a future flag can't silently take a connection out of the netlist.
 */
export const CONNECTION_OPEN_FLAG_KEYS: readonly string[] = Object.freeze(['fused']);

/**
 * Whether one topology key's value opens a connection: an end state that is `intermittentOpen`, or a
 * key of {@link CONNECTION_OPEN_FLAG_KEYS} that is `true`.
 */
export function connectionKeyOpens(key: string, value: unknown): boolean {
  if (value === 'intermittentOpen') return true;
  if (value !== true) return false;
  for (let i = 0; i < CONNECTION_OPEN_FLAG_KEYS.length; i++) if (CONNECTION_OPEN_FLAG_KEYS[i] === key) return true;
  return false;
}

/** Whether a connection's sim state opens it, read through its model's `simTopologyKeys` ({@link connectionKeyOpens}). */
function openEnd(model: ConnectionNetlistModel, sim: Readonly<Record<string, unknown>>): boolean {
  const keys = model.simTopologyKeys;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (connectionKeyOpens(key, sim[key])) return true;
  }
  return false;
}

/**
 * A sim topology key's value projected to a boolean (ADR 0019 "Sim and commanded state keys"): `true`
 * unless it is `false`, `null` or missing, so a since-tick is "null or not" and a flag is itself.
 */
export function simTopologyFlag(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined;
}

/** The most sim topology keys a model may list: one bit each in the structure code. */
export const MAX_SIM_TOPOLOGY_KEYS = 30;

/**
 * An entity's sim topology keys as a number (engine 8, the non-allocating structure code): bit k set
 * when key k of `simTopologyKeys` projects to `true`. Read through `options.simValue` (no bag built),
 * else `options.sim`, else the world's bag. Equal codes, equal topology inputs.
 */
function simCodeOf(model: DeviceNetlistModel, entity: Entity, options: CompileOptions): number {
  const keys = model.simTopologyKeys;
  if (keys.length === 0) return 0;
  if (keys.length > MAX_SIM_TOPOLOGY_KEYS) {
    throw new Error(`netlist model ${model.kind}: at most ${MAX_SIM_TOPOLOGY_KEYS} sim topology keys`);
  }
  let code = 0;
  if (options.simValue !== undefined) {
    for (let k = 0; k < keys.length; k++) {
      let value: unknown = options.simValue(entity.id, keys[k]);
      if (value === undefined) value = ownValue(entity.sim, keys[k]);
      if (simTopologyFlag(value)) code |= 1 << k;
    }
    return code;
  }
  const sim = options.sim?.(entity.id) ?? entity.sim;
  for (let k = 0; k < keys.length; k++) if (simTopologyFlag(ownValue(sim, keys[k]))) code |= 1 << k;
  return code;
}

const ownValue = (bag: StateBag, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : null;

/** What a model's `topology` sees of its sim topology keys: each key's boolean projection, from the code. */
function simTopologyView(model: DeviceNetlistModel, code: number): StateBag {
  if (model.simTopologyKeys.length === 0) return NO_SIM;
  const view: Record<string, boolean> = {};
  model.simTopologyKeys.forEach((key, k) => (view[key] = (code & (1 << k)) !== 0));
  return view;
}

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
  wiring = false,
): DeviceFragment {
  const input = { params, state, sim };
  const topology = wiring && model.wiring !== undefined ? model.wiring(input) : model.topology(input);
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
  const earth = [...(topology.earth ?? [])]
    .sort((x, y) => (x.contact < y.contact ? -1 : x.contact > y.contact ? 1 : 0))
    .map((link, i, sorted): EarthFragment => {
      if (!PART_PATTERN.test(link.contact) || (i > 0 && sorted[i - 1].contact === link.contact)) {
        throw new Error(`Netlist model ${model.kind} has an invalid or repeated earth contact "${link.contact}"`);
      }
      return { contact: link.contact, terminal: index(link.terminal), values: sortedValues(link.values) };
    });
  return { kind: model.kind, terminals, joins, elements, earth: earth.length === 0 ? NO_EARTH : earth };
}

const NO_EARTH: readonly EarthFragment[] = Object.freeze([]);

/** A fragment's structure without its values. */
function fragmentKey(fragment: DeviceFragment): string {
  const key = [
    fragment.kind,
    fragment.terminals.join(','),
    fragment.joins.map((group) => group.join(',')).join(';'),
    fragment.elements.map((e) => `${e.part}:${e.kind}:${e.source ?? '-'}:${e.a}:${e.b}`).join(';'),
  ];
  if (fragment.earth.length > 0) key.push(fragment.earth.map((e) => `${e.contact}:${e.terminal}`).join(';'));
  return key.join('|');
}

/** The union-find `deviceParts` partitions one device's terminals with (reset for each device). */
const LOCAL_SETS = new UnionFind(0);

/** Entity `entity`'s {@link DeviceParts}: its members, element refs, local nodes and device entry. */
function deviceParts(entity: number, fragment: DeviceFragment): DeviceParts {
  const terminals = fragment.terminals;
  const count = terminals.length;
  const members: TerminalRef[] = [];
  const localNode: number[] = [];
  const nodeMembers: TerminalRef[][] = [];
  for (let i = 0; i < count; i++) members.push({ entity, terminal: terminals[i] });
  if (fragment.joins.length === 0) {
    // No joins (a battery, a lamp, an open switch): one node per terminal.
    for (let i = 0; i < count; i++) {
      localNode.push(i);
      nodeMembers.push([members[i]]);
    }
  } else {
    const sets = LOCAL_SETS;
    sets.reset(count);
    for (const group of fragment.joins) {
      for (let i = 1; i < group.length; i++) sets.union(group[0], group[i]);
    }
    // Local nodes, numbered as their smallest terminal is reached (as `assemble` numbers plant nodes).
    const localOfRoot: number[] = [];
    for (let i = 0; i < count; i++) localOfRoot.push(-1);
    for (let i = 0; i < count; i++) {
      const root = sets.find(i);
      if (localOfRoot[root] < 0) {
        localOfRoot[root] = nodeMembers.length;
        nodeMembers.push([]);
      }
      localNode.push(localOfRoot[root]);
      nodeMembers[localOfRoot[root]].push(members[i]);
    }
  }
  return {
    fragment,
    elementRefs: fragment.elements.map((e) => ({ kind: 'entity', entity, part: e.part })),
    localNode,
    nodeMembers,
    device: { entity, kind: fragment.kind },
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
  contacts: readonly PlacedContact[],
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
  for (const contact of contacts) visit(contact.spec.values);
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
 * (F2.2 part 3b): the union-find over nodes, the per-terminal, per-node, per-island and per-branch
 * index arrays and the encoding buffer. They grow to the largest plant seen and never shrink. Nothing
 * in a returned netlist refers to them.
 */
class AssembleScratch {
  readonly nodeSets = new UnionFind(0);
  readonly writer = new TopologyWriter();
  nodeOfTerminal = new Int32Array(0);
  endA = new Int32Array(0);
  endB = new Int32Array(0);
  islandOfRoot = new Int32Array(0);
  islandOfNode = new Int32Array(0);
  /** Per island, its node and branch counts, then the fill cursors of its lists (`partitionIslands`). */
  islandNodeCount = new Int32Array(0);
  islandBranchCount = new Int32Array(0);
  /**
   * The SHA-256 midstate of the writer's node section (whole blocks only) and how many bytes it covers,
   * for `reassemble`; `null` after every full `assemble` (its nodes may differ).
   */
  nodesState: Int32Array | null = null;
  nodesStateBytes = 0;
}

/**
 * The islands of `nodeCount` nodes over the `branchCount` branches whose ends are in `scratch.endA` and
 * `scratch.endB`: connected components numbered by their smallest node, as `[nodes, branches]`, each
 * island's list ascending and allocated at its final length. Writes `scratch.islandOfNode`.
 */
function partitionIslands(
  scratch: AssembleScratch,
  nodeCount: number,
  branchCount: number,
): readonly [number[][], number[][]] {
  const { endA, endB, nodeSets } = scratch;
  nodeSets.reset(nodeCount);
  for (let i = 0; i < branchCount; i++) nodeSets.union(endA[i], endB[i]);
  const islandOfRoot = (scratch.islandOfRoot = atLeast(scratch.islandOfRoot, nodeCount));
  islandOfRoot.fill(-1, 0, nodeCount);
  const islandOfNode = (scratch.islandOfNode = atLeast(scratch.islandOfNode, nodeCount));
  const nodeTally = (scratch.islandNodeCount = atLeast(scratch.islandNodeCount, nodeCount));
  const branchTally = (scratch.islandBranchCount = atLeast(scratch.islandBranchCount, nodeCount));
  let islandCount = 0;
  for (let node = 0; node < nodeCount; node++) {
    const root = nodeSets.find(node);
    let island = islandOfRoot[root];
    if (island < 0) {
      island = islandCount++;
      islandOfRoot[root] = island;
      nodeTally[island] = 0;
      branchTally[island] = 0;
    }
    islandOfNode[node] = island;
    nodeTally[island]++;
  }
  for (let i = 0; i < branchCount; i++) branchTally[islandOfNode[endA[i]]]++;
  const nodes = new Array<number[]>(islandCount);
  const branches = new Array<number[]>(islandCount);
  for (let k = 0; k < islandCount; k++) {
    nodes[k] = new Array<number>(nodeTally[k]);
    branches[k] = new Array<number>(branchTally[k]);
    nodeTally[k] = 0;
    branchTally[k] = 0;
  }
  for (let node = 0; node < nodeCount; node++) {
    const k = islandOfNode[node];
    nodes[k][nodeTally[k]++] = node;
  }
  for (let i = 0; i < branchCount; i++) {
    const k = islandOfNode[endA[i]];
    branches[k][branchTally[k]++] = i;
  }
  return [nodes, branches];
}

/**
 * The islands' records, classified by the sources on their branches (`mixed` islands are diagnosed).
 * Only entity elements can be sources (a connection's branch is passive), and they are the first
 * `deviceBranchCount` branches, so each island's ascending list is read only that far.
 */
function islandRecords(
  islandNodes: number[][],
  islandBranches: number[][],
  branches: readonly NetlistBranch[],
  deviceBranchCount: number,
  diagnostics: NetlistDiagnostic[],
): NetlistIsland[] {
  const islands = new Array<NetlistIsland>(islandNodes.length);
  for (let k = 0; k < islandNodes.length; k++) {
    const own = islandBranches[k];
    let dc = false;
    let ac = false;
    for (let j = 0; j < own.length && own[j] < deviceBranchCount; j++) {
      const source = branches[own[j]].source;
      if (source === 'dc') dc = true;
      else if (source === 'ac') ac = true;
    }
    const kind: IslandKind = dc && ac ? 'mixed' : dc ? 'dc' : ac ? 'ac' : 'empty';
    if (kind === 'mixed') diagnostics.push({ code: 'mixed-island', island: k });
    islands[k] = { index: k, kind, nodes: islandNodes[k], branches: own };
  }
  return islands;
}

/** A contact's branch (engine 8): a `contact`-model resistor of its spec's `resistanceOhm`, dependent → host. */
function contactBranch(index: number, spec: ContactSpec, a: number, b: number, island: number): NetlistBranch {
  return {
    index,
    element: spec.ref,
    kind: 'resistor',
    model: CONTACT_MODEL,
    source: null,
    a,
    b,
    island,
    values: spec.values,
  };
}

/** Remote earth's parts: its node's member list is shared by every netlist that holds it. */
const EARTH_PARTS: DeviceParts = deviceParts(EARTH_ENTITY, EARTH_FRAGMENT);

function assemble(
  devices: readonly PlacedDevice[],
  terminalCount: number,
  connections: readonly PlacedConnection[],
  contacts: readonly PlacedContact[],
  earthUsed: boolean,
  diagnostics: NetlistDiagnostic[],
  scratch: AssembleScratch,
): Netlist {
  // Nodes: each device's own nodes in turn. Only a device's ideal joins merge terminals, so this
  // numbers plant nodes as their smallest member is reached in canonical terminal order, and each
  // node's members are the device's shared list (`DeviceParts.localNode`). Remote earth, when an earth
  // link reaches it, is entity 0's one terminal: plant terminal 0 and node 0 (engine 8).
  const nodeOfTerminal = (scratch.nodeOfTerminal = atLeast(scratch.nodeOfTerminal, terminalCount));
  let nodeCount = earthUsed ? 1 : 0;
  let deviceBranchCount = 0;
  for (let d = 0; d < devices.length; d++) {
    const parts = devices[d].parts;
    nodeCount += parts.nodeMembers.length;
    deviceBranchCount += parts.fragment.elements.length;
  }
  const branchCount = deviceBranchCount + connections.length + contacts.length;
  const members = new Array<readonly TerminalRef[]>(nodeCount);
  let nodeBase = 0;
  if (earthUsed) {
    nodeOfTerminal[EARTH_PLANT_TERMINAL] = 0;
    members[0] = EARTH_PARTS.nodeMembers[0];
    nodeBase = 1;
  }
  for (let d = 0; d < devices.length; d++) {
    const { parts, base } = devices[d];
    const local = parts.localNode;
    for (let i = 0; i < local.length; i++) nodeOfTerminal[base + i] = nodeBase + local[i];
    const own = parts.nodeMembers;
    for (let l = 0; l < own.length; l++) members[nodeBase + l] = own[l];
    nodeBase += own.length;
  }

  // Branch ends as nodes, in canonical branch order: entity elements, then connections.
  const endA = (scratch.endA = atLeast(scratch.endA, branchCount));
  const endB = (scratch.endB = atLeast(scratch.endB, branchCount));
  let index = 0;
  for (let d = 0; d < devices.length; d++) {
    const { parts, base } = devices[d];
    const elements = parts.fragment.elements;
    for (let j = 0; j < elements.length; j++) {
      endA[index] = nodeOfTerminal[base + elements[j].a];
      endB[index++] = nodeOfTerminal[base + elements[j].b];
    }
  }
  for (let j = 0; j < connections.length; j++) {
    endA[index] = nodeOfTerminal[connections[j].a];
    endB[index++] = nodeOfTerminal[connections[j].b];
  }
  for (let j = 0; j < contacts.length; j++) {
    endA[index] = nodeOfTerminal[contacts[j].a];
    endB[index++] = nodeOfTerminal[contacts[j].b];
  }

  // Islands: connected components of the nodes over the branches, numbered by their smallest node.
  const [islandNodes, islandBranches] = partitionIslands(scratch, nodeCount, branchCount);
  const islandOfNode = scratch.islandOfNode;

  const nodes: NetlistNode[] = new Array<NetlistNode>(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodes[i] = { index: i, island: islandOfNode[i], members: members[i] };
  const branches: NetlistBranch[] = new Array<NetlistBranch>(branchCount);
  index = 0;
  for (let d = 0; d < devices.length; d++) {
    const { fragment, elementRefs } = devices[d].parts;
    for (let j = 0; j < fragment.elements.length; j++) {
      const e = fragment.elements[j];
      const a = endA[index];
      branches[index] = {
        index,
        element: elementRefs[j],
        kind: e.kind,
        model: fragment.kind,
        source: e.source,
        a,
        b: endB[index],
        island: islandOfNode[a],
        values: e.values,
      };
      index++;
    }
  }
  for (let j = 0; j < connections.length; j++) {
    const result = connections[j].result;
    const a = endA[index];
    branches[index] = {
      index,
      element: result.elementRef,
      kind: result.kind,
      model: result.model,
      source: null,
      a,
      b: endB[index],
      island: islandOfNode[a],
      values: result.values,
    };
    index++;
  }
  for (let j = 0; j < contacts.length; j++) {
    const a = endA[index];
    branches[index] = contactBranch(index, contacts[j].spec, a, endB[index], islandOfNode[a]);
    index++;
  }

  const islands = islandRecords(islandNodes, islandBranches, branches, deviceBranchCount, diagnostics);
  const deviceList = new Array<NetlistDevice>(devices.length);
  for (let d = 0; d < devices.length; d++) deviceList[d] = devices[d].parts.device;
  scratch.nodesState = null;
  return {
    nodes,
    branches,
    islands,
    devices: deviceList,
    topologyHash: toHex(sha256(scratch.writer.encode(nodes, branches))),
    diagnostics,
  };
}

/**
 * `assemble`'s result for the previous netlist's partition with another set of connection branches
 * (`toggleOnly`, F3.6 part 2): the nodes' members, the entity branches and every connection's plant
 * terminals are the previous compile's, so only the branch list, the islands (re-partitioned over the
 * new branches, numbered by their smallest node as `assemble` numbers them) and the hash are redone.
 * Node and branch objects whose fields didn't change are reused. `scratch.nodeOfTerminal` still maps
 * plant terminals to nodes: only `assemble` writes it, and the partition is unchanged since.
 */
function reassemble(
  previous: Netlist,
  deviceBranchCount: number,
  connections: readonly PlacedConnection[],
  contacts: readonly PlacedContact[],
  diagnostics: NetlistDiagnostic[],
  scratch: AssembleScratch,
): Netlist {
  const nodeCount = previous.nodes.length;
  const contactBase = deviceBranchCount + connections.length;
  const branchCount = contactBase + contacts.length;
  const endA = (scratch.endA = atLeast(scratch.endA, branchCount));
  const endB = (scratch.endB = atLeast(scratch.endB, branchCount));
  const before = previous.branches;
  for (let i = 0; i < deviceBranchCount; i++) {
    endA[i] = before[i].a;
    endB[i] = before[i].b;
  }
  const nodeOfTerminal = scratch.nodeOfTerminal;
  for (let j = 0; j < connections.length; j++) {
    endA[deviceBranchCount + j] = nodeOfTerminal[connections[j].a];
    endB[deviceBranchCount + j] = nodeOfTerminal[connections[j].b];
  }
  // Contacts (engine 8) keep their ends: a toggle changes only which connections are open.
  const previousContactBase = before.length - contacts.length;
  for (let j = 0; j < contacts.length; j++) {
    endA[contactBase + j] = before[previousContactBase + j].a;
    endB[contactBase + j] = before[previousContactBase + j].b;
  }

  // Islands, exactly as `assemble` builds them.
  const [islandNodes, islandBranches] = partitionIslands(scratch, nodeCount, branchCount);
  const islandOfNode = scratch.islandOfNode;

  const nodes: NetlistNode[] = new Array<NetlistNode>(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const old = previous.nodes[i];
    nodes[i] = old.island === islandOfNode[i] ? old : { index: i, island: islandOfNode[i], members: old.members };
  }
  const branches: NetlistBranch[] = new Array<NetlistBranch>(branchCount);
  for (let i = 0; i < deviceBranchCount; i++) {
    const old = before[i];
    const island = islandOfNode[endA[i]];
    branches[i] = old.island === island ? old : { ...old, island };
  }
  let p = deviceBranchCount;
  for (let j = 0; j < connections.length; j++) {
    const { id, result } = connections[j];
    const i = deviceBranchCount + j;
    const island = islandOfNode[endA[i]];
    // The previous branch of the same connection, if it had one (both lists ascend by connection id).
    let old: NetlistBranch | null = null;
    while (p < previousContactBase) {
      const element = before[p].element;
      const at = element.kind === 'connection' ? element.connection : -1;
      if (at > id) break;
      p++;
      if (at === id) {
        old = before[p - 1];
        break;
      }
    }
    branches[i] =
      old !== null && old.index === i && old.island === island && old.values === result.values
        ? old
        : {
            index: i,
            element: result.elementRef,
            kind: result.kind,
            model: result.model,
            source: null,
            a: endA[i],
            b: endB[i],
            island,
            values: result.values,
          };
  }
  for (let j = 0; j < contacts.length; j++) {
    const i = contactBase + j;
    const old = before[previousContactBase + j];
    const island = islandOfNode[endA[i]];
    branches[i] =
      old.index === i && old.island === island ? old : contactBranch(i, contacts[j].spec, endA[i], endB[i], island);
  }

  const islands = islandRecords(islandNodes, islandBranches, branches, deviceBranchCount, diagnostics);
  // The node section is the previous encoding's: rewrite only the branches, and resume the hash from
  // the node section's midstate (computed once per partition).
  const bytes = scratch.writer.encodeBranches(branches);
  if (scratch.nodesState === null) {
    const [state, covered] = sha256Prefix(bytes, scratch.writer.nodesEnd);
    scratch.nodesState = state;
    scratch.nodesStateBytes = covered;
  }
  return {
    nodes,
    branches,
    islands,
    devices: previous.devices,
    topologyHash: toHex(sha256Finish(scratch.nodesState, bytes, scratch.nodesStateBytes)),
    diagnostics,
  };
}
