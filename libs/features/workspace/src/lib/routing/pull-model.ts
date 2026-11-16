import { type Catalog, conduitTradeSize, racewayPorts, type ToolDefinition } from '@controls/catalog';
import type { Difficulty } from '@controls/save-format';
import {
  type CatalogRef,
  checkConductor,
  checkPullReach,
  connectorEntries,
  type DefaultTool,
  describeDefaultTool,
  entityPointMm,
  findEntity,
  type PositionMm,
  type PullRun,
  pullRun,
  rotateQuarterTurns,
  routeDefaultLengthMm,
  type Waypoint,
  type WirePullArgs,
  type World,
} from '@controls/world-model';

/*
 * The fish tape (F3.4 part 2, D10, ADR 0015 "wire.pull"), pure so it is unit-tested without Angular:
 *
 * - **the run**: the conduit parts joined end to end with the part the player picked (`conduitRun`),
 *   and the one route a pull through them logs (`pullRoute`);
 * - **the request**: the run's length and bends (`pullRun`), the tape and whether it reaches
 *   (`checkPullReach`, shown before any play), and the conductors on offer;
 * - **the minigame**: a deterministic track of feeds and elbows (`pullTrack`) and its state machine
 *   (`feedTape`, `twistTape`, `retractTape`). It reads no clock and no random number: whatever happens
 *   in it, success logs the same `wire.pull` and anything else logs nothing (ADR 0015: the play never
 *   becomes an argument).
 *
 * Nothing here touches the world.
 */

/**
 * How far past each end of the conduit the pulled conductors' free ends rest (mm): 200 mm, game-design
 * (above the 6 in (152.4 mm) of free conductor NFPA 70-2023 Art. 300.14 asks for at a box, cited by
 * number; the player trims and lands them later). The route's first and last waypoints sit here.
 */
export const PULL_TAIL_MM = 200;

/** How much tape one feed pushes (mm): 1 m, game-design (about one arm's push of a steel tape). */
export const FEED_STEP_MM = 1000;

/** Most conductors one pull takes (the `wire.pull` schema's limit). */
export const MAX_PULL_ROWS = 16;

type Failure = { readonly ok: false; readonly code: string; readonly message: string };
const fail = (code: string, message: string): Failure => ({ ok: false, code, message });

