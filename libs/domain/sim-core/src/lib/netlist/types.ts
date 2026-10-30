import type { DeviceStateValue } from '@controls/save-format';

/*
 * The compiled netlist (plan F2.1, ADR 0011 §7, ADR 0013): what the solvers (F2.2), the engine
 * (F2.3a), the topology descriptor (F2.3b) and `netlist.dump` (F2.6) read. Plain, frozen-shape data:
 * no classes, no Maps, so two netlists compare with deep equality and the incremental compiler can be
 * checked against a from-scratch compile.
 *
 * Every order in it is canonical, a pure function of the world (never of the edit history):
 *
 * - **nodes** are numbered by their smallest member terminal, ordered by entity id (numerically), then
 *   terminal id (UTF-16 code units);
 * - **branches** are entity elements first, by entity id then part (code units), then connections by id;
 * - **islands** are numbered by their smallest node.
 *
 * That order is the order of `WorldV2.sim.nodes` and `branches` and of the snapshot payload.
 */

/** One terminal of an entity, as in world v2 (`TerminalRefV2`) and the descriptor (ADR 0011 §7). */
export interface TerminalRef {
  readonly entity: number;
  readonly terminal: string;
}

/** What a branch stands for (ADR 0011 §7's `ElementRef`): a device's internal element or a connection. */
export type ElementRef =
  | { readonly kind: 'entity'; readonly entity: number; readonly part: string }
  | { readonly kind: 'connection'; readonly connection: number };

/**
 * How the solver stamps a branch (F2.2). Part of the topology:
 *
 * - `resistor`: a two-terminal resistance (a lead, a lamp filament). Its value may come from sim-owned
 *   state at solve time (the filament's R(T), F2.5), so it need not be in `values`;
 * - `vsource`: a voltage source from `a` (negative) to `b` (positive) behind a series resistance (a
 *   battery cell, F2.4). Its EMF may come from sim-owned state (state of charge).
 */
export type ElementKind = 'resistor' | 'vsource';

/** The kind of supply a source element is: islands are classified by the sources they hold. */
export type SourceDomain = 'dc' | 'ac';

/** An island's classification: by its sources (none, DC only, AC only, or both). */
export type IslandKind = 'empty' | 'dc' | 'ac' | 'mixed';

/** A node: terminals joined ideally (by a closed switch or inside a device). Never empty. */
export interface NetlistNode {
  readonly index: number;
  readonly island: number;
  /** Member terminals in canonical order; `members[0]` is the terminal the node is numbered by. */
  readonly members: readonly TerminalRef[];
}

/** A branch: one element between two nodes. `a` may equal `b` (a lead across a closed switch). */
export interface NetlistBranch {
  readonly index: number;
  readonly element: ElementRef;
  readonly kind: ElementKind;
  /** The catalogue model kind the element belongs to (`battery`, `lead`, …). Part of the topology. */
  readonly model: string;
  /** For a source element, what it supplies; `null` for passive elements. */
  readonly source: SourceDomain | null;
  /** The node at the element's end `a`; for a connection, `connection.a`'s node. Current is positive from `a` to `b`. */
  readonly a: number;
  readonly b: number;
  readonly island: number;
  /**
   * The values the compiler derives from the catalogue entry and commanded state (a lead's
   * `resistanceOhm`), keys sorted. Never part of `topologyHash`. Values a device model computes from
   * sim-owned state at solve time (a battery's EMF, a filament's resistance) are not here.
   */
  readonly values: Readonly<Record<string, number>>;
}

/** A connected component of nodes and branches. Solved independently (F2.2). */
export interface NetlistIsland {
  readonly index: number;
  readonly kind: IslandKind;
  /** Node indices, ascending. `nodes[0]` is the node the island is numbered by. */
  readonly nodes: readonly number[];
  /** Branch indices, ascending. */
  readonly branches: readonly number[];
}

/** A netlisted entity: one whose device the catalogue and the compiler know. */
export interface NetlistDevice {
  readonly entity: number;
  /** Its catalogue model kind. */
  readonly kind: string;
}

/** Why a connection is left out of the netlist. */
export type AbsentConnectionReason =
  /** Its ref isn't in the catalogue (a missing mod's lead). */
  | 'unknown-ref'
  /** Its ref is a catalogue entry but not a connection kind. */
  | 'not-a-connection'
  /** sim-core has no netlist model for its connection kind. */
  | 'no-model'
  /** An end is on an entity that isn't netlisted (a prop, an unknown device, a missing entity). */
  | 'absent-end'
  /** An end names a terminal its device doesn't have. */
  | 'unknown-terminal';

/** Something the compiler noticed. Deterministic order: entities, connections, islands, each ascending. */
export type NetlistDiagnostic =
  /** An entity whose ref the catalogue doesn't know: absent from the netlist (ADR 0013). */
  | { readonly code: 'unknown-device'; readonly entity: number }
  /** An entity of a known model kind that sim-core can't netlist: absent. */
  | { readonly code: 'no-model'; readonly entity: number; readonly kind: string }
  /** A connection left out of the netlist. */
  | { readonly code: 'absent-connection'; readonly connection: number; readonly reason: AbsentConnectionReason }
  /** An island with both DC and AC sources; P2 has no converters (plan F2.1). */
  | { readonly code: 'mixed-island'; readonly island: number };

/** The compiled netlist of an as-built world. */
export interface Netlist {
  readonly nodes: readonly NetlistNode[];
  readonly branches: readonly NetlistBranch[];
  readonly islands: readonly NetlistIsland[];
  /** Netlisted entities, entity id ascending (the descriptor's device list draws on it). */
  readonly devices: readonly NetlistDevice[];
  /** SHA-256 of the canonical structure, without values (lower-case hex). See `topologyText`. */
  readonly topologyHash: string;
  readonly diagnostics: readonly NetlistDiagnostic[];
}

/** A device state bag, as the world holds it. */
export type StateBag = Readonly<Record<string, DeviceStateValue>>;
