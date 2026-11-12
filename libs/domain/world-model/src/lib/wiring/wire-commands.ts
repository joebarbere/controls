import { BUILTIN_CATALOG, type Catalog, initialBags } from '@controls/catalog';
import { type AnyCommandDef, type CommandFailure, defineCommand, fail, succeed } from '@controls/commands';
import { insertSorted, isLead } from '../entity-commands';
import { findConnection } from '../lead-commands';
import type { Connection, ConnectionEnd, ConnectionId, Waypoint, World } from '../types';
import {
  WireAddArgs,
  WireDeleteArgs,
  WireLabelArgs,
  WireLandArgs,
  WirePullArgs,
  WireRerouteArgs,
  WireUnlandArgs,
} from './args';
import {
  checkColour,
  checkConductor,
  checkGeometry,
  checkLanding,
  checkRoute,
  checkTailReach,
  checkTool,
  type ConductorEntry,
  idsLeft,
  inConduit,
  type Landing,
  landedPoint,
  type RoutePoint,
  routePoints,
} from './checks';

/*
 * The conductor commands (ADR 0015, "Commands"): `wire.add`, `wire.delete`, `wire.reroute`,
 * `wire.land`, `wire.unland`, `wire.label` and `wire.pull`. A conductor is a `ConnectionV3` with a
 * length and a colour, and exactly one of its own `route` (a single conductor) or a `cable` (a cable
 * conductor, made by `cable.add`, which shares the cable's route). Each is undoable and restores every
 * id and counter on undo; none reads sim-owned state (ADR 0011 §1). The `wire.*` commands refuse a
 * test lead (`not-a-wire`); `wire.delete` and `wire.reroute` refuse a cable conductor (`in-cable`).
 *
 * Ids (ADR 0015): `wire.add` takes `nextConnectionId` and one termination id per landed end (`a`
 * then `b`); `wire.land` one termination id; `wire.pull` one connection id per conductor in order.
 * A termination's outcome is resolved here, from its own streams, and stored (D8, D9).
 */

/** Replaces connection `id` (present) with `next`. */
function replaceConnection(world: World, id: ConnectionId, next: Connection): World {
  return { ...world, connections: world.connections.map((c) => (c.id === id ? next : c)) };
}

/** An undoable change swapping connection `before` for `after` (same id), and optionally counters. */
function swap(before: Connection, after: Connection, counters: { nextTerminationId?: [number, number] } = {}) {
  const termination = counters.nextTerminationId;
  return succeed<World>({
    apply: (w) => ({
      ...replaceConnection(w, before.id, after),
      ...(termination ? { nextTerminationId: termination[1] } : {}),
    }),
    invert: (w) => ({
      ...replaceConnection(w, after.id, before),
      ...(termination ? { nextTerminationId: termination[0] } : {}),
    }),
  });
}

/** The conductor `id` names: `not-found`, a lead `not-a-wire`. */
function findWire(world: World, id: ConnectionId): Connection | CommandFailure {
  const connection = findConnection(world, id);
  if (!connection) return fail('not-found', `No wire with id ${id}`);
  if (isLead(connection)) return fail('not-a-wire', `Connection ${id} is a test lead: use the lead commands`);
  return connection;
}

const isFailure = (value: unknown): value is CommandFailure =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/** The point of a landed end of `connection` (for the route and its floor), or a refusal. */
function endPoint(world: World, catalog: Catalog, end: ConnectionEnd | null): RoutePoint | null | CommandFailure {
  if (end === null) return null;
  const point = landedPoint(world, catalog, end);
  if (point === null)
    return fail('unknown-terminal', `The catalogue can't place terminal "${end.terminal}" of entity ${end.entity}`);
  return { positionMm: point, entity: end.entity };
}

/** A free waypoint at `point`: where an unlanded end rests (ADR 0015). */
export function restWaypoint(point: { x: number; y: number; z: number }): Waypoint {
  return { kind: 'free', positionMm: { ...point }, entity: null, fixture: null, tool: null };
}

/** A copy of a route (logged args are frozen; the world gets its own objects). */
const copyRoute = (route: readonly Waypoint[]): Waypoint[] =>
  route.map((w) => ({ ...w, positionMm: { ...w.positionMm }, tool: w.tool && { ...w.tool } }));

