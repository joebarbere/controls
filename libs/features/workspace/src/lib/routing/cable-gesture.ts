import type { Catalog } from '@controls/catalog';
import type { AnyCommandDef } from '@controls/commands';
import {
  boreNeedsNailPlate,
  cableEndPoint,
  type CableAddArgs,
  type CatalogRef,
  checkCableEnd,
  checkCableSupport,
  checkConductor,
  defaultTailsMm,
  enclosureOnStudWall,
  findEntity,
  inFraming,
  type PositionMm,
  routeDefaultLengthMm,
  type Waypoint,
  type World,
} from '@controls/world-model';
import { MAX_GESTURE_WAYPOINTS } from './routing-gesture';

/*
 * The cable gesture's state machine (F3.2 part 4, ADR 0015 "CableV3", ADR 0017), pure so it is
 * unit-tested without Angular or a renderer. A cable spool (an assembly on the active belt slot) arms
 * it; the first enclosure entry picked starts the run; clicks off every enclosure add waypoints
 * (staples, bores, ducts, as `snapWaypoint` snapped them in the renderer); the far entry completes it
 * with exactly one `cable.add {ref, a, b, route, lengthMm, tailsMm, tool}`, the default tails at each
 * box end (`defaultTailsMm`) and the default cut (`routeDefaultLengthMm`). Before anything is logged the
 * arguments are checked by `cable.add`'s own `run` (`precheck`), so a `staple-spacing` or `entry-full`
 * refusal is shown and the picks are kept. Nothing here touches the world.
 */

/** A routable cable assembly on the belt, with the size its cutter and stripper must reach. */
export interface CableSpool {
  readonly ref: CatalogRef;
  readonly title: string;
  /** The largest conductor's AWG (smaller is thicker): what the cutter must cut. */
  readonly awg: number;
}

/** The cable spool `ref` makes, or `null` when it isn't a cable assembly the catalogue knows. */
export function cableSpoolOf(catalog: Catalog, ref: CatalogRef | null): CableSpool | null {
  if (ref === null || catalog.family(ref) !== 'cable') return null;
  const assembly = catalog.cable(ref);
  if (!assembly) return null;
  const awgs: number[] = [];
  for (const c of assembly.conductors) {
    const entry = checkConductor(catalog, c.conductor);
    if (!entry.ok) return null;
    awgs.push(entry.value.spec.awg);
  }
  if (awgs.length === 0) return null;
  return { ref: { ...ref }, title: assembly.title, awg: Math.min(...awgs) };
}

/** An enclosure entry the gesture holds: the end argument and where it is. */
export interface EntryPick {
  readonly entity: number;
  readonly entry: string;
  readonly positionMm: PositionMm;
}

/** One entry of an enclosure, and whether a cable could enter it now (`checkCableEnd`). */
export interface EntryOption extends EntryPick {
  /** `null` when a cable may enter; else why not (`entry-closed`, `entry-full`, …). */
  readonly problem: { readonly code: string; readonly message: string } | null;
}

/**
 * Every entry of enclosure `entity` in catalogue order, each checked as `cable.add` checks an end, or
 * `null` when the entity isn't an enclosure (or can't be placed).
 */
export function enclosureEntries(world: World, catalog: Catalog, entity: number): EntryOption[] | null {
  const found = findEntity(world, entity);
  const enclosure = found ? catalog.device(found.ref)?.enclosure : undefined;
  if (!found || !enclosure) return null;
  const options: EntryOption[] = [];
  for (const entry of enclosure.entries) {
    const checked = checkCableEnd(world, catalog, { entity, entry: entry.id });
    if (checked.ok) {
      options.push({ entity, entry: entry.id, positionMm: checked.value.point.positionMm, problem: null });
    } else if (checked.code === 'entry-closed' || checked.code === 'entry-full') {
      // Still placeable: report it with its problem (the player hears why).
      const point = cableEndPoint(world, catalog, { entity, entry: entry.id });
      if (point) options.push({ entity, entry: entry.id, positionMm: point.positionMm, problem: checked });
    }
  }
  return options;
}

const distance2 = (p: PositionMm, q: PositionMm): number => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;

