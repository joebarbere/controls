import { BUILTIN_CATALOG, type Catalog, initialBags } from '@controls/catalog';
import { type AnyCommandDef, defineCommand, fail, succeed } from '@controls/commands';
import { insertSorted } from '../entity-commands';
import type { Cable, CableId, Connection, World } from '../types';
import { CableAddArgs, CableDeleteArgs, CableLabelArgs, CableRerouteArgs, CableStripArgs } from './args';
import {
  cableEndPoint,
  checkCableEnd,
  checkConductor,
  checkGeometry,
  checkRoute,
  checkTailReach,
  checkTool,
  type ConductorEntry,
  idsLeft,
  inConduit,
  landedPoint,
  type RoutePoint,
  routePoints,
} from './checks';

/*
 * The cable commands (ADR 0015, "CableV3"): `cable.add`, `cable.strip`, `cable.delete`,
 * `cable.reroute` and `cable.label`. A cable owns its conductors: `cable.add` creates one conductor
 * connection per assembly conductor (both ends free, the assembly's ref and colour, the cable's
 * length, no own route) and `cable.delete` removes them all. Ids: `nextCableId`, then one connection
 * id per assembly conductor, in assembly order. Undo restores every id and counter. None reads
 * sim-owned state.
 */

function findCable(world: World, id: CableId): Cable | undefined {
  return world.cables.find((c) => c.id === id);
}

function notFound(id: CableId) {
  return fail('not-found', `No cable with id ${id}`);
}

function replaceCable(world: World, next: Cable): World {
  return { ...world, cables: world.cables.map((c) => (c.id === next.id ? next : c)) };
}

/** An undoable change swapping cable `before` for `after` (same id). */
function swap(before: Cable, after: Cable) {
  return succeed<World>({ apply: (w) => replaceCable(w, after), invert: (w) => replaceCable(w, before) });
}

/** The points of a cable's route through `route` (its ends' entry points and the waypoints), or `null` if unknown. */
function cablePoints(world: World, catalog: Catalog, cable: Pick<Cable, 'a' | 'b'>, route: Cable['route']) {
  const a = cable.a === null ? null : cableEndPoint(world, catalog, cable.a);
  const b = cable.b === null ? null : cableEndPoint(world, catalog, cable.b);
  if ((cable.a !== null && a === null) || (cable.b !== null && b === null)) return null;
  return routePoints(a, route, b);
}

/**
 * `cable.add {ref, a, b, route, lengthMm, tailsMm, tool}`: cuts a cable assembly to `lengthMm` with a
 * tool that can `cut` its largest conductor, from entry `a` to entry `b` (each an open entry with
 * room, or `null` for a free end resting on the route's first or last waypoint) with `tailsMm` left
 * past each entry. The cut must cover the route's floor plus both tails (`too-short`).
 */
export function cableAddCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<CableAddArgs, World>({
    id: 'cable.add',
    title: 'Add a cable',
    category: 'Cable',
    args: CableAddArgs,
    undoable: true,
    run: ({ state }, args) => {
      const id = state.nextCableId;
      const assembly = catalog.family(args.ref) === 'cable' ? catalog.cable(args.ref) : undefined;
      if (!assembly) return fail('not-a-cable', `${args.ref.id} version ${args.ref.version} is not a cable assembly`);
      const first = state.nextConnectionId;
      if (!idsLeft(id, 1) || !idsLeft(first, assembly.conductors.length)) {
        return fail('ids-exhausted', 'No cable or connection ids left in this world');
      }
      const entries: ConductorEntry[] = [];
      for (const conductor of assembly.conductors) {
        const entry = checkConductor(catalog, conductor.conductor);
        if (!entry.ok) return entry;
        entries.push(entry.value);
      }
      const largest = Math.min(...entries.map((e) => e.spec.awg));
      const cutter = checkTool(catalog, args.tool, 'cut', largest);
      if (!cutter.ok) return cutter;
      const route = checkRoute(state, catalog, args.route, { a: args.a !== null, b: args.b !== null }, 'refuse');
      if (route) return route;
      if (args.a && args.b && args.a.entity === args.b.entity && args.a.entry === args.b.entry) {
        return fail('same-entry', 'A cable runs between two different entries');
      }
      const ends: (RoutePoint | null)[] = [];
      for (const end of [args.a, args.b]) {
        if (end === null) {
          ends.push(null);
          continue;
        }
        const checked = checkCableEnd(state, catalog, end);
        if (!checked.ok) return checked;
        ends.push(checked.value.point);
      }
      const points = routePoints(ends[0], args.route, ends[1]);
      const geometry = checkGeometry(state, catalog, points, args.lengthMm, args.tailsMm.a + args.tailsMm.b);
      if (geometry) return geometry;
      const cable: Cable = {
        id,
        ref: { ...args.ref },
        a: args.a && { ...args.a },
        b: args.b && { ...args.b },
        route: args.route.map((w) => ({ ...w, positionMm: { ...w.positionMm }, tool: w.tool && { ...w.tool } })),
        lengthMm: args.lengthMm,
        tailsMm: { ...args.tailsMm },
        jacketStripMm: { a: 0, b: 0 },
        label: null,
        extensions: {},
      };
      const conductors: Connection[] = assembly.conductors.map((spec, i) => {
        const bags = initialBags(entries[i].kind);
        return {
          id: first + i,
          ref: { ...spec.conductor },
          a: null,
          b: null,
          cable: { id, conductor: i },
          route: null,
          lengthMm: args.lengthMm,
          colour: { ...spec.colour },
          label: null,
          state: bags.state,
          sim: bags.sim,
          extensions: {},
        };
      });
      const next = first + conductors.length;
      return succeed({
        apply: (w) => ({
          ...w,
          nextCableId: id + 1,
          nextConnectionId: next,
          cables: [...w.cables, cable],
          connections: [...w.connections, ...conductors],
        }),
        invert: (w) => ({
          ...w,
          nextCableId: id,
          nextConnectionId: first,
          cables: w.cables.filter((c) => c.id !== id),
          connections: w.connections.filter((c) => c.cable?.id !== id),
        }),
      });
    },
  });
}

