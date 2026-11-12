import {
  type AccessoryDefinition,
  awgInRange,
  type Catalog,
  type ConductorSpec,
  type DeviceDefinition,
  type DriveType,
  drivesFit,
  type ModelKindDef,
  type TerminalMethodSpec,
  terminationMethod,
  type ToolDefinition,
  type ToolStep,
} from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { MAX_ROUTE_WAYPOINTS } from '@controls/save-format';
import { terminalProblem } from '../devices';
import { findEntity, isLead } from '../entity-commands';
import { builtinProp } from '../props';
import { type BoxMm, boxFromCorners, conservativeCube, segmentCrossesBox } from '../routing/collide';
import { routeFloorMm } from '../routing/floor';
import { entityPointMm, isAxisAligned } from '../snap/quarter-turn';
import {
  resolveTermination,
  type TerminationArg,
  type TerminationConductor,
  type TerminationTools,
  terminationStreams,
} from '../termination/resolve';
import type {
  Cable,
  CableEnd,
  CatalogRef,
  ConductorColour,
  Connection,
  ConnectionEnd,
  Entity,
  EntityId,
  PositionMm,
  Waypoint,
  World,
} from '../types';

/*
 * The checks the world v3 commands share (ADR 0015, "Commands" and "Refusal codes"). Each returns a
 * refusal (`CommandFailure`) or the catalogue data it resolved. Pure, and they read only the
 * commanded world and the catalogue: never a `sim` bag (ADR 0011 §1). Exported so a surface can
 * pre-check with the same validation `run` uses (ADR 0015: the fish tape pre-checks `wire.pull`).
 */

export type Checked<T> = { readonly ok: true; readonly value: T } | CommandFailure;

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });

/** Whether every counter step from `counter` by `count` new ids stays safe (`ids-exhausted` otherwise). */
export function idsLeft(counter: number, count: number): boolean {
  return Number.isSafeInteger(counter + count);
}

/** Whether the world's difficulty allows `'auto'` terminations (D9: Trainee only). */
export function autoAllowed(world: World): boolean {
  return world.difficulty === 'trainee';
}

/** Whether a capability reaches conductor size `awg` (`null`: no size involved). */
function reaches(maxAwg: number | null, awg: number | null): boolean {
  return awg === null || maxAwg === null || awg >= maxAwg;
}

/**
 * The tool `ref` names, checked for one of `steps` (ADR 0015, "Tool capabilities"): `unknown-tool`
 * when the ref isn't a tool of the catalogue, `wrong-tool` without the capability,
 * `beyond-tool-capacity` when no such capability reaches conductor size `awg`.
 */
export function checkTool(
  catalog: Catalog,
  ref: CatalogRef,
  steps: ToolStep | readonly ToolStep[],
  awg: number | null = null,
): Checked<ToolDefinition> {
  const tool = catalog.family(ref) === 'tool' ? catalog.tool(ref) : undefined;
  if (!tool) return fail('unknown-tool', `${ref.id} version ${ref.version} is not a tool in the catalogue`);
  const wanted: readonly ToolStep[] = typeof steps === 'string' ? [steps] : steps;
  const capabilities = tool.capabilities.filter((c) => wanted.includes(c.step));
  if (capabilities.length === 0) return fail('wrong-tool', `${tool.title} can't ${wanted.join(' or ')}`);
  if (!capabilities.some((c) => reaches(c.maxAwg, awg))) {
    return fail('beyond-tool-capacity', `${tool.title} doesn't reach a ${awg} AWG conductor`);
  }
  return ok(tool);
}

/**
 * `wrong-drive` unless `tool`'s drive types share one with the screw's (F3.4 part 1, ADR 0015
 * implementation notes): a nut driver can't turn a slotted terminal screw. `null` when it fits.
 */
