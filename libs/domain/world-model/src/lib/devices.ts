import {
  BUILTIN_CATALOG,
  type Catalog,
  checkBags,
  checkControlValue,
  CUT_LENGTH_KEY,
  type DeviceDefinition,
  isCutToLength,
  type ModelKindDef,
  TERMINATION_METHODS,
} from '@controls/catalog';
import { type CatalogRef, isBuiltinPropRef, type ValidationIssue } from '@controls/save-format';
import { findEntity } from './entity-commands';
import { coversChord, routeFloorMm } from './routing/floor';
import { entityPointMm, isAxisAligned } from './snap/quarter-turn';
import { checkMount } from './wiring/mounting';
import type { Cable, Connection, ConnectionEnd, Entity, PositionMm, World } from './types';

/*
 * The load-time reference check (ADR 0011 §10 step 1, ADR 0013, ADR 0015): the world schema checks
 * shapes and the references inside the document; this checks the world against the catalogue. A
 * failure is the load error `invalid-device-state`. Run on every world that enters a game: a loaded
 * save (`loadGame`, `Session.prepareLoad`), a level (`loadLevel`) and `createGame({ world })`.
 *
 * **A ref the catalogue doesn't know is left alone** (a mod's device, a later catalogue's): its bags,
 * connections and cables round-trip untouched like `extensions`, it is never netlisted, and no check
 * below that needs its catalogue data runs on it. Geometry checks run only where the catalogue gives
 * the geometry (a known device's terminals, mounts and entries).
 *
 * Entities:
 * - a catalogue device has exactly its model kind's keys in each bag, each valid (`checkBags`), and
 *   each control's value inside the entry's control range (`checkControlValue`, as `device.operate`);
 * - a built-in prop (`prop.*` at version 1) has no device state: both bags are empty;
 * - an enclosure's `openEntries` has no bit at or above its catalogue entry's number of entries;
 * - `mountedOn` names a mount the host's catalogue entry has, of a type the device declares it fits,
 *   and both are axis-aligned.
 *
 * Connections:
 * - the ref is a connection kind, lead-shaped exactly when the kind isn't a conductor kind, with
 *   exactly its kind's bag keys (a lead's end keys at their initial values: clips have no
 *   termination node);
 * - each landed end's terminal exists (props have none); a termination's method is one of that
 *   terminal's methods, and its accessory (if the catalogue knows it) is an accessory the method takes;
 * - a conductor's colour is in the colour table and one its entry is made in;
 * - a bore waypoint's tool (if known) is a tool that can bore; a hosted waypoint's known host and a
 *   known device with a landed end are axis-aligned;
 * - a conductor landed at both ends is at least as long as the straight line between them
 *   (`lengthMm² ≥ Δx² + Δy² + Δz²`, exact integers).
 *
 * Cables:
 * - the ref is a cable assembly, with one conductor per assembly conductor, each of the assembly's
 *   conductor entry and colour;
 * - each end is an open entry of an enclosure with room for it (`maxCables`), axis-aligned;
 * - the cut length covers the route's floor plus both tails (`routeFloorMm` through the entry points
 *   and waypoints, ADR 0015).
 *
 * Tool hole and die ids aren't stored in the world (they are `wire.add`/`wire.land` arguments), so
 * they are checked by those commands, not here.
 */

/** At most this many issues are reported. */
const MAX_ISSUES = 20;

const sameRef = (a: CatalogRef, b: CatalogRef): boolean => a.id === b.id && a.version === b.version;

/**
 * Every way `world` disagrees with `catalog` (device state, connections, cables, mounts). Empty when
 * they agree. Never echoes values.
 */
export function checkWorldReferences(world: World, catalog: Catalog = BUILTIN_CATALOG): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  world.entities.forEach((entity, index) => checkEntity(world, entity, `entities[${index}]`, catalog, add));
  world.connections.forEach((connection, index) =>
    checkConnection(world, connection, `connections[${index}]`, catalog, add),
  );
  world.cables.forEach((cable, index) => checkCable(world, cable, `cables[${index}]`, catalog, add));
  return issues.slice(0, MAX_ISSUES);
}

type Add = (path: string, message: string) => void;