const AXIS_UNIT: Readonly<Record<string, PositionMm>> = {
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  '+y': { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

/** A conduit part's end in world integer mm, and the direction out of the part there. */
interface PartEnd {
  readonly point: PositionMm;
  readonly out: PositionMm;
}

interface Part {
  readonly entity: number;
  readonly title: string;
  readonly elbow: boolean;
  readonly connector: boolean;
  readonly size: string;
  readonly ends: readonly [PartEnd, PartEnd];
}

const key = (p: PositionMm): string => `${p.x},${p.y},${p.z}`;
const same = (p: PositionMm, q: PositionMm): boolean => p.x === q.x && p.y === q.y && p.z === q.z;

/** Every conduit part in the world with its two ends (world integer mm), by entity id. */
function conduitParts(world: World, catalog: Catalog): Map<number, Part> {
  const parts = new Map<number, Part>();
  for (const entity of world.entities) {
    const device = catalog.device(entity.ref);
    const size = device ? conduitTradeSize(device) : null;
    if (!device || size === null) continue;
    const ports = racewayPorts(device, entity.state);
    const ends: PartEnd[] = [];
    for (const port of ports) {
      const point = entityPointMm(entity.transform, port.positionMm);
      const out = rotateQuarterTurns(entity.transform.orientationMdeg, AXIS_UNIT[port.axis]);
      if (point === null || out === null) break;
      ends.push({ point, out });
    }
    if (ends.length !== 2) continue;
    parts.set(entity.id, {
      entity: entity.id,
      title: device.title,
      elbow: device.model.kind === 'raceway.conduitElbow',
      connector: device.model.kind === 'raceway.conduitConnector',
      size,
      ends: [ends[0], ends[1]],
    });
  }
  return parts;
}

/** A conduit run: its parts in order from end a to end b, and where each end is. */
export interface ConduitRun {
  /** The parts' entity ids, end a first. */
  readonly parts: readonly number[];
  /** The trade size (`3/4`). */
  readonly size: string;
  /** The enclosure entry each end's connector is in (`connectorEntries`), or `null`. */
  readonly ends: {
    readonly a: { readonly enclosure: number; readonly entry: string } | null;
    readonly b: { readonly enclosure: number; readonly entry: string } | null;
  };
  /** The route a pull through it logs: a free rest waypoint, the conduit waypoints, a free rest waypoint. */
  readonly route: readonly Waypoint[];
  /** The parts that are elbows, in run order. */
  readonly elbows: readonly number[];
  /** Each straight stretch between elbows (mm, along the axes), in run order: one more than `elbows`. */
  readonly stretchesMm: readonly number[];
  /** `3/4 in conduit run of 3 parts (connector #2 to elbow #4)`: how the player reads it. */
  readonly title: string;
}

const distance = (p: PositionMm, q: PositionMm): number => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
const free = (positionMm: PositionMm): Waypoint => ({
  kind: 'free',
  positionMm,
  entity: null,
  fixture: null,
  tool: null,
});
const conduit = (positionMm: PositionMm, entity: number): Waypoint => ({
  kind: 'conduit',
  positionMm: { ...positionMm },
  entity,
  fixture: null,
  tool: null,
});
const plus = (p: PositionMm, d: PositionMm, mm: number): PositionMm => ({
  x: p.x + d.x * mm,
  y: p.y + d.y * mm,
  z: p.z + d.z * mm,
});

/**
 * The conduit run through `entity` (F3.4 part 2): a conduit part, or an enclosure with a connector in
 * one of its entries (the lowest connector id). Parts are joined where an end of one is exactly an end
 * of another of the same trade size (what the placement snapping makes); a branch takes the lowest id.
 *
 * End a is the end whose connector sits in an enclosure entry when exactly one does (the tape goes in
 * from the box), else the end of the lower entity id. The route (ADR 0015) starts and ends with a free
 * rest waypoint {@link PULL_TAIL_MM} past each end along the part's own axis; between them one conduit
 * waypoint at each end and joint, hosted by the part it ends, except that a joint into an elbow is
 * hosted by the elbow, so `pullRun` measures each elbow along its centreline. (Two elbows joined
 * directly share one waypoint, hosted by the first: the second is then measured by its chord, 55 mm
 * short for 3/4 in.)
 */
export function conduitRun(world: World, catalog: Catalog, entity: number): ({ ok: true } & ConduitRun) | Failure {
  const parts = conduitParts(world, catalog);
  let start = parts.get(entity);
  if (!start) {
    if (!findEntity(world, entity)) return fail('not-found', `No entity with id ${entity}`);
    const held = connectorEntries(world, catalog).find((c) => c.enclosure === entity);
    start = held && parts.get(held.connector);
    if (!start) return fail('not-a-conduit', `Entity ${entity} isn't conduit, or a box with a connector in an entry`);
  }
  const at = new Map<string, number[]>();
  for (const part of parts.values()) {
    for (const end of part.ends) at.set(key(end.point), [...(at.get(key(end.point)) ?? []), part.entity]);
  }
  const seen = new Set<number>([start.entity]);
  /** Walks from `part`'s end `from` along the joints: the parts beyond it, in order. */
  const walk = (part: Part, from: 0 | 1): Part[] => {
    const out: Part[] = [];
    let current = part;
    let end = from;
    for (;;) {
      const point = current.ends[end].point;
      const size = current.size;
      const next = (at.get(key(point)) ?? [])
        .filter((id) => !seen.has(id))
        .map((id) => parts.get(id) as Part)
        .filter((p) => p.size === size)
        .sort((p, q) => p.entity - q.entity)[0];
      if (!next) return out;
      seen.add(next.entity);
      out.push(next);
      end = same(next.ends[0].point, point) ? 1 : 0;
      current = next;
    }
  };
  const before = walk(start, 0).reverse();
  const after = walk(start, 1);
  let chain = [...before, start, ...after];
  // Which end of each part faces back along the chain (`near`) and which forward (`far`).
  const orient = (list: readonly Part[]): { part: Part; near: PartEnd; far: PartEnd }[] => {
    const out: { part: Part; near: PartEnd; far: PartEnd }[] = [];
    for (const [i, part] of list.entries()) {
      const prev = out[i - 1];
      const following = list[i + 1];
      const nearIndex = prev
        ? same(part.ends[0].point, prev.far.point)
          ? 0
          : 1
        : following && following.ends.some((e) => same(e.point, part.ends[0].point))
          ? 1
          : 0;
      out.push({ part, near: part.ends[nearIndex], far: part.ends[1 - nearIndex] });
    }
    return out;
  };
  const entries = connectorEntries(world, catalog);
  const inEntry = (part: Part, end: PartEnd) => {
    if (!part.connector) return null;
    const found = entries.find((c) => c.connector === part.entity);
    // A connector's entry end is its first port (`racewayPorts`).
    return found && same(end.point, part.ends[0].point) ? { enclosure: found.enclosure, entry: found.entry } : null;
  };
  let oriented = orient(chain);
  const first = oriented[0];
  const last = oriented[oriented.length - 1];
  const aIn = inEntry(first.part, first.near);
  const bIn = inEntry(last.part, last.far);
  if ((bIn && !aIn) || (!aIn === !bIn && last.part.entity < first.part.entity)) {
    chain = [...chain].reverse();
    oriented = orient(chain);
  }
  const head = oriented[0];
  const tail = oriented[oriented.length - 1];
  const route: Waypoint[] = [free(plus(head.near.point, head.near.out, PULL_TAIL_MM))];
  route.push(conduit(head.near.point, head.part.entity));
  for (let i = 0; i < oriented.length; i++) {
    const { part, far } = oriented[i];
    const next = oriented[i + 1];
    route.push(conduit(far.point, next?.part.elbow && !part.elbow ? next.part.entity : part.entity));
  }
  route.push(free(plus(tail.far.point, tail.far.out, PULL_TAIL_MM)));
  const elbows: number[] = [];
  const stretchesMm: number[] = [0];
  for (const { part, near, far } of oriented) {
    if (part.elbow) {
      elbows.push(part.entity);
      stretchesMm.push(0);
    } else {
      stretchesMm[stretchesMm.length - 1] += distance(near.point, far.point);
    }
  }
  const name = (p: Part) => `${p.connector ? 'connector' : p.elbow ? 'elbow' : 'stick'} #${p.entity}`;
  const title =
    oriented.length === 1
      ? `${head.part.size} in conduit run of 1 part (${name(head.part)})`
      : `${head.part.size} in conduit run of ${oriented.length} parts (${name(head.part)} to ${name(tail.part)})`;
  return {
    ok: true,
    parts: oriented.map((o) => o.part.entity),
    size: head.part.size,
    ends: { a: inEntry(head.part, head.near), b: inEntry(tail.part, tail.far) },
    route,
    elbows,
    stretchesMm,
    title,
  };
}

// --- the request -------------------------------------------------------------------------------------

/** A conductor the pull prompt offers, with the colours it is made in. */
export interface ConductorChoice {
  /** `id@version`: the option value. */
  readonly key: string;
  readonly ref: CatalogRef;
  /** Starts with the size (`12 AWG solid copper THHN…`), so type-ahead picks it. */
  readonly title: string;
  readonly colours: readonly {
    readonly key: string;
    readonly label: string;
    readonly base: string;
    readonly stripe: string | null;
  }[];
}

/** One conductor row of the prompt: a conductor and a colour (`base/stripe` keys), each `null` until chosen. */
export interface PullRow {
  readonly conductor: string | null;
  readonly colour: string | null;
}

/** Everything the pull prompt shows before any play. */
export interface PullRequest {
  /** The part the player picked (what `wiring.pull` named). */
  readonly picked: number;
  readonly run: ConduitRun;
  /** `pullRun`'s length (mm, not rounded) and bends of the route. */
  readonly reach: PullRun;
  /** The fish tape, and where it came from (`Steel fish tape … (belt slot 3)`). */
  readonly tool: ToolDefinition;
  readonly toolRef: CatalogRef;
  readonly toolSource: string;
  /** `checkPullReach`'s refusal, in words (`<message> (beyond-tool-capacity)`), or `null` when the tape reaches. */
  readonly refusal: string | null;
  readonly conductors: readonly ConductorChoice[];
  /** The rows the prompt starts with: the belt's conductor spools, else one row of the first conductor. */
  readonly rows: readonly PullRow[];
  /** The difficulty the minigame plays at (the world's). */
  readonly difficulty: Difficulty;
}

export const colourKey = (c: { readonly base: string; readonly stripe: string | null }): string =>
  c.stripe === null ? c.base : `${c.base}/${c.stripe}`;
const colourLabel = (c: { readonly base: string; readonly stripe: string | null }): string =>
  c.stripe === null ? c.base : `${c.base} with a ${c.stripe} stripe`;
const refKey = (ref: CatalogRef): string => `${ref.id}@${ref.version}`;

/** Every conductor entry in the catalogue (the newest version of each id), with its colours. */
export function conductorChoices(catalog: Catalog): ConductorChoice[] {
  const newest = new Map<string, ConductorChoice>();
  for (const device of catalog.devices) {
    const ref = { id: device.id, version: device.version };
    const entry = checkConductor(catalog, ref);
    if (!entry.ok) continue;
    newest.set(device.id, {
      key: refKey(ref),
      ref,
      title: device.title,
      colours: entry.value.spec.colours.map((c) => ({ key: colourKey(c), label: colourLabel(c), ...c })),
    });
  }
  return [...newest.values()];
}

/**
 * The pull prompt's request for the run through `entity` with `tape` (the fish tape in hand, else the
 * default-tool rule's for `pull`), or why there is none (`not-a-conduit`, `wrong-tool` with no tape).
 * The tape's reach is checked here with `checkPullReach` (the command's own rule) so a run it can't
 * reach is refused before the game.
 */
export function pullRequest(
  world: World,
  catalog: Catalog,
  belt: readonly (CatalogRef | null)[],
  entity: number,
  tape: DefaultTool | null,
): { ok: true; request: PullRequest } | Failure {
  const run = conduitRun(world, catalog, entity);
  if (!run.ok) return run;
  if (tape === null) return fail('wrong-tool', 'No tool in the catalogue can pull conductors through conduit');
  const reach = pullRun(world, catalog, run.route);
  const refused = checkPullReach(world, catalog, run.route, tape.tool);
  const conductors = conductorChoices(catalog);
  const rows: PullRow[] = [];
  for (const ref of belt) {
    if (ref === null || rows.length >= MAX_PULL_ROWS) continue;
    const choice = conductors.find((c) => c.ref.id === ref.id && c.ref.version === ref.version);
    if (choice && choice.colours[0]) rows.push({ conductor: choice.key, colour: choice.colours[0].key });
  }
  if (rows.length === 0 && conductors[0]?.colours[0]) {
    rows.push({ conductor: conductors[0].key, colour: conductors[0].colours[0].key });
  }
  const plain: ConduitRun = {
    parts: run.parts,
    size: run.size,
    ends: run.ends,
    route: run.route,
    elbows: run.elbows,
    stretchesMm: run.stretchesMm,
    title: run.title,
  };
  return {
    ok: true,
    request: {
      picked: entity,
      run: plain,
      reach,
      tool: tape.tool,
      toolRef: { ...tape.ref },
      toolSource: describeDefaultTool(tape),
      refusal: refused ? `${refused.message} (${refused.code})` : null,
      conductors,
      rows,
      difficulty: world.difficulty,
    },
  };
}

/**
 * The `wire.pull` arguments for `rows` (ADR 0015): the run's route, the default cut along it
 * (`routeDefaultLengthMm`: the floor plus the slack), the conductors in row order, the tape. A problem
 * with the rows (none, a row not filled in, a colour the conductor isn't made in) is `{ok: false}`.
 */
export function pullArgs(
  request: PullRequest,
  rows: readonly PullRow[],
): { ok: true; args: WirePullArgs } | { ok: false; message: string } {
  if (rows.length === 0) return { ok: false, message: 'Add at least one conductor.' };
  if (rows.length > MAX_PULL_ROWS) return { ok: false, message: `A pull takes at most ${MAX_PULL_ROWS} conductors.` };
  const conductors: WirePullArgs['conductors'] = [];
  for (const [i, row] of rows.entries()) {
    const choice = request.conductors.find((c) => c.key === row.conductor);
    if (!choice) return { ok: false, message: `Conductor ${i + 1}: choose a conductor.` };
    const colour = choice.colours.find((c) => c.key === row.colour);
    if (!colour) return { ok: false, message: `Conductor ${i + 1}: choose a colour.` };
    conductors.push({
      ref: { ...choice.ref },
      colour: { base: colour.base, stripe: colour.stripe } as WirePullArgs['conductors'][number]['colour'],
    });
  }
  const route = request.run.route.map((w) => structuredClone(w));
  return {
    ok: true,
    args: {
      route,
      lengthMm: routeDefaultLengthMm(route.map((w) => w.positionMm)),
      conductors,
      tool: { ...request.toolRef },
    },
  };
}

// --- the minigame ------------------------------------------------------------------------------------

/** One station of the tape's way through the run: a straight push, or an elbow it must be twisted round. */
export type TrackStation =
  | { readonly kind: 'feed'; readonly stretch: number }
  | { readonly kind: 'elbow'; readonly elbow: number; readonly index: number };

/**
 * The run as the tape meets it: each straight stretch is `ceil(length / FEED_STEP_MM)` feeds (at least
 * one), each elbow one station that only a twist gets past. Derived from the run alone: no clock, no
 * random number.
 */
export function pullTrack(run: Pick<ConduitRun, 'elbows' | 'stretchesMm'>): TrackStation[] {
  const track: TrackStation[] = [];
  run.stretchesMm.forEach((mm, i) => {
    const feeds = Math.max(mm > 0 || run.elbows.length === 0 ? 1 : 0, Math.ceil(mm / FEED_STEP_MM));
    for (let k = 0; k < feeds; k++) track.push({ kind: 'feed', stretch: i });
    const elbow = run.elbows[i];
    if (elbow !== undefined) track.push({ kind: 'elbow', elbow, index: i });
  });
  return track;
}

/**
 * How the minigame plays at each difficulty (D9-style, F3.4 part 2; game-design):
 * - `skip`: whether the prompt offers to pull without playing (Trainee only);
 * - `showElbows`: whether the track shows where the elbows are before the tape reaches them
 *   (Trainee and Apprentice; above, only how many there are, from `pullRun`);
 * - `jamLimit`: how many pushes into an elbow the tape takes before it kinks and the pull fails
 *   (`null`: never, Trainee).
 */
export interface PullRules {
  readonly skip: boolean;
  readonly showElbows: boolean;
  readonly jamLimit: number | null;
}

export function pullRules(difficulty: Difficulty): PullRules {
  switch (difficulty) {
    case 'trainee':
      return { skip: true, showElbows: true, jamLimit: null };
    case 'apprentice':
      return { skip: false, showElbows: true, jamLimit: 3 };
    case 'journeyman':
      return { skip: false, showElbows: false, jamLimit: 2 };
    case 'realistic':
      return { skip: false, showElbows: false, jamLimit: 1 };
  }
}

/** The minigame's state. `at` is how many stations the tape head has passed. */
export interface TapeState {
  readonly track: readonly TrackStation[];
  readonly at: number;
  /** Pushes into an elbow so far (the whole pull, retracting doesn't undo them). */
  readonly jams: number;
  readonly phase: 'feeding' | 'through' | 'kinked';
}

/** What one key did, for the prompt to announce. */
export type TapeEvent =
  | 'fed'
  | 'reachedElbow'
  | 'jammed'
  | 'kinked'
  | 'twisted'
  | 'twistedFree'
  | 'retracted'
  | 'atStart'
  | 'through'
  | 'idle';

export function startTape(track: readonly TrackStation[]): TapeState {
  return { track, at: 0, jams: 0, phase: track.length === 0 ? 'through' : 'feeding' };
}

const next = (s: TapeState): TrackStation | undefined => s.track[s.at];
const advance = (s: TapeState): { state: TapeState; event: TapeEvent } => {
  const at = s.at + 1;
  if (at >= s.track.length) return { state: { ...s, at, phase: 'through' }, event: 'through' };
  return { state: { ...s, at }, event: s.track[at].kind === 'elbow' ? 'reachedElbow' : 'fed' };
};

/** Feed (F, ↑): pushes the tape one station; into an elbow it jams, and past the limit it kinks. */
export function feedTape(s: TapeState, rules: PullRules): { state: TapeState; event: TapeEvent } {
  if (s.phase !== 'feeding') return { state: s, event: 'idle' };
  if (next(s)?.kind !== 'elbow') return advance(s);
  const jams = s.jams + 1;
  if (rules.jamLimit !== null && jams >= rules.jamLimit) {
    return { state: { ...s, jams, phase: 'kinked' }, event: 'kinked' };
  }
  return { state: { ...s, jams }, event: 'jammed' };
}

/** Twist (T): at an elbow the tape turns round it and goes on; anywhere else it only spins. */
export function twistTape(s: TapeState): { state: TapeState; event: TapeEvent } {
  if (s.phase !== 'feeding') return { state: s, event: 'idle' };
  if (next(s)?.kind !== 'elbow') return { state: s, event: 'twistedFree' };
  const moved = advance(s);
  return { state: moved.state, event: moved.event === 'through' ? 'through' : 'twisted' };
}

/** Pull back (R, ↓): the tape comes back one station (the jams so far stay counted). */
export function retractTape(s: TapeState): { state: TapeState; event: TapeEvent } {
  if (s.phase !== 'feeding') return { state: s, event: 'idle' };
  if (s.at === 0) return { state: s, event: 'atStart' };
  return { state: { ...s, at: s.at - 1 }, event: 'retracted' };
}

/** The elbows the tape has got round so far. */
export function elbowsPassed(s: TapeState): number {
  return s.track.slice(0, s.at).filter((t) => t.kind === 'elbow').length;
}

/** `true` when the station ahead is an elbow (the tape is up against it). */
export function atElbow(s: TapeState): boolean {
  return s.phase === 'feeding' && next(s)?.kind === 'elbow';
}

/** The default-tool rule's choice, named the way the prompt says it. */
export { describeDefaultTool };