export function checkDrive(tool: ToolDefinition, screw: readonly DriveType[], what: string): CommandFailure | null {
  if (drivesFit(tool.drives, screw)) return null;
  const has = tool.drives.length > 0 ? tool.drives.join(', ') : 'no drive';
  return fail('wrong-drive', `${tool.title} (${has}) doesn't fit ${what} (${screw.join(' or ')})`);
}

/** A conductor entry: its connection kind and its conductor data. */
export interface ConductorEntry {
  readonly ref: CatalogRef;
  readonly kind: ModelKindDef;
  readonly device: DeviceDefinition;
  readonly spec: ConductorSpec;
}

/** The conductor entry `ref` names (`not-a-conductor` otherwise: a lead, a device, a cable, unknown). */
export function checkConductor(catalog: Catalog, ref: CatalogRef): Checked<ConductorEntry> {
  const kind = catalog.kindOf(ref);
  const device = catalog.device(ref);
  if (kind?.placement !== 'connection' || kind.requires !== 'conductor' || !device?.conductor) {
    return fail('not-a-conductor', `${ref.id} version ${ref.version} is not a conductor in the catalogue`);
  }
  return ok({ ref, kind, device, spec: device.conductor });
}

/** `unavailable-colour` unless the conductor entry is made in `colour` (base and stripe). */
export function checkColour(entry: ConductorEntry, colour: ConductorColour): CommandFailure | null {
  if (entry.spec.colours.some((c) => c.base === colour.base && c.stripe === colour.stripe)) return null;
  const name = colour.stripe === null ? colour.base : `${colour.base} with a ${colour.stripe} stripe`;
  return fail('unavailable-colour', `${entry.device.title} isn't made in ${name}`);
}

/** The conductor of a connection as a termination sees it. */
export function terminationConductor(spec: ConductorSpec): TerminationConductor {
  return { awg: spec.awg, stranding: spec.stranding };
}

/** What a command accepts for `conduit` waypoints. */
export type ConduitRule = 'refuse' | 'require';

/**
 * A route's waypoints (ADR 0015, "The route shape"): shape (`bad-waypoint`: a free waypoint has no
 * host or tool, a hosted one exactly one host, a bore its tool and only a bore), hosts that exist
 * (`bad-waypoint`) and are axis-aligned (`not-axis-aligned`), a bore's tool that can bore, a free rest
 * waypoint at each null end, and conduit only in `wire.pull` (`needs-pull`; `wire.pull` needs one,
 * `bad-waypoint`). At most `MAX_ROUTE_WAYPOINTS` minus the landed ends, so unlanding (which adds a
 * rest waypoint) never overflows a route. Which host kinds a waypoint kind accepts (a duct waypoint
 * on a duct) is ADR 0017's, with F3.5 part 2's raceways: not checked yet.
 */
export function checkRoute(
  world: World,
  catalog: Catalog,
  route: readonly Waypoint[],
  landed: { readonly a: boolean; readonly b: boolean },
  conduit: ConduitRule,
): CommandFailure | null {
  const ends = (landed.a ? 1 : 0) + (landed.b ? 1 : 0);
  if (route.length + ends > MAX_ROUTE_WAYPOINTS) {
    return fail('bad-waypoint', `A route holds at most ${MAX_ROUTE_WAYPOINTS} waypoints and landed ends`);
  }
  let conduits = 0;
  for (const [index, w] of route.entries()) {
    const at = `Waypoint ${index + 1}`;
    if (w.kind === 'conduit') {
      if (conduit === 'refuse') return fail('needs-pull', `${at} is in conduit: pull conductors with wire.pull`);
      conduits++;
    }
    if (w.kind === 'free') {
      if (w.entity !== null || w.fixture !== null) return fail('bad-waypoint', `${at} is free: it has no host`);
    } else if ((w.entity === null) === (w.fixture === null)) {
      return fail('bad-waypoint', `${at} names exactly one host: an entity or a fixture`);
    }
    if ((w.kind === 'bore') !== (w.tool !== null)) {
      return fail('bad-waypoint', `${at}: a bore names its drill bit or hole saw, and only a bore has a tool`);
    }
    if (w.entity !== null) {
      const host = findEntity(world, w.entity);
      if (!host) return fail('bad-waypoint', `${at}: no entity with id ${w.entity}`);
      if (!isAxisAligned(host.transform.orientationMdeg)) {
        return fail('not-axis-aligned', `${at}: entity ${w.entity} isn't at quarter-turns`);
      }
    }
    if (w.fixture !== null && !world.fixtures.some((f) => f.id === w.fixture)) {
      return fail('bad-waypoint', `${at}: no fixture "${w.fixture}"`);
    }
    if (w.tool !== null) {
      const tool = checkTool(catalog, w.tool, 'bore');
      if (!tool.ok) return tool;
    }
  }
  if (!landed.a && route[0]?.kind !== 'free') {
    return fail('bad-waypoint', 'A free end a rests on the first waypoint, of kind free');
  }
  if (!landed.b && route.at(-1)?.kind !== 'free') {
    return fail('bad-waypoint', 'A free end b rests on the last waypoint, of kind free');
  }
  if (conduit === 'require' && conduits === 0) {
    return fail('bad-waypoint', 'A pull goes through conduit: the route needs a conduit waypoint');
  }
  return null;
}

