import {
  BUILTIN_CATALOG,
  type Catalog,
  checkBags,
  checkControlValue,
  CUT_LENGTH_KEY,
  type DeviceDefinition,
  areaUse,
  isCutToLength,
  type ModelKindDef,
  offeredMounts,
  TERMINATION_METHODS,
} from '@controls/catalog';
import { type CatalogRef, isBuiltinPropRef, type ValidationIssue } from '@controls/save-format';
import { findEntity, isLead } from './entity-commands';
import { fixtureSpec } from './fixtures';
import { conduitContinuityProblem } from './routing/continuity';
import { coversChord, routeFloorMm } from './routing/floor';
import { waypointHostProblem } from './routing/hosts';
import { entityPointMm, isAxisAligned } from './snap/quarter-turn';
import { checkTailReach, landedPoint } from './wiring/checks';
import { boredHoleTooLarge, BORED_HOLE_MAX, cableInFraming, maxStripAtBoxMm, supportGap } from './wiring/framing';
import { checkInEntry, connectorsInEntry } from './wiring/in-entry';
import { checkMount } from './wiring/mounting';
import { checkPlugInsert } from './wiring/plug';
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
 * - `mountedOn` names a mount the host's catalogue entry offers (`offeredMounts`: an enclosure's
 *   mounts or a non-enclosure's `hostMounts`, world v4), of a type the device declares it fits, and
 *   both are axis-aligned;
 * - `inEntry` (ADR 0015 F3.4 part 2 note 4) passes exactly `entity.place`'s `checkInEntry`: a conduit
 *   connector, in an open entry of its trade size of an enclosure, its entry end exactly at the entry
 *   pointing in, with room (`maxCables`, counting the entry's cable ends). Where the catalogue doesn't
 *   know the host it is left alone.
 * - (world v4, ADR 0019) `pluggedInto` passes exactly `plug.insert`'s `checkPlugInsert` for a plug
 *   already in place: the appliance's entry has a plug, the receptacle's has that outlet, the
 *   configurations mate (`nemaMates`), both are at quarter-turns and the cord reaches; where the
 *   catalogue doesn't know either entity it is left alone (a built-in prop is never plugged in, and has
 *   no outlets: a plug into one is refused, never left alone, as is a mount on one). An
 *   entry that both fits a mount and has a plug is refused by the catalogue itself (`parseCatalog`);
 * - (world v4) a `directory<n>` text key above the entry's panel `spaces` is `null`
 *   (`directoryKeyProblems`). Counters (catalogue v3 `counter` keys) are non-negative integers through
 *   `checkBags`, like every key's own schema.
 *
 * Areas (world v4): each `use` is a row of `AREA_USES`.
 *
 * Connections:
 * - the ref is a connection kind, lead-shaped exactly when the kind isn't a conductor kind, with
 *   exactly its kind's bag keys (a lead's end keys at their initial values: clips have no
 *   termination node);
 * - each landed end's terminal exists (props have none); a termination's method is one of that
 *   terminal's methods, and its accessory (if the catalogue knows it) is an accessory the method takes;
 * - a conductor's colour is in the colour table and one its entry is made in;
 * - (world v4) each end's tape (`marking`) is a colour-table id and never `bare` (not a tape colour);
 *   which colour is correct is the inspector's, never the load check's;
 * - a bore waypoint's tool (if known) is a tool that can bore, within the bored-hole limit
 *   (`BORED_HOLE_MAX`, F3.2 part 4); a hosted waypoint's known host and a
 *   known device with a landed end are axis-aligned;
 * - conduit waypoints trace the run as built (`conduitContinuityProblem`: on their parts, one stretch,
 *   joined parts, elbows port to port), as `wire.pull` requires;
 * - a conductor landed at both ends is at least as long as the straight line between them
 *   (`lengthMm² ≥ Δx² + Δy² + Δz²`, exact integers).
 *
 * Cables:
 * - the ref is a cable assembly, with one conductor per assembly conductor, each of the assembly's
 *   conductor entry and colour;
 * - each end is an open entry of an enclosure with room for it (`maxCables`, counting a connector in
 *   it), axis-aligned;
 * - the cut length covers the route's floor plus both tails (`routeFloorMm` through the entry points
 *   and waypoints, ADR 0015);
 * - (F3.2 part 4, as the commands refuse them) a run in framing is supported within the spacing
 *   (`supportGap`, `staple-spacing`); at least 6.35 mm of jacket stays inside each box
 *   (`maxStripAtBoxMm`); each landed conductor is within its stripped reach (`checkTailReach`). These
 *   need the assembly and the end geometry, so they run only where the catalogue knows both.
 *
 * Tool hole and die ids aren't stored in the world (they are `wire.add`/`wire.land` arguments), so
 * they are checked by those commands, not here.
 */

