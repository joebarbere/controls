import type { Catalog } from '@controls/catalog';
import { MAX_ROUTE_WAYPOINTS } from '@controls/save-format';
import {
  type CatalogRef,
  checkConductor,
  type ConductorColour,
  findEntity,
  type RouteProposal,
  type TerminationArg,
  type Waypoint,
  type WireAddArgs,
  type World,
} from '@controls/world-model';

/*
 * The routing gesture's state machine (F3.2 part 3, ADR 0017 §9, ADR 0010's measured design), pure so
 * it is unit-tested without Angular or a renderer. The UI folds the renderer's `RoutingEvent`s and the
 * `routing.*` commands into a {@link RouteGesture}; completing a route yields the arguments of exactly
 * one `wire.add`, taken from the proposal the renderer previewed (`proposeRoute`), so what was drawn
 * is what is logged. Nothing here touches the world.
 *
 * - The spool (a conductor on the active tool-belt slot) arms the gesture.
 * - The first terminal pick sets `from` (above Trainee with its termination, from the prompt); clicks
 *   off every terminal after it add waypoints.
 * - The second terminal pick completes: one `wire.add {ref, a, b, route, lengthMm, colour, tool}`, then
 *   the gesture starts over with the spool still armed (ADR 0010: the spool is kept for the next wire).
 * - Back (Backspace) removes the last waypoint, else un-picks `from`.
 * - Cancel (Escape) drops a route in progress; with none it puts the spool away.
 */

/** A terminal the gesture holds (an end argument's entity and terminal). */
export interface GestureTerminal {
  readonly entity: number;
  readonly terminal: string;
}

/** The route in progress. */
export interface RouteGesture {
  /** The first terminal, or `null` before the first pick. */
  readonly from: GestureTerminal | null;
  /** Waypoints picked so far, in order. */
  readonly waypoints: readonly Waypoint[];
  /**
   * How the first terminal lands (F3.3 part 2): the prompt's `TerminationArgs` above Trainee; absent
   * (or `'auto'`) at Trainee.
   */
  readonly fromTermination?: TerminationArg;
}

export const IDLE_GESTURE: RouteGesture = { from: null, waypoints: [] };

/** A routable spool: a conductor on the belt, with the colour and the size the gesture logs with. */
export interface Spool {
  readonly ref: CatalogRef;
  readonly title: string;
  /** The conductor entry's first colour (a colour picker is a follow-up). */
  readonly colour: ConductorColour;
  readonly awg: number;
}

/** The spool `ref` makes, or `null` when it isn't a routable conductor (a cable or a test lead, for now). */
export function spoolOf(catalog: Catalog, ref: CatalogRef | null): Spool | null {
  if (ref === null) return null;
  const entry = checkConductor(catalog, ref);
  if (!entry.ok) return null;
  const colour = entry.value.spec.colours[0];
  if (!colour) return null;
  return { ref, title: entry.value.device.title, colour: { ...colour }, awg: entry.value.spec.awg };
}

/** Most waypoints a route between two landed ends may hold (`checkRoute`: waypoints plus landed ends). */
export const MAX_GESTURE_WAYPOINTS = MAX_ROUTE_WAYPOINTS - 2;

const sameTerminal = (a: GestureTerminal | null, b: GestureTerminal | null): boolean =>
  a !== null && b !== null && a.entity === b.entity && a.terminal === b.terminal;

/** What one step of the gesture did, for the UI to announce (and, for `complete`, to execute). */
export type GestureStep =
  | { readonly kind: 'from'; readonly gesture: RouteGesture; readonly end: GestureTerminal }
  | {
      readonly kind: 'complete';
      /** The gesture after the command succeeds (started over, spool kept). */
      readonly gesture: RouteGesture;
      readonly args: WireAddArgs;
      readonly lengthMm: number;
    }
  | { readonly kind: 'waypoint'; readonly gesture: RouteGesture; readonly waypoint: Waypoint }
  | { readonly kind: 'removedWaypoint'; readonly gesture: RouteGesture; readonly left: number }
  | { readonly kind: 'clearedFrom'; readonly gesture: RouteGesture; readonly end: GestureTerminal }
  | { readonly kind: 'cancelled'; readonly gesture: RouteGesture }
  /** The first terminal's device (or terminal) left the world: the route starts over. */
  | { readonly kind: 'fromRemoved'; readonly gesture: RouteGesture; readonly end: GestureTerminal }
  | { readonly kind: 'putAway'; readonly gesture: RouteGesture }
  /** Nothing changed, and the player should hear why (`message`), or nothing at all (`null`). */
  | { readonly kind: 'refused'; readonly gesture: RouteGesture; readonly code: string; readonly message: string }
  | { readonly kind: 'ignored'; readonly gesture: RouteGesture };

/** The tool the gesture cuts with (`ActiveTool.toolFor('cut', awg)`), or `null` when nothing can cut it. */
export type CutterRef = CatalogRef | null;