/** Whether a route goes through conduit (a pulled conductor's). */
export function inConduit(route: readonly Waypoint[] | null): boolean {
  return route?.some((w) => w.kind === 'conduit') ?? false;
}

/** A point of a route: where it is, and the entity there (a landed end's device, an entry's enclosure, a host). */
export interface RoutePoint {
  readonly positionMm: PositionMm;
  readonly entity: EntityId | null;
}

/** A route's points: end `a`'s point (if landed), the waypoints, end `b`'s (if landed). */
export function routePoints(a: RoutePoint | null, route: readonly Waypoint[], b: RoutePoint | null): RoutePoint[] {
  const points = route.map((w) => ({ positionMm: w.positionMm, entity: w.entity }));
  return [...(a ? [a] : []), ...points, ...(b ? [b] : [])];
}

const samePoint = (p: PositionMm, q: PositionMm): boolean => p.x === q.x && p.y === q.y && p.z === q.z;

/**
 * The route's geometry (ADR 0015): at least two points, consecutive points distinct (`bad-waypoint`),
 * the cut length covering the floor plus `extraMm` (a cable's tails; `too-short`), and no straight
 * segment through a device body (`route-collides`).
 */
export function checkGeometry(
  world: World,
  catalog: Catalog,
  points: readonly RoutePoint[],
  lengthMm: number,
  extraMm = 0,
): CommandFailure | null {
  if (points.length < 2) return fail('bad-waypoint', 'A route has at least two points');
  for (let i = 1; i < points.length; i++) {
    if (samePoint(points[i - 1].positionMm, points[i].positionMm)) {
      return fail('bad-waypoint', `Route points ${i} and ${i + 1} are the same point`);
    }
  }
  const floor = routeFloorMm(points.map((p) => p.positionMm)) + extraMm;
  if (lengthMm < floor) return fail('too-short', `${lengthMm} mm doesn't reach along the route (${floor} mm at least)`);
  return checkCollisions(world, catalog, points);
}

/**
 * The body boxes of the world's solid things (ADR 0015, "Mounting and occupancy"): catalogue devices
 * with a size and built-in props. Enclosures are hollow (routes run inside them), so they are never
 * obstacles; connections have no body.
 */
export function obstacleBoxes(world: World, catalog: Catalog): { readonly entity: EntityId; readonly box: BoxMm }[] {
  const boxes: { entity: EntityId; box: BoxMm }[] = [];
  for (const entity of world.entities) {
    const device = catalog.device(entity.ref);
    const size = device ? device.sizeMm : (builtinProp(entity.ref)?.sizeMm ?? null);
    if (size === null || device?.enclosure) continue;
    boxes.push({ entity: entity.id, box: bodyBox(entity, size) });
  }
  return boxes;
}