/** At most this many issues are reported. */
const MAX_ISSUES = 20;

/** The colour-table id of bare copper: a conductor colour, never a tape colour (world v4, ADR 0019). */
const BARE_COLOUR = 'bare';

/** A panel directory key (ADR 0019 deviation 5): `directory<space>`, space from 1. */
const DIRECTORY_KEY = /^directory([1-9][0-9]*)$/;

/**
 * Each `directory<n>` text key of `kind` that holds text although `n` is above the entry's panel
 * spaces (world v4, ADR 0019 deviation 5: `directory1` … `directory42` are one key per space of the
 * largest panel, and a smaller panel's keys above its `spaces` stay `null`). On an entry with no
 * spaces every directory key stays `null`; a kind without directory keys has no problems.
 */
export function directoryKeyProblems(
  kind: ModelKindDef,
  device: DeviceDefinition,
  state: Readonly<Record<string, unknown>>,
): ValidationIssue[] {
  const spaces = device.enclosure?.spaces.length ?? 0;
  const problems: ValidationIssue[] = [];
  for (const name of Object.keys(kind.keys).sort()) {
    const space = DIRECTORY_KEY.exec(name)?.[1];
    if (space === undefined || kind.keys[name].type !== 'text') continue;
    if (Number(space) > spaces && state[name] !== null && state[name] !== undefined) {
      problems.push({ path: `state.${name}`, message: `Space ${space} is above the panel's ${spaces}: it stays null` });
    }
  }
  return problems;
}

const sameRef = (a: CatalogRef, b: CatalogRef): boolean => a.id === b.id && a.version === b.version;

/**
 * Every way `world` disagrees with `catalog` (device state, connections, cables, mounts). Empty when
 * they agree. Never echoes values.
 */