/**
 * The entry a click at `atMm` on an enclosure picks: the nearest entry a cable may enter (ties by
 * catalogue order), skipping `exclude`; else the nearest entry with its problem; `null` with none.
 */
export function nearestEntry(
  options: readonly EntryOption[],
  atMm: PositionMm,
  exclude: Pick<EntryPick, 'entity' | 'entry'> | null = null,
): EntryOption | null {
  const candidates = options.filter((o) => !(exclude && o.entity === exclude.entity && o.entry === exclude.entry));
  const pick = (list: readonly EntryOption[]) => {
    let best: EntryOption | null = null;
    let bestD = Infinity;
    for (const o of list) {
      const d = distance2(o.positionMm, atMm);
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  };
  return pick(candidates.filter((o) => o.problem === null)) ?? pick(candidates);
}

/** The cable run in progress. */
export interface CableGesture {
  /** The first entry, or `null` before the first pick. */
  readonly a: EntryPick | null;
  readonly waypoints: readonly Waypoint[];
}

export const IDLE_CABLE: CableGesture = { a: null, waypoints: [] };

/** What one step of the cable gesture did, for the UI to announce (and, for `complete`, to execute). */
export type CableStep =
  | { readonly kind: 'from'; readonly gesture: CableGesture; readonly entry: EntryPick }
  | {
      readonly kind: 'complete';
      /** The gesture after the command succeeds (started over, spool kept). */
      readonly gesture: CableGesture;
      readonly args: CableAddArgs;
    }
  | { readonly kind: 'waypoint'; readonly gesture: CableGesture; readonly waypoint: Waypoint }
  | { readonly kind: 'removedWaypoint'; readonly gesture: CableGesture; readonly left: number }
  | { readonly kind: 'clearedFrom'; readonly gesture: CableGesture }
  | { readonly kind: 'cancelled'; readonly gesture: CableGesture }
  | { readonly kind: 'putAway'; readonly gesture: CableGesture }
  | { readonly kind: 'refused'; readonly gesture: CableGesture; readonly code: string; readonly message: string }
  | { readonly kind: 'ignored'; readonly gesture: CableGesture };

/**
 * Pre-checks a command's arguments with the command's own schema and `run` (pure, read-only: it
 * returns a change and never applies it), so a prompt shows exactly the refusal `exec` would give.
 * `null` when it would run.
 */
export function precheck(
  def: AnyCommandDef<World> | undefined,
  world: World,
  args: unknown,
): { readonly code: string; readonly message: string } | null {
  if (!def) return { code: 'unknown-command', message: 'That command is not registered' };
  const parsed = def.args.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { code: 'bad-args', message: `${issue?.path.join('.') || 'args'}: ${issue?.message ?? 'invalid'}` };
  }
  const result = def.run({ state: world, seq: 0, tick: 0, canUndo: false, canRedo: false }, parsed.data);
  return result.ok ? null : { code: result.code, message: result.message };
}

/**
 * An entry pick. Before `a`: it becomes the first entry (refused with its problem when no cable may
 * enter it). After: the far entry completes the run with one `cable.add`, checked by `addCable` (the
 * command's own `run`); a refusal keeps the picks.
 */
export function pickEntry(
  gesture: CableGesture,
  entry: EntryOption,
  spool: CableSpool,
  cutter: CatalogRef | null,
  check: (args: CableAddArgs) => { readonly code: string; readonly message: string } | null,
): CableStep {
  if (entry.problem) return { kind: 'refused', gesture, ...entry.problem };
  const pick: EntryPick = { entity: entry.entity, entry: entry.entry, positionMm: { ...entry.positionMm } };
  if (gesture.a === null) return { kind: 'from', gesture: { a: pick, waypoints: [] }, entry: pick };
  if (gesture.a.entity === pick.entity && gesture.a.entry === pick.entry) {
    return { kind: 'refused', gesture, code: 'same-entry', message: 'That is the first entry: pick another' };
  }
  if (cutter === null)
    return { kind: 'refused', gesture, code: 'wrong-tool', message: `No tool can cut ${spool.title}` };
  const a = { entity: gesture.a.entity, entry: gesture.a.entry };
  const b = { entity: pick.entity, entry: pick.entry };
  const tailsMm = defaultTailsMm({ a, b });
  const points = [gesture.a.positionMm, ...gesture.waypoints.map((w) => w.positionMm), pick.positionMm];
  const args: CableAddArgs = {
    ref: { ...spool.ref },
    a,
    b,
    route: gesture.waypoints.map((w) => structuredClone(w)),
    lengthMm: routeDefaultLengthMm(points, undefined, tailsMm),
    tailsMm,
    tool: { ...cutter },
  };
  const refusal = check(args);
  if (refusal) return { kind: 'refused', gesture, ...refusal };
  return { kind: 'complete', gesture: IDLE_CABLE, args };
}