/** An entity's body box: exact at quarter-turns, the conservative cube otherwise. */
export function bodyBox(
  entity: Pick<Entity, 'transform'>,
  size: { widthMm: number; heightMm: number; depthMm: number },
): BoxMm {
  const far = entityPointMm(entity.transform, { x: size.widthMm, y: size.heightMm, z: size.depthMm });
  if (far === null) {
    return conservativeCube(entity.transform.positionMm, { w: size.widthMm, h: size.heightMm, d: size.depthMm });
  }
  return boxFromCorners(entity.transform.positionMm, far);
}

/** `route-collides` if a segment passes through a body, other than those of the entities at its two ends. */
export function checkCollisions(world: World, catalog: Catalog, points: readonly RoutePoint[]): CommandFailure | null {
  const boxes = obstacleBoxes(world, catalog);
  if (boxes.length === 0) return null;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    for (const { entity, box } of boxes) {
      if (entity === p.entity || entity === q.entity) continue;
      if (segmentCrossesBox(p.positionMm, q.positionMm, box)) {
        return fail('route-collides', `Route segment ${i} passes through entity ${entity}`);
      }
    }
  }
  return null;
}

/** The method spec a landed end's termination names, or `undefined` (an unknown device or method). */
export function endMethodSpec(world: World, catalog: Catalog, end: ConnectionEnd): TerminalMethodSpec | undefined {
  const entity = findEntity(world, end.entity);
  const terminal = entity && catalog.device(entity.ref)?.terminals.find((t) => t.id === end.terminal);
  const method = end.termination?.method;
  return method === undefined ? undefined : terminal?.methods.find((m) => m.method === method);
}

/** A landed conductor end's point (its method's entry point in the world), or `null` if unknown or not axis-aligned. */
export function landedPoint(world: World, catalog: Catalog, end: ConnectionEnd): PositionMm | null {
  const entity = findEntity(world, end.entity);
  const spec = endMethodSpec(world, catalog, end);
  return entity && spec ? entityPointMm(entity.transform, spec.entryMm) : null;
}

/** A conductor end resolved for landing: the stored end and its point. */
export interface Landing {
  readonly end: ConnectionEnd;
  readonly point: RoutePoint;
}

/**
 * Lands a conductor end on a terminal (ADR 0015): checks the terminal, the method, the gauge, room on
 * the terminal by that method, each step's tool and the accessory, then resolves the termination with
 * id `terminationId` from its own streams. `self` is the connection being landed (its own ends don't
 * count towards `terminal-full`), or `null` for a new one.
 */