/** A new conductor connection with its kind's initial bags. */
function newConductor(
  id: ConnectionId,
  entry: ConductorEntry,
  fields: Pick<Connection, 'a' | 'b' | 'cable' | 'route' | 'lengthMm' | 'colour'>,
): Connection {
  const bags = initialBags(entry.kind);
  return {
    id,
    ref: { ...entry.ref },
    ...fields,
    label: null,
    state: bags.state,
    sim: bags.sim,
    extensions: {},
  };
}

/**
 * `wire.add {ref, a, b, route, lengthMm, colour, tool}`: cuts a conductor of `ref` to `lengthMm` with
 * a tool that can `cut`, routes it along `route` and lands each non-null end (a then b) with its
 * termination. A route completed between two terminals is one `wire.add` (one gesture, one command,
 * one undo step); a free end rests on the route's first (or last) waypoint, of kind `free`.
 */
export function wireAddCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WireAddArgs, World>({
    id: 'wire.add',
    title: 'Add a wire',
    category: 'Wire',
    args: WireAddArgs,
    undoable: true,
    run: ({ state }, args) => {
      const id = state.nextConnectionId;
      const landedCount = (args.a ? 1 : 0) + (args.b ? 1 : 0);
      if (!idsLeft(id, 1) || !idsLeft(state.nextTerminationId, landedCount)) {
        return fail('ids-exhausted', 'No connection or termination ids left in this world');
      }
      const entry = checkConductor(catalog, args.ref);
      if (!entry.ok) return entry;
      const colour = checkColour(entry.value, args.colour);
      if (colour) return colour;
      const cutter = checkTool(catalog, args.tool, 'cut', entry.value.spec.awg);
      if (!cutter.ok) return cutter;
      const route = checkRoute(state, catalog, args.route, { a: args.a !== null, b: args.b !== null }, 'refuse');
      if (route) return route;
      if (args.a && args.b && args.a.entity === args.b.entity && args.a.terminal === args.b.terminal) {
        return fail('same-terminal', 'A wire joins two different terminals');
      }
      let terminationId = state.nextTerminationId;
      const landings: (Landing | null)[] = [];
      for (const at of [args.a, args.b]) {
        if (at === null) {
          landings.push(null);
          continue;
        }
        const landing = checkLanding(state, catalog, entry.value.spec, at, terminationId, null);
        if (!landing.ok) return landing;
        landings.push(landing.value);
        terminationId++;
      }
      const [a, b] = landings;
      const geometry = checkGeometry(
        state,
        catalog,
        routePoints(a?.point ?? null, args.route, b?.point ?? null),
        args.lengthMm,
      );
      if (geometry) return geometry;
      const connection = newConductor(id, entry.value, {
        a: a?.end ?? null,
        b: b?.end ?? null,
        cable: null,
        route: copyRoute(args.route),
        lengthMm: args.lengthMm,
        colour: { ...args.colour },
      });
      const before = state.nextTerminationId;
      return succeed({
        apply: (w) => ({
          ...w,
          nextConnectionId: id + 1,
          nextTerminationId: terminationId,
          connections: [...w.connections, connection],
        }),
        invert: (w) => ({
          ...w,
          nextConnectionId: id,
          nextTerminationId: before,
          connections: w.connections.filter((c) => c.id !== id),
        }),
      });
    },
  });
}

/** `wire.delete {id}`: removes a single conductor. Undo reinserts it with its id and terminations. */
export const wireDelete = defineCommand<WireDeleteArgs, World>({
  id: 'wire.delete',
  title: 'Delete a wire',
  category: 'Wire',
  args: WireDeleteArgs,
  undoable: true,
  run: ({ state }, { id }) => {
    const wire = findWire(state, id);
    if (isFailure(wire)) return wire;
    if (wire.cable !== null) return fail('in-cable', `Wire ${id} is in cable ${wire.cable.id}: delete the cable`);
    return succeed({
      apply: (w) => ({ ...w, connections: w.connections.filter((c) => c.id !== id) }),
      invert: (w) => ({ ...w, connections: insertSorted(w.connections, wire) }),
    });
  },
});