export function checkWorldReferences(world: World, catalog: Catalog = BUILTIN_CATALOG): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  world.areas.forEach((area, index) => {
    if (!areaUse(area.use)) add(`areas[${index}].use`, 'Not an area use (AREA_USES)');
  });
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
    if (entity.inEntry !== null) add(`${at}.inEntry`, 'A built-in prop is in no entry (only a conduit connector is)');
    if (entity.pluggedInto !== null) add(`${at}.pluggedInto`, 'A built-in prop has no cord plug');
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
    // A momentary control's counter is pressed, never set: its key's schema (a non-negative safe
    // integer, checked by `checkBags`) is the whole rule (world v4, P4 PR 8; PR 7 refused every count).
    if (control.type === 'momentary') continue;
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
  for (const problem of directoryKeyProblems(kind, device, entity.state)) add(`${at}.${problem.path}`, problem.message);
  if (entity.pluggedInto !== null) {
    const host = findEntity(world, entity.pluggedInto.entity) as Entity; // the schema guarantees it exists
    // A built-in prop isn't a catalogue device, but it is known: it has no outlets (`plug.insert` refuses
    // it as `not-a-receptacle`), so it is never left alone like an unknown ref.
    if (isBuiltinPropRef(host.ref)) {
      add(`${at}.pluggedInto`, 'A built-in prop has no outlets');
    } else if (catalog.device(host.ref)) {
      // Exactly the command's check, for a plug already in place (its own outlet isn't "occupied").
      const refused = checkPlugInsert(
        world,
        catalog,
        { appliance: entity.id, receptacle: host.id, outlet: entity.pluggedInto.outlet },
        { existing: true },
      );
      if (refused) add(`${at}.pluggedInto`, `Not a plug the receptacle takes there (${refused.code})`);
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
  if (entity.inEntry !== null) {
    const host = findEntity(world, entity.inEntry.entity) as Entity; // the schema guarantees it exists
    if (catalog.device(host.ref)) {
      // Exactly the command's check, its own relation excluded from the room count.
      const refused = checkInEntry(
        world,
        catalog,
        entity.ref,
        entity.transform,
        entity.state,
        entity.inEntry,
        entity.id,
      );
      if (refused) add(`${at}.inEntry`, `Not a place a connector can be in that entry (${refused.code})`);
    }
  }
  if (entity.mountedOn !== null) {
    const host = findEntity(world, entity.mountedOn.entity) as Entity; // the schema guarantees it exists
    // A built-in prop offers no mounts (`checkMount` refuses it as `unknown-mount`): known, so checked.
    if (isBuiltinPropRef(host.ref)) {
      add(`${at}.mountedOn`, 'A built-in prop has no mounts');
      return;
    }
    const hostDevice = catalog.device(host.ref);
    if (!hostDevice) return;
    const mount = offeredMounts(hostDevice).find((m) => m.id === entity.mountedOn?.mount);
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
    // World v4 (P4 PR 8): a test lead's clip never sits on a terminal nothing can reach (`access:
    // 'none'`), as `lead.connect` refuses (`inaccessible`). Only catalogue-3 entries declare `none`.
    if (isLead(connection)) {
      const entity = findEntity(world, value.entity);
      const terminal = entity && catalog.device(entity.ref)?.terminals.find((t) => t.id === value.terminal);
      if (terminal?.access === 'none') add(`${at}.${end}.terminal`, "A clip can't reach that terminal");
    }
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
  for (const end of ['a', 'b'] as const) {
    const tape = connection.marking[end];
    if (tape === null) continue;
    if (tape === BARE_COLOUR) add(`${at}.marking.${end}`, 'Bare is not a tape colour');
    else if (!catalog.colour(tape)) add(`${at}.marking.${end}`, 'Not in the colour table');
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
      } else if (tool && tool.boreDiameterMm !== null && boredHoleTooLarge(tool.boreDiameterMm)) {
        add(`${at}[${index}].tool`, `The bit is over the bored-hole limit (${BORED_HOLE_MAX.valueMm} mm)`);
      }
    }
    if (waypoint.entity !== null) {
      const host = findEntity(world, waypoint.entity) as Entity; // the schema guarantees it exists
      if (catalog.device(host.ref)) {
        if (!isAxisAligned(host.transform.orientationMdeg)) {
          add(`${at}[${index}].entity`, 'A hosted waypoint is on an axis-aligned entity');
        }
        // ADR 0017's host rule, as the commands apply it; a host the catalogue doesn't know is left alone.
        const problem = waypointHostProblem(catalog, waypoint, { entity: host });
        if (problem) add(`${at}[${index}].entity`, `Not a host for this waypoint: ${problem}`);
      }
    }
    if (waypoint.fixture !== null) {
      const fixture = world.fixtures.find((f) => f.id === waypoint.fixture);
      if (fixture && fixtureSpec(fixture.ref)) {
        const problem = waypointHostProblem(catalog, waypoint, { fixture });
        if (problem) add(`${at}[${index}].fixture`, `Not a host for this waypoint: ${problem}`);
      }
    }
  });
  // The conduit run as `wire.pull` checks it (ADR 0015 F3.4 part 2 note 4); unknown hosts are left alone.
  const broken = conduitContinuityProblem(world, catalog, route);
  if (broken) add(`${at}[${broken.index}]`, `Not a continuous conduit run (${broken.code})`);
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
      connectorsInEntry(world.entities, value.entity, value.entry),
    );
    if (using > entry.maxCables) add(`${at}.${end}.entry`, 'More cables (and connectors) than the entry takes');
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
  if (!geometryKnown || !assembly) return;
  // F3.2 part 4: the framing, sheath and reach rules the commands apply.
  const aPoint = cable.a === null ? null : points[0];
  const bPoint = cable.b === null ? null : (points.at(-1) as PositionMm);
  const framing = cableInFraming(world, catalog, cable.a, cable.route, cable.b);
  if (supportGap(aPoint, cable.route, bPoint, { framing }) !== null) {
    add(`${at}.route`, 'NM cable supported farther apart than the support spacing');
  }
  for (const end of ['a', 'b'] as const) {
    if (cable[end] !== null && cable.jacketStripMm[end] > maxStripAtBoxMm(cable.tailsMm[end])) {
      add(`${at}.jacketStripMm.${end}`, 'Less than the minimum sheath left inside the box');
    }
  }
  for (const connection of world.connections) {
    if (connection.cable?.id !== cable.id) continue;
    for (const end of ['a', 'b'] as const) {
      const landed = connection[end];
      const point = landed && landedPoint(world, catalog, landed);
      if (!point) continue;
      if (checkTailReach(world, catalog, cable, end, point) !== null) {
        add(
          `connections[${world.connections.indexOf(connection)}].${end}`,
          "Out of reach of the cable's stripped tail",
        );
      }
    }
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