/**
 * `cable.strip {id, end, jacketMm, tool}`: strips the jacket at one end to `jacketMm` with a tool that
 * can `stripJacket` the cable's largest conductor. Only more (`cannot-unstrip`), and at most the tail
 * (`strip-too-long`).
 */
export function cableStripCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<CableStripArgs, World>({
    id: 'cable.strip',
    title: 'Strip a cable jacket',
    category: 'Cable',
    args: CableStripArgs,
    undoable: true,
    run: ({ state }, { id, end, jacketMm, tool }) => {
      const cable = findCable(state, id);
      if (!cable) return notFound(id);
      const awgs = state.connections
        .filter((c) => c.cable?.id === id)
        .map((c) => catalog.device(c.ref)?.conductor?.awg)
        .filter((awg): awg is number => awg !== undefined);
      const stripper = checkTool(catalog, tool, 'stripJacket', awgs.length > 0 ? Math.min(...awgs) : null);
      if (!stripper.ok) return stripper;
      if (jacketMm < cable.jacketStripMm[end]) {
        return fail('cannot-unstrip', `End ${end} of cable ${id} is already stripped ${cable.jacketStripMm[end]} mm`);
      }
      if (jacketMm > cable.tailsMm[end]) {
        return fail('strip-too-long', `End ${end} of cable ${id} has a ${cable.tailsMm[end]} mm tail`);
      }
      return swap(cable, { ...cable, jacketStripMm: { ...cable.jacketStripMm, [end]: jacketMm } });
    },
  });
}

/** `cable.delete {id}`: removes a cable and all its conductors. Undo reinserts them with their ids. */
export const cableDelete = defineCommand<CableDeleteArgs, World>({
  id: 'cable.delete',
  title: 'Delete a cable',
  category: 'Cable',
  args: CableDeleteArgs,
  undoable: true,
  run: ({ state }, { id }) => {
    const cable = findCable(state, id);
    if (!cable) return notFound(id);
    const conductors = state.connections.filter((c) => c.cable?.id === id);
    return succeed({
      apply: (w) => ({
        ...w,
        cables: w.cables.filter((c) => c.id !== id),
        connections: w.connections.filter((c) => c.cable?.id !== id),
      }),
      invert: (w) => ({
        ...w,
        cables: insertSorted(w.cables, cable),
        connections: conductors.reduce<Connection[]>((list, c) => insertSorted(list, c), [...w.connections]),
      }),
    });
  },
});

/**
 * `cable.reroute {id, route}`: gives a cable a new route between the same ends, keeping its cut length
 * (the route's floor plus both tails must still fit, `too-short`). Its conductors follow it.
 */
export function cableRerouteCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<CableRerouteArgs, World>({
    id: 'cable.reroute',
    title: 'Reroute a cable',
    category: 'Cable',
    args: CableRerouteArgs,
    undoable: true,
    run: ({ state }, { id, route }) => {
      const cable = findCable(state, id);
      if (!cable) return notFound(id);
      if (inConduit(cable.route)) return fail('needs-pull', `Cable ${id} runs through conduit`);
      const checked = checkRoute(state, catalog, route, { a: cable.a !== null, b: cable.b !== null }, 'refuse');
      if (checked) return checked;
      const points = cablePoints(state, catalog, cable, route);
      if (points === null) return fail('unknown-entry', `The catalogue can't place an end of cable ${id}`);
      const geometry = checkGeometry(state, catalog, points, cable.lengthMm, cable.tailsMm.a + cable.tailsMm.b);
      if (geometry) return geometry;
      const copy = route.map((w) => ({ ...w, positionMm: { ...w.positionMm }, tool: w.tool && { ...w.tool } }));
      const after = { ...cable, route: copy };
      // A conductor landed at a free cable end reaches from the rest waypoint, which may have moved.
      for (const conductor of state.connections) {
        if (conductor.cable?.id !== id) continue;
        for (const end of ['a', 'b'] as const) {
          const landed = conductor[end];
          if (landed === null || cable[end] !== null) continue;
          const point = landedPoint(state, catalog, landed);
          if (point === null)
            return fail('unknown-terminal', `The catalogue can't place wire ${conductor.id}'s end ${end}`);
          const reach = checkTailReach(state, catalog, after, end, point);
          if (reach) return reach;
        }
      }
      return swap(cable, after);
    },
  });
}

/** `cable.label {id, text, tool}`: prints a label on a cable with a tool that can `label` (`null` removes it). */
export function cableLabelCommand(catalog: Catalog = BUILTIN_CATALOG) {
  return defineCommand<CableLabelArgs, World>({
    id: 'cable.label',
    title: 'Label a cable',
    category: 'Cable',
    args: CableLabelArgs,
    undoable: true,
    run: ({ state }, { id, text, tool }) => {
      const cable = findCable(state, id);
      if (!cable) return notFound(id);
      const labeller = checkTool(catalog, tool, 'label');
      if (!labeller.ok) return labeller;
      return swap(cable, { ...cable, label: text });
    },
  });
}

/** The cable commands, in a fixed order, resolving refs against `catalog`. */
export function cableCommands(catalog: Catalog = BUILTIN_CATALOG): AnyCommandDef<World>[] {
  return [
    cableAddCommand(catalog),
    cableStripCommand(catalog),
    cableDelete,
    cableRerouteCommand(catalog),
    cableLabelCommand(catalog),
  ];
}