export function checkLanding(
  world: World,
  catalog: Catalog,
  conductor: ConductorSpec,
  at: {
    readonly entity: EntityId;
    readonly terminal: string;
    readonly termination: TerminationArg;
  },
  terminationId: number,
  self: Connection | null,
): Checked<Landing> {
  const entity = findEntity(world, at.entity);
  if (!entity) return fail('not-found', `No entity with id ${at.entity}`);
  const problem = terminalProblem(entity, at.terminal, catalog);
  if (problem === 'prop') return fail('no-terminals', `Entity ${at.entity} is a prop: it has no terminals`);
  const terminal = catalog.device(entity.ref)?.terminals.find((t) => t.id === at.terminal);
  if (problem !== null || !terminal)
    return fail('unknown-terminal', `Entity ${at.entity} has no terminal "${at.terminal}"`);
  if (!isAxisAligned(entity.transform.orientationMdeg)) {
    return fail('not-axis-aligned', `Entity ${at.entity} isn't at quarter-turns: nothing lands on it in P3`);
  }
  const args = at.termination;
  let spec: TerminalMethodSpec | undefined;
  if (args === 'auto') {
    if (!autoAllowed(world)) {
      return fail('termination-required', `'auto' terminations are for Trainee; this world is ${world.difficulty}`);
    }
    spec = terminal.methods[0];
  } else {
    spec = terminal.methods.find((m) => m.method === args.method);
  }
  if (!spec) {
    const name = args === 'auto' ? 'a conductor' : `a ${args.method} termination`;
    return fail('wrong-method', `Terminal "${at.terminal}" of entity ${at.entity} takes no ${name}`);
  }
  // TODO(F3.6 part 1, the ADR 0018 catalogue fields PR): check a twist-on splice against the method's
  // `combination` bounds (count, AWG, total size; ADR 0018 §4.4). Until the catalogue has them, no
  // twist-on landing can be checked, so every one is refused (ADR 0015 implementation note 15).
  if (spec.method === 'twistOn') {
    return fail(
      'combination-out-of-range',
      'Twist-on splices need their rated combinations (ADR 0018), not in the catalogue yet',
    );
  }
  const accessory = args === 'auto' || args.accessory === null ? null : catalog.accessory(args.accessory.ref);
  if (
    args !== 'auto' &&
    args.accessory !== null &&
    (catalog.family(args.accessory.ref) !== 'accessory' || !accessory)
  ) {
    return fail('wrong-accessory', `${args.accessory.ref.id} is not a ferrule or lug in the catalogue`);
  }
  const gauge = checkGauge(spec, conductor, accessory ?? null);
  if (gauge) return gauge;
  const landedHere = world.connections.filter(
    (c) =>
      c !== self &&
      !isLead(c) &&
      [c.a, c.b].some(
        (e) => e?.entity === at.entity && e.terminal === at.terminal && e.termination?.method === spec.method,
      ),
  ).length;
  if (landedHere >= spec.maxConductors) {
    return fail('terminal-full', `Terminal "${at.terminal}" already holds ${spec.maxConductors} by ${spec.method}`);
  }
  let tools: TerminationTools | null = null;
  if (args !== 'auto') {
    const checked = checkSteps(catalog, spec, conductor, args, accessory ?? null);
    if (!checked.ok) return checked;
    tools = checked.value;
  }
  const point = entityPointMm(entity.transform, spec.entryMm) as PositionMm; // axis-aligned above
  const termination = resolveTermination(
    terminationId,
    args,
    spec,
    terminationConductor(conductor),
    tools,
    terminationStreams(world.seed, terminationId),
  );
  return ok({
    end: { entity: at.entity, terminal: at.terminal, termination },
    point: { positionMm: point, entity: at.entity },
  });
}

/**
 * `gauge-out-of-range` unless the method takes the conductor's AWG designation and its stranding (a
 * stranded conductor in a ferrule counts as `strandedFerrule`); `wrong-accessory` unless the accessory
 * is one the method takes and fits the conductor.
 */
function checkGauge(
  spec: TerminalMethodSpec,
  conductor: ConductorSpec,
  accessory: AccessoryDefinition | null,
): CommandFailure | null {
  if (!awgInRange(conductor.awg, spec.awgRange)) {
    return fail('gauge-out-of-range', `A ${conductor.awg} AWG conductor is outside the ${spec.method} method's range`);
  }
  if (accessory !== null) {
    const method = terminationMethod(spec.method);
    if (!method?.accessories.includes(accessory.kind)) {
      return fail('wrong-accessory', `A ${spec.method} termination takes no ${accessory.kind}`);
    }
    if (!awgInRange(conductor.awg, accessory.awgRange) || !accessory.stranding.includes(conductor.stranding)) {
      return fail(
        'wrong-accessory',
        `${accessory.title} doesn't fit a ${conductor.awg} AWG ${conductor.stranding} conductor`,
      );
    }
  }
  const ferrule = accessory?.kind === 'ferrule';
  const accepted =
    spec.stranding.includes(conductor.stranding) ||
    (ferrule && conductor.stranding === 'stranded' && spec.stranding.includes('strandedFerrule'));
  if (!accepted) {
    return fail(
      'gauge-out-of-range',
      `The ${spec.method} method doesn't take a ${conductor.stranding} conductor like that`,
    );
  }
  return null;
}