function checkEntity(world: World, entity: Entity, at: string, catalog: Catalog, add: Add): void {
  if (isBuiltinPropRef(entity.ref)) {
    for (const bag of ['state', 'sim'] as const) {
      if (Object.keys(entity[bag]).length > 0) add(`${at}.${bag}`, 'A built-in prop has no device state');
    }
    return;
  }
  const kind = catalog.kindOf(entity.ref);
  if (!kind) return;
  if (kind.placement !== 'entity') {
    add(`${at}.ref`, `${kind.kind} is a connection kind, not a placed device`);
    return;
  }
  for (const issue of checkBags(kind, entity.state, entity.sim)) add(`${at}.${issue.path}`, issue.message);
  // Each control's commanded value must be one `device.operate` could have set: a key's schema is
  // per kind (a setpoint ≥ 0), the control's range per entry (0–30 V), so a crafted save could
  // otherwise load a 1e9 V setpoint (F2.4 save-format review). Keys `checkBags` refused are skipped.
  const device = catalog.device(entity.ref) as DeviceDefinition;
  for (const control of device.controls) {
    const value = entity.state[control.id];
    if (value === undefined || !kind.keys[control.id]?.schema.safeParse(value).success) continue;
    const check = checkControlValue(control, kind, value);
    if (!check.ok) add(`${at}.state.${control.id}`, check.message);
  }
  // An enclosure's open entries are a bit set over its catalogue entries (ADR 0015): no bit beyond them.
  const openEntries = entity.state['openEntries'];
  if (device.enclosure !== null && typeof openEntries === 'number' && Number.isInteger(openEntries)) {
    if (Math.floor(openEntries / 2 ** device.enclosure.entries.length) !== 0) {
      add(`${at}.state.openEntries`, 'Opens an entry the enclosure does not have');
    }
  }
  // A cut-to-length raceway's length is one `raceway.cut` could have made (F3.5 part 2): within the
  // entry's minimum and its stock length, which the key's own schema can't know.
  const length = entity.state[CUT_LENGTH_KEY];
  if (isCutToLength(device) && device.sizeMm !== null && typeof length === 'number') {
    if (length < device.model.params['minLengthMm'] || length > device.sizeMm.widthMm) {
      add(`${at}.state.${CUT_LENGTH_KEY}`, 'A cut length outside the entry’s minimum and stock length');
    }
  }
  if (entity.mountedOn !== null) {
    const host = findEntity(world, entity.mountedOn.entity) as Entity; // the schema guarantees it exists
    const hostDevice = catalog.device(host.ref);
    if (!hostDevice) return;
    const mount = hostDevice.enclosure?.mounts.find((m) => m.id === entity.mountedOn?.mount);
    if (!mount) {
      add(`${at}.mountedOn.mount`, "Not a mount of the host's catalogue entry");
      return;
    }
    if (!device.mounts.some((m) => m.type === mount.type)) {
      add(`${at}.mountedOn.mount`, "The device does not fit that mount's type");
    }
    if (!isAxisAligned(host.transform.orientationMdeg) || !isAxisAligned(entity.transform.orientationMdeg)) {
      add(`${at}.mountedOn`, 'A mounted device and its host are axis-aligned');
      return;
    }
    // Where it sits on the mount and whether the mount has room, with its own state (a cut duct's
    // length, F3.5 part 2): exactly the commands' check, so a crafted save can't hold a body the
    // commands would refuse (a 2000 mm duct on a 350 mm backplate). Both crowding devices are reported.
    const refused = checkMount(
      world,
      catalog,
      entity.ref,
      entity.transform.positionMm,
      entity.transform.orientationMdeg,
      entity.mountedOn,
      entity.id,
      entity.state,
    );
    if (refused?.code === 'off-mount' || refused?.code === 'mount-full') {
      add(`${at}.mountedOn`, `Not a place the mount allows (${refused.code})`);
    }
  }
}

/** Whether the catalogue says `kind` is a conductor kind (a connection with conductor data). */
const isConductorKind = (kind: ModelKindDef): boolean => kind.requires === 'conductor';