/**
 * `wire.reroute {id, route}`: gives a single conductor a new route, keeping its cut length (no re-cut
 * in P3: a route it doesn't reach is `too-short`; delete and add again). A conductor pulled through
 * conduit stays there (`needs-pull`).
 */
export function wireRerouteCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WireRerouteArgs, World>({
    id: 'wire.reroute',
    title: 'Reroute a wire',
    category: 'Wire',
    args: WireRerouteArgs,
    undoable: true,
    run: ({ state }, { id, route }) => {
      const wire = findWire(state, id);
      if (isFailure(wire)) return wire;
      if (wire.cable !== null) return fail('in-cable', `Wire ${id} follows cable ${wire.cable.id}: reroute the cable`);
      if (inConduit(wire.route))
        return fail('needs-pull', `Wire ${id} was pulled through conduit: delete and pull again`);
      const checked = checkRoute(state, catalog, route, { a: wire.a !== null, b: wire.b !== null }, 'refuse');
      if (checked) return checked;
      const a = endPoint(state, catalog, wire.a);
      if (isFailure(a)) return a;
      const b = endPoint(state, catalog, wire.b);
      if (isFailure(b)) return b;
      const geometry = checkGeometry(state, catalog, routePoints(a, route, b), wire.lengthMm as number);
      if (geometry) return geometry;
      return swap(wire, { ...wire, route: copyRoute(route) });
    },
  });
}

/**
 * `wire.land {id, end, at}`: lands a free end of a conductor (a cable or pulled conductor, or a
 * re-land after `wire.unland`) and takes the next termination id. A single conductor's rest
 * waypoint at that end is replaced by the terminal point, which must still fit its length
 * (`too-short`); a cable conductor must reach the terminal with the cable's stripped tail
 * (`tail-too-short`).
 */
export function wireLandCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WireLandArgs, World>({
    id: 'wire.land',
    title: 'Land a wire end',
    category: 'Wire',
    args: WireLandArgs,
    undoable: true,
    run: ({ state }, { id, end, at }) => {
      const wire = findWire(state, id);
      if (isFailure(wire)) return wire;
      if (wire[end] !== null) return fail('already-landed', `End ${end} of wire ${id} is already landed`);
      const terminationId = state.nextTerminationId;
      if (!idsLeft(terminationId, 1)) return fail('ids-exhausted', 'No termination ids left in this world');
      const other = wire[end === 'a' ? 'b' : 'a'];
      if (other && other.entity === at.entity && other.terminal === at.terminal) {
        return fail('same-terminal', 'A wire joins two different terminals');
      }
      const entry = checkConductor(catalog, wire.ref);
      if (!entry.ok) return entry;
      const landing = checkLanding(state, catalog, entry.value.spec, at, terminationId, wire);
      if (!landing.ok) return landing;
      let after: Connection = { ...wire, [end]: landing.value.end };
      if (wire.cable !== null) {
        const cable = state.cables.find((c) => c.id === wire.cable?.id);
        if (!cable) return fail('not-found', `No cable with id ${wire.cable.id}`);
        const reach = checkTailReach(state, catalog, cable, end, landing.value.point.positionMm);
        if (reach) return reach;
      } else {
        const route = wire.route ?? [];
        const rest = end === 'a' ? route.slice(1) : route.slice(0, -1);
        const otherPoint = endPoint(state, catalog, other);
        if (isFailure(otherPoint)) return otherPoint;
        const points =
          end === 'a'
            ? routePoints(landing.value.point, rest, otherPoint)
            : routePoints(otherPoint, rest, landing.value.point);
        const geometry = checkGeometry(state, catalog, points, wire.lengthMm as number);
        if (geometry) return geometry;
        after = { ...after, route: rest };
      }
      return swap(wire, after, { nextTerminationId: [terminationId, terminationId + 1] });
    },
  });
}

/**
 * The conductor with its `end` unlanded (ADR 0015): the end becomes `null`; a single conductor gains a
 * free rest waypoint where the terminal was (first for end a, last for end b), so its route keeps its
 * points; a cable conductor's tail stays in the cable. `null` if the catalogue can't place the end.
 */