/**
 * Each step's tool (ADR 0015, "Tools travel inside the termination"): a stripper that can `strip` the
 * conductor and has the hole (`unknown-hole`); a crimper that can `crimp` it and has the die
 * (`unknown-die`); for a clamp-torque method a driver that can `drive` (`wrong-tool` with none) and
 * fits the screw's drive types (`wrong-drive`), whose torque setting is given exactly when it can `torque` and lies inside its range
 * (`beyond-tool-capacity`); for any other method no clamp tool or setting (`wrong-tool`).
 */
function checkSteps(
  catalog: Catalog,
  spec: TerminalMethodSpec,
  conductor: ConductorSpec,
  args: Exclude<TerminationArg, 'auto'>,
  accessory: AccessoryDefinition | null,
): Checked<TerminationTools> {
  const stripper = checkTool(catalog, args.strip.tool, 'strip', conductor.awg);
  if (!stripper.ok) return stripper;
  const hole = stripper.value.holes.find((h) => h.id === args.strip.hole);
  if (!hole) return fail('unknown-hole', `${stripper.value.title} has no hole "${args.strip.hole}"`);
  let crimp: TerminationTools['accessory'] = null;
  if (args.accessory !== null && accessory !== null) {
    const crimper = checkTool(catalog, args.accessory.tool, 'crimp', conductor.awg);
    if (!crimper.ok) return crimper;
    const die = crimper.value.dies.find((d) => d.id === args.accessory?.die);
    if (!die) return fail('unknown-die', `${crimper.value.title} has no die "${args.accessory.die}"`);
    crimp = { accessory, tool: crimper.value, die };
  }
  const method = terminationMethod(spec.method);
  const { tool: clampRef, torqueNm } = args.clamp;
  if (!method?.clampTorque) {
    if (clampRef !== null || torqueNm !== null) {
      return fail('wrong-tool', `A ${spec.method} termination takes no clamp tool or torque setting`);
    }
    return ok({ strip: { tool: stripper.value, hole }, accessory: crimp, clamp: null });
  }
  if (clampRef === null) return fail('wrong-tool', `A ${spec.method} termination needs a driver`);
  const driver = checkTool(catalog, clampRef, 'drive', conductor.awg);
  if (!driver.ok) return driver;
  const misfit = checkDrive(driver.value, spec.drives, `the terminal screw`);
  if (misfit) return misfit;
  const range = driver.value.torque;
  if (range === null && torqueNm !== null) {
    return fail('wrong-tool', `${driver.value.title} has no torque setting: use a torque driver`);
  }
  if (range !== null) {
    if (torqueNm === null) return fail('wrong-tool', `${driver.value.title} needs its torque setting`);
    if (torqueNm < range.minNm || torqueNm > range.maxNm) {
      return fail(
        'beyond-tool-capacity',
        `${driver.value.title} sets ${range.minNm}–${range.maxNm} N·m, not ${torqueNm}`,
      );
    }
  }
  return ok({ strip: { tool: stripper.value, hole }, accessory: crimp, clamp: driver.value });
}

/** An enclosure entry resolved for a cable end: its point and index. */
export interface EntryPoint {
  readonly point: RoutePoint;
  readonly index: number;
}

/** 2^i for i = 0 … 31 (built by doubling: exact, and no `**` under the D6 lint). */
export const ENTRY_BITS: readonly number[] = Object.freeze(
  Array.from({ length: 32 }).reduce<number[]>((bits, _, i) => [...bits, i === 0 ? 1 : bits[i - 1] * 2], []),
);

/** Whether bit `index` of an enclosure's `openEntries` is set. */
export function entryOpen(entity: Entity, index: number): boolean {
  const open = entity.state['openEntries'];
  return typeof open === 'number' && Math.floor(open / ENTRY_BITS[index]) % 2 === 1;
}