function checkConnection(world: World, connection: Connection, at: string, catalog: Catalog, add: Add): void {
  const kind = catalog.kindOf(connection.ref);
  if (kind) {
    if (kind.placement !== 'connection') {
      add(`${at}.ref`, `${kind.kind} is not a connection kind`);
    } else {
      const leadShaped = connection.lengthMm === null;
      if (leadShaped === isConductorKind(kind)) {
        add(`${at}.ref`, leadShaped ? 'A conductor kind is never lead-shaped' : 'A lead kind is always lead-shaped');
      }
      for (const issue of checkBags(kind, connection.state, connection.sim)) add(`${at}.${issue.path}`, issue.message);
      if (leadShaped) {
        // A lead's clips have no termination node: its end keys stay at their initial values (ADR 0015),
        // except that a fused lead's two end states are both `intermittentOpen` (F3.6 part 2, ADR 0018
        // implementation notes).
        const fused =
          connection.sim['endAState'] === 'intermittentOpen' && connection.sim['endBState'] === 'intermittentOpen';
        for (const [name, def] of Object.entries(kind.keys)) {
          const value = connection.sim[name];
          if (fused && (name === 'endAState' || name === 'endBState')) continue;
          if (name.startsWith('end') && def.owner === 'sim' && value !== undefined && value !== def.initial) {
            add(`${at}.sim.${name}`, "A lead's end keys stay at their initial values (both ends open when fused)");
          }
        }
      }
    }
  }
  const points: (PositionMm | null)[] = [];
  for (const end of ['a', 'b'] as const) {
    const value = connection[end];
    if (value === null) continue;
    points.push(checkEnd(world, value, `${at}.${end}`, catalog, add));
  }
  const conductor = kind && isConductorKind(kind) ? catalog.device(connection.ref)?.conductor : undefined;
  if (connection.colour !== null) {
    const { base, stripe } = connection.colour;
    for (const [id, path] of [
      [base, 'base'],
      [stripe, 'stripe'],
    ] as const) {
      if (id !== null && conductor && !catalog.colour(id)) add(`${at}.colour.${path}`, 'Not in the colour table');
    }
    if (conductor && !conductor.colours.some((c) => c.base === base && c.stripe === stripe)) {
      add(`${at}.colour`, 'The conductor entry is not made in that colour');
    }
  }
  checkRouteReferences(world, connection.route ?? [], `${at}.route`, catalog, add);
  const [pa, pb] = points;
  if (connection.lengthMm !== null && pa && pb && !coversChord(connection.lengthMm, pa, pb)) {
    add(`${at}.lengthMm`, 'Shorter than the straight line between its landed ends');
  }
}

/**
 * Checks one landed connection end against its device; returns the end's world point (the method's
 * entry point for a termination, the terminal's position for a clip) when the catalogue gives it.
 */
function checkEnd(world: World, end: ConnectionEnd, at: string, catalog: Catalog, add: Add): PositionMm | null {
  const entity = findEntity(world, end.entity) as Entity; // the schema guarantees it exists
  const problem = terminalProblem(entity, end.terminal, catalog);
  if (problem === 'prop') add(`${at}.terminal`, 'A built-in prop has no terminals');
  else if (problem === 'unknown-terminal') add(`${at}.terminal`, "Not a terminal of the entity's device");
  const device = catalog.device(entity.ref);
  const terminal = device?.terminals.find((t) => t.id === end.terminal);
  if (!terminal) return null;
  const termination = end.termination;
  let offset = terminal.positionMm;
  if (termination !== null) {
    const spec = terminal.methods.find((m) => m.method === termination.method);
    if (!spec) {
      add(`${at}.termination.method`, 'Not a termination method of that terminal');
      return null;
    }
    offset = spec.entryMm;
    if (termination.accessory !== null) {
      const ref = termination.accessory.ref;
      const family = catalog.family(ref);
      if (family !== undefined && family !== 'accessory') {
        add(`${at}.termination.accessory.ref`, 'Not an accessory');
      } else {
        const accessory = catalog.accessory(ref);
        const method = Object.prototype.hasOwnProperty.call(TERMINATION_METHODS, spec.method)
          ? TERMINATION_METHODS[spec.method]
          : undefined;
        if (accessory && method && !method.accessories.includes(accessory.kind)) {
          add(`${at}.termination.accessory.ref`, 'The method takes no accessory of that kind');
        }
      }
    }
  }
  if (!isAxisAligned(entity.transform.orientationMdeg)) {
    if (termination !== null) add(`${at}.entity`, 'A conductor lands only on an axis-aligned device');
    return null;
  }
  return entityPointMm(entity.transform, offset);
}