export function unlandEnd(world: World, catalog: Catalog, wire: Connection, end: 'a' | 'b'): Connection | null {
  const landed = wire[end];
  if (landed === null) return wire;
  if (wire.route === null) return { ...wire, [end]: null };
  const point = landedPoint(world, catalog, landed);
  if (point === null) return null;
  const rest = restWaypoint(point);
  return { ...wire, [end]: null, route: end === 'a' ? [rest, ...wire.route] : [...wire.route, rest] };
}

/** `wire.unland {id, end}`: takes a conductor end off its terminal. Undo restores the same termination. */
export function wireUnlandCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WireUnlandArgs, World>({
    id: 'wire.unland',
    title: 'Unland a wire end',
    category: 'Wire',
    args: WireUnlandArgs,
    undoable: true,
    run: ({ state }, { id, end }) => {
      const wire = findWire(state, id);
      if (isFailure(wire)) return wire;
      if (wire[end] === null) return fail('not-landed', `End ${end} of wire ${id} isn't landed`);
      const after = unlandEnd(state, catalog, wire, end);
      if (after === null) {
        return fail('unknown-terminal', `The catalogue can't place the terminal end ${end} of wire ${id} is on`);
      }
      return swap(wire, after);
    },
  });
}

/** `wire.label {id, text, tool}`: prints a sleeve marker with a tool that can `label` (`null` removes it). */
export function wireLabelCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WireLabelArgs, World>({
    id: 'wire.label',
    title: 'Label a wire',
    category: 'Wire',
    args: WireLabelArgs,
    undoable: true,
    run: ({ state }, { id, text, tool }) => {
      const wire = findWire(state, id);
      if (isFailure(wire)) return wire;
      const labeller = checkTool(catalog, tool, 'label');
      if (!labeller.ok) return labeller;
      return swap(wire, { ...wire, label: text });
    },
  });
}

/**
 * `wire.pull {route, lengthMm, conductors, tool}`: pulls 1–16 conductors through conduit with a tool
 * that can `pull` (the fish tape minigame logs it on success only, D10). The route must go through
 * conduit and starts and ends with free rest waypoints outside it; each conductor is created with
 * both ends free, in array order.
 */
export function wirePullCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<WirePullArgs, World>({
    id: 'wire.pull',
    title: 'Pull wires through conduit',
    category: 'Wire',
    args: WirePullArgs,
    undoable: true,
    run: ({ state }, args) => {
      const first = state.nextConnectionId;
      if (!idsLeft(first, args.conductors.length)) return fail('ids-exhausted', 'No connection ids left in this world');
      const entries: ConductorEntry[] = [];
      for (const conductor of args.conductors) {
        const entry = checkConductor(catalog, conductor.ref);
        if (!entry.ok) return entry;
        const colour = checkColour(entry.value, conductor.colour);
        if (colour) return colour;
        entries.push(entry.value);
      }
      const largest = Math.min(...entries.map((e) => e.spec.awg));
      const tape = checkTool(catalog, args.tool, 'pull', largest);
      if (!tape.ok) return tape;
      const route = checkRoute(state, catalog, args.route, { a: false, b: false }, 'require');
      if (route) return route;
      const geometry = checkGeometry(state, catalog, routePoints(null, args.route, null), args.lengthMm);
      if (geometry) return geometry;
      const pulled = entries.map((entry, i) =>
        newConductor(first + i, entry, {
          a: null,
          b: null,
          cable: null,
          route: copyRoute(args.route),
          lengthMm: args.lengthMm,
          colour: { ...args.conductors[i].colour },
        }),
      );
      const ids = new Set(pulled.map((c) => c.id));
      return succeed({
        apply: (w) => ({ ...w, nextConnectionId: first + pulled.length, connections: [...w.connections, ...pulled] }),
        invert: (w) => ({ ...w, nextConnectionId: first, connections: w.connections.filter((c) => !ids.has(c.id)) }),
      });
    },
  });
}

/** The wire commands, in a fixed order, resolving refs against `catalog`. */
export function wireCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [
    wireAddCommand(catalog),
    wireDelete,
    wireRerouteCommand(catalog),
    wireLandCommand(catalog),
    wireUnlandCommand(catalog),
    wireLabelCommand(catalog),
    wirePullCommand(catalog),
  ];
}