/** How many cable ends are in `entry` of entity `id` (each cable counts each of its ends there). */
export function cablesInEntry(cables: readonly Cable[], id: EntityId, entry: string): number {
  let count = 0;
  for (const cable of cables) {
    if (cable.a?.entity === id && cable.a.entry === entry) count++;
    if (cable.b?.entity === id && cable.b.entry === entry) count++;
  }
  return count;
}

/**
 * A cable end in an enclosure entry (ADR 0015): the entity exists (`not-found`) and is an enclosure
 * (`not-an-enclosure`) with that entry (`unknown-entry`), opened (`entry-closed`), with room
 * (`entry-full`, `maxCables`), and axis-aligned (`not-axis-aligned`). `extra` counts ends this command
 * adds to the same entry before this one (a cable with both ends in one entry is refused separately).
 */
export function checkCableEnd(world: World, catalog: Catalog, end: CableEnd): Checked<EntryPoint> {
  const entity = findEntity(world, end.entity);
  if (!entity) return fail('not-found', `No entity with id ${end.entity}`);
  const enclosure = catalog.device(entity.ref)?.enclosure;
  if (!enclosure) return fail('not-an-enclosure', `Entity ${end.entity} is not an enclosure`);
  const index = enclosure.entries.findIndex((e) => e.id === end.entry);
  if (index < 0) return fail('unknown-entry', `Entity ${end.entity} has no entry "${end.entry}"`);
  if (!entryOpen(entity, index)) return fail('entry-closed', `Entry "${end.entry}" of entity ${end.entity} is closed`);
  const entry = enclosure.entries[index];
  if (cablesInEntry(world.cables, end.entity, end.entry) >= entry.maxCables) {
    return fail('entry-full', `Entry "${end.entry}" of entity ${end.entity} takes ${entry.maxCables} cable(s)`);
  }
  const point = entityPointMm(entity.transform, entry.positionMm);
  if (point === null) return fail('not-axis-aligned', `Entity ${end.entity} isn't at quarter-turns`);
  return ok({ point: { positionMm: point, entity: end.entity }, index });
}

/** A cable end's point: its entry's position, or `null` when the catalogue can't place it. */
export function cableEndPoint(world: World, catalog: Catalog, end: CableEnd): RoutePoint | null {
  const entity = findEntity(world, end.entity);
  const entry = entity && catalog.device(entity.ref)?.enclosure?.entries.find((e) => e.id === end.entry);
  const point = entity && entry ? entityPointMm(entity.transform, entry.positionMm) : null;
  return point && { positionMm: point, entity: end.entity };
}

/**
 * Whether a cable conductor's end can reach the terminal it lands on (ADR 0015, "Tails are stored, not
 * derived"): the jacket at that end is stripped and the terminal's entry point is within the tail of
 * the cable's entry point (or, at a free cable end, its rest waypoint), compared as integers
 * (`d² ≤ tailsMm[end]²`). `tail-too-short` otherwise.
 */
export function checkTailReach(
  world: World,
  catalog: Catalog,
  cable: Cable,
  end: 'a' | 'b',
  terminal: PositionMm,
): CommandFailure | null {
  if (cable.jacketStripMm[end] <= 0) {
    return fail('tail-too-short', `The jacket at end ${end} of cable ${cable.id} isn't stripped`);
  }
  const cableEnd = cable[end];
  const rest = end === 'a' ? cable.route[0] : cable.route.at(-1);
  const from = cableEnd !== null ? cableEndPoint(world, catalog, cableEnd)?.positionMm : rest?.positionMm;
  if (!from) return fail('tail-too-short', `End ${end} of cable ${cable.id} has no known place`);
  const dx = terminal.x - from.x;
  const dy = terminal.y - from.y;
  const dz = terminal.z - from.z;
  const tail = cable.tailsMm[end];
  if (dx * dx + dy * dy + dz * dz > tail * tail) {
    return fail('tail-too-short', `The terminal is out of reach of cable ${cable.id}'s ${tail} mm tail at end ${end}`);
  }
  return null;
}