/**
 * A terminal pick. Before `from`: it becomes `from`, landing by `termination`. After: the route to it,
 * `proposal` (the renderer's `proposeRoute` with the gesture's waypoints), completes the gesture with
 * one `wire.add`, end a landing by the gesture's `fromTermination` and end b by `termination`; a
 * proposal the command would refuse is refused here with its reason, and the gesture keeps its picks.
 */
export function pickTerminal(
  gesture: RouteGesture,
  end: GestureTerminal,
  proposal: RouteProposal | null,
  spool: Spool,
  cutter: CutterRef,
  termination: TerminationArg = 'auto',
): GestureStep {
  if (gesture.from === null) {
    const from = { entity: end.entity, terminal: end.terminal };
    const next: RouteGesture =
      termination === 'auto' ? { from, waypoints: [] } : { from, waypoints: [], fromTermination: termination };
    return { kind: 'from', gesture: next, end: from };
  }
  if (sameTerminal(gesture.from, end)) {
    return { kind: 'refused', gesture, code: 'same-terminal', message: 'That is the first terminal: pick another' };
  }
  if (proposal === null) return { kind: 'ignored', gesture };
  if (!proposal.ok) return { kind: 'refused', gesture, code: proposal.code, message: proposal.message };
  if (cutter === null) {
    return { kind: 'refused', gesture, code: 'wrong-tool', message: `No tool can cut ${spool.title}` };
  }
  const args: WireAddArgs = {
    ref: { ...spool.ref },
    a: {
      entity: gesture.from.entity,
      terminal: gesture.from.terminal,
      termination: structuredClone(gesture.fromTermination ?? 'auto'),
    },
    b: { entity: end.entity, terminal: end.terminal, termination: structuredClone(termination) },
    route: proposal.route.map((w) => structuredClone(w)),
    lengthMm: proposal.lengthMm,
    colour: { ...spool.colour },
    tool: { ...cutter },
  };
  return { kind: 'complete', gesture: IDLE_GESTURE, args, lengthMm: proposal.lengthMm };
}

/** A click off every terminal after the first pick: a waypoint (already snapped by the renderer). */
export function addWaypoint(gesture: RouteGesture, waypoint: Waypoint): GestureStep {
  if (gesture.from === null) return { kind: 'ignored', gesture };
  if (gesture.waypoints.length >= MAX_GESTURE_WAYPOINTS) {
    return {
      kind: 'refused',
      gesture,
      code: 'too-many-waypoints',
      message: `A route holds at most ${MAX_GESTURE_WAYPOINTS} waypoints`,
    };
  }
  return { kind: 'waypoint', gesture: { ...gesture, waypoints: [...gesture.waypoints, waypoint] }, waypoint };
}

/** Back (Backspace): the last waypoint, else the first terminal. */
export function stepBack(gesture: RouteGesture): GestureStep {
  if (gesture.waypoints.length > 0) {
    const waypoints = gesture.waypoints.slice(0, -1);
    return { kind: 'removedWaypoint', gesture: { ...gesture, waypoints }, left: waypoints.length };
  }
  if (gesture.from !== null) return { kind: 'clearedFrom', gesture: IDLE_GESTURE, end: gesture.from };
  return { kind: 'ignored', gesture };
}

/** Cancel (Escape): a route in progress is dropped (the spool stays armed); with none, the spool is put away. */
export function cancelGesture(gesture: RouteGesture): GestureStep {
  if (gesture.from !== null || gesture.waypoints.length > 0) return { kind: 'cancelled', gesture: IDLE_GESTURE };
  return { kind: 'putAway', gesture: IDLE_GESTURE };
}

/** Whether `end` is still a terminal in `world` (its entity exists and its catalogue entry has it). */
export function terminalExists(world: World, catalog: Catalog, end: GestureTerminal): boolean {
  const entity = findEntity(world, end.entity);
  const device = entity ? catalog.device(entity.ref) : undefined;
  return device?.terminals.some((t) => t.id === end.terminal) ?? false;
}

/**
 * After a world change: a route whose first terminal is gone (an undone `entity.place`, a delete from
 * the console) starts over, rather than holding a `from` no `wire.add` could land.
 */
export function dropMissingFrom(gesture: RouteGesture, world: World, catalog: Catalog): GestureStep {
  if (gesture.from === null || terminalExists(world, catalog, gesture.from)) return { kind: 'ignored', gesture };
  return { kind: 'fromRemoved', gesture: IDLE_GESTURE, end: gesture.from };
}

/** `Screw-clamp feed-through terminal block, … #3, terminal 1`: a terminal as the player reads it. */
export function describeTerminal(world: World, catalog: Catalog, end: GestureTerminal): string {
  const entity = findEntity(world, end.entity);
  const device = entity ? catalog.device(entity.ref) : undefined;
  const terminal = device?.terminals.find((t) => t.id === end.terminal);
  const label = terminal?.label ?? end.terminal;
  return `${device?.title ?? 'entity'} #${end.entity}, terminal ${label}`;
}

/** `duct waypoint`, `free waypoint`, …: a waypoint's kind in words. */
export function describeWaypoint(waypoint: Waypoint): string {
  return `${waypoint.kind} waypoint`;
}