/** A click off every enclosure after the first entry: a waypoint (already snapped by the renderer). */
export function addCableWaypoint(gesture: CableGesture, waypoint: Waypoint): CableStep {
  if (gesture.a === null) return { kind: 'ignored', gesture };
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

/** Back (Backspace): the last waypoint, else the first entry. */
export function cableStepBack(gesture: CableGesture): CableStep {
  if (gesture.waypoints.length > 0) {
    const waypoints = gesture.waypoints.slice(0, -1);
    return { kind: 'removedWaypoint', gesture: { ...gesture, waypoints }, left: waypoints.length };
  }
  if (gesture.a !== null) return { kind: 'clearedFrom', gesture: IDLE_CABLE };
  return { kind: 'ignored', gesture };
}

/** Cancel (Escape): a run in progress is dropped (the spool stays armed); with none, the spool is put away. */
export function cancelCable(gesture: CableGesture): CableStep {
  return gesture.a !== null ? { kind: 'cancelled', gesture: IDLE_CABLE } : { kind: 'putAway', gesture: IDLE_CABLE };
}

/** After a world change: a run whose first entry is gone or full starts over. */
export function dropMissingEntry(gesture: CableGesture, world: World, catalog: Catalog): CableStep {
  if (gesture.a === null) return { kind: 'ignored', gesture };
  const checked = checkCableEnd(world, catalog, { entity: gesture.a.entity, entry: gesture.a.entry });
  if (checked.ok) return { kind: 'ignored', gesture };
  return { kind: 'refused', gesture: IDLE_CABLE, code: checked.code, message: checked.message };
}

/**
 * The support rule so far (NFPA 70 Art. 334.30 by number, `checkCableSupport`): the first gap from the
 * first entry or between supports, as the command will word it, or `null`. A run is in framing when it
 * has a staple or a bore, or its first box is on a stud wall (the far box decides the rest at the end).
 */
export function supportProblem(world: World, catalog: Catalog, gesture: CableGesture): string | null {
  if (gesture.a === null) return null;
  const framing = inFraming(gesture.waypoints) || enclosureOnStudWall(world, catalog, gesture.a.entity);
  const failure = checkCableSupport(gesture.a.positionMm, gesture.waypoints, null, framing);
  return failure ? failure.message : null;
}

/**
 * The nail-plate warning for a bore waypoint (NFPA 70 Art. 300.4(A)(1) by number, `boreNeedsNailPlate`):
 * a hole of the bit's diameter leaves less than 31.75 mm to the stud edge. Not a refusal: P3 has no
 * nail plates. `null` for any other waypoint, or a bit of unknown diameter.
 */
export function nailPlateWarning(catalog: Catalog, waypoint: Waypoint): string | null {
  if (waypoint.kind !== 'bore' || waypoint.tool === null) return null;
  const diameter = catalog.tool(waypoint.tool)?.boreDiameterMm ?? null;
  if (diameter === null || !boreNeedsNailPlate(diameter)) return null;
  return `A ${diameter} mm hole leaves less than 31.75 mm to the stud edge: a nail plate is needed to protect the cable.`;
}

/** `2-gang nonmetallic box #1, entry clamp-top-1`: an entry as the player reads it. */
export function describeEntry(world: World, catalog: Catalog, entry: Pick<EntryPick, 'entity' | 'entry'>): string {
  const entity = findEntity(world, entry.entity);
  const device = entity ? catalog.device(entity.ref) : undefined;
  return `${device?.title ?? 'entity'} #${entry.entity}, entry ${entry.entry}`;
}