/** A route's tools and hosts against the catalogue. */
function checkRouteReferences(
  world: World,
  route: readonly NonNullable<Connection['route']>[number][],
  at: string,
  catalog: Catalog,
  add: Add,
): void {
  route.forEach((waypoint, index) => {
    if (waypoint.tool !== null) {
      const family = catalog.family(waypoint.tool);
      if (family !== undefined && family !== 'tool') add(`${at}[${index}].tool`, 'Not a tool');
      const tool = catalog.tool(waypoint.tool);
      if (tool && !tool.capabilities.some((c) => c.step === 'bore')) {
        add(`${at}[${index}].tool`, 'The tool cannot bore');
      }
    }
    if (waypoint.entity !== null) {
      const host = findEntity(world, waypoint.entity) as Entity; // the schema guarantees it exists
      if (catalog.device(host.ref) && !isAxisAligned(host.transform.orientationMdeg)) {
        add(`${at}[${index}].entity`, 'A hosted waypoint is on an axis-aligned entity');
      }
    }
  });
}

function checkCable(world: World, cable: Cable, at: string, catalog: Catalog, add: Add): void {
  const family = catalog.family(cable.ref);
  if (family !== undefined && family !== 'cable') add(`${at}.ref`, 'Not a cable assembly');
  const assembly = catalog.cable(cable.ref);
  if (assembly) {
    const conductors = world.connections.filter((c) => c.cable?.id === cable.id);
    if (conductors.length !== assembly.conductors.length) {
      add(`${at}.ref`, 'One conductor per conductor of the assembly');
    }
    for (const connection of conductors) {
      const spec = assembly.conductors[connection.cable?.conductor ?? -1];
      if (!spec) continue;
      const path = `connections[${world.connections.indexOf(connection)}]`;
      if (!sameRef(connection.ref, spec.conductor)) add(`${path}.ref`, "Not the assembly's conductor entry");
      const colour = connection.colour;
      if (colour === null || colour.base !== spec.colour.base || colour.stripe !== spec.colour.stripe) {
        add(`${path}.colour`, "Not the assembly conductor's colour");
      }
    }
  }
  const points: PositionMm[] = [];
  let geometryKnown = true;
  const endPoint = (end: 'a' | 'b'): void => {
    const value = cable[end];
    if (value === null) return;
    const entity = findEntity(world, value.entity) as Entity; // the schema guarantees it exists
    const device = catalog.device(entity.ref);
    if (!device) {
      geometryKnown = false;
      return;
    }
    const entryIndex = device.enclosure?.entries.findIndex((e) => e.id === value.entry) ?? -1;
    if (device.enclosure === null) {
      add(`${at}.${end}.entity`, 'Not an enclosure');
      geometryKnown = false;
      return;
    }
    if (entryIndex < 0) {
      add(`${at}.${end}.entry`, 'Not an entry of the enclosure');
      geometryKnown = false;
      return;
    }
    const entry = device.enclosure.entries[entryIndex];
    const open = entity.state['openEntries'];
    if (typeof open !== 'number' || Math.floor(open / 2 ** entryIndex) % 2 !== 1) {
      add(`${at}.${end}.entry`, 'The entry is not open');
    }
    const using = world.cables.reduce(
      (count, c) =>
        count +
        (['a', 'b'] as const).filter((e) => c[e]?.entity === value.entity && c[e]?.entry === value.entry).length,
      0,
    );
    if (using > entry.maxCables) add(`${at}.${end}.entry`, 'More cables than the entry takes');
    const point = entityPointMm(entity.transform, entry.positionMm);
    if (point === null) {
      add(`${at}.${end}.entity`, 'A cable enters only an axis-aligned enclosure');
      geometryKnown = false;
      return;
    }
    if (end === 'a') points.unshift(point);
    else points.push(point);
  };
  points.push(...cable.route.map((w) => w.positionMm));
  endPoint('a');
  endPoint('b');
  checkRouteReferences(world, cable.route, `${at}.route`, catalog, add);
  if (geometryKnown && routeFloorMm(points) + cable.tailsMm.a + cable.tailsMm.b > cable.lengthMm) {
    add(`${at}.lengthMm`, 'Shorter than its route and tails');
  }
}

/**
 * Why `terminal` can't be an end of a connection on `entity`: `prop` (built-in props have no
 * terminals), `unknown-terminal` (its device has no such terminal), or `null` (it can, or the
 * catalogue doesn't know the device).
 */
export function terminalProblem(
  entity: Entity,
  terminal: string,
  catalog: Catalog = BUILTIN_CATALOG,
): 'prop' | 'unknown-terminal' | null {
  if (isBuiltinPropRef(entity.ref)) return 'prop';
  const device = catalog.device(entity.ref);
  if (!device) return null;
  return device.terminals.some((t) => t.id === terminal) ? null : 'unknown-terminal';
}
