import { BUILTIN_CATALOG, ENTRY_TYPES, knockoutHoleMm } from '@controls/catalog';
import { createWorld, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '../session';
import type { PositionMm, Waypoint } from '../types';
import { routeDefaultLengthMm } from '../routing/length';
import { snapConduit } from '../snap/raceway-placement';
import { checkPullReach, ELBOW_BEND_DEG, elbowArcExcessMm, pullRun } from './checks';
import { racewayPaths } from '../routing/raceways';
import { boreNeedsNailPlate } from './framing';
import { snapWaypoint } from '../routing/snap';

/*
 * F3.4 part 2 on the built-in catalogue: custom entries cut with a hole saw or a knockout punch
 * (`enclosure.openEntry` on a catalogue drill site or knockout, ADR 0015: custom entries are catalogue
 * drill sites, not a world list), and the fish tape's reach in `wire.pull`.
 */

const ref = (id: string) => ({ id, version: 1 });
const refused = (code: string) => ({ ok: false, error: { code } });
const at = (x: number, y: number, z: number) => ({ x, y, z });
const free = (x: number, y: number, z: number): Waypoint => ({
  kind: 'free',
  positionMm: at(x, y, z),
  entity: null,
  fixture: null,
  tool: null,
});
const conduit = (entity: number, x: number, y: number, z: number): Waypoint => ({
  ...free(x, y, z),
  kind: 'conduit',
  entity,
});

const SAW_78 = ref('tool.corriden-hs-14');
const SAW_118 = ref('tool.corriden-hs-18');
const SAW_138 = ref('tool.corriden-hs-22');
const SAW_134 = ref('tool.corriden-hs-28');
const AUGER_34 = ref('tool.corriden-sa-12');
const PUNCH = ref('tool.veltmark-kp-3');
const TAPE = ref('tool.veltmark-fr-1524');
const SCREWDRIVER = ref('tool.veltmark-sd-2');
const CUTTERS = ref('tool.veltmark-dc-8');
const THHN = ref('conductor.tallowmere-thhn-12-solid');
const black = { ref: THHN, colour: { base: 'black', stripe: null } };

function bench(fixtures: World['fixtures'] = []) {
  const world = { ...createWorld({ seed: 3, difficulty: 'journeyman' }), fixtures };
  const bus = createWorldBus(world, createWorldRegistry({ catalog: BUILTIN_CATALOG }));
  const place = (id: string, x: number, y: number, z: number) => {
    const result = bus.exec('entity.place', { ref: ref(id), positionMm: at(x, y, z) });
    if (!result.ok) throw new Error(result.error.message);
  };
  return { bus, place };
}

const STICK = 'emt.stavenor-075';
const ELBOW = 'elbow.stavenor-emt-075';
const lengthOf = (route: readonly Waypoint[]) => routeDefaultLengthMm(route.map((w) => w.positionMm));
const samePoint = (p: PositionMm, q: PositionMm) => p.x === q.x && p.y === q.y && p.z === q.z;

/**
 * EMT-lite parts placed end to end the way the mouse snaps them (`snapConduit` onto the last part's
 * free end, with its `turn`), the first a stick at the origin along +x; each stick cut to its
 * `lengthMm`. Returns the bus, the part ids and the route through them as the snapper gives it: a free
 * point before, the first stick's start, each part's far end on that part, a free point after.
 */
function conduitRun(parts: readonly { id: string; lengthMm?: number; turn?: number }[]) {
  const { bus } = bench();
  const ids: number[] = [];
  const route: Waypoint[] = [];
  let end: PositionMm | null = null;
  for (const part of parts) {
    const id = bus.state.nextEntityId;
    const placed =
      end === null
        ? { positionMm: at(0, 0, 0), orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } }
        : snapConduit(bus.state, BUILTIN_CATALOG, ref(part.id), end, part.turn ?? 0);
    if (!placed) throw new Error(`nowhere to put ${part.id}`);
    const { positionMm, orientationMdeg } = placed;
    const result = bus.exec('entity.place', { ref: ref(part.id), positionMm, orientationMdeg });
    if (!result.ok) throw new Error(result.error.message);
    if (part.lengthMm !== undefined) {
      const cut = bus.exec('raceway.cut', { id, lengthMm: part.lengthMm });
      if (!cut.ok) throw new Error(cut.error.message);
    }
    const path = racewayPaths(bus.state, BUILTIN_CATALOG).find((p) => p.entity === id);
    if (!path) throw new Error(`no path for ${part.id}`);
    if (end === null) {
      route.push(free(path.a.x - 100, path.a.y, path.a.z), conduit(id, path.a.x, path.a.y, path.a.z));
      end = path.a;
    }
    const far: PositionMm = samePoint(path.a, end) ? path.b : path.a;
    route.push(conduit(id, far.x, far.y, far.z));
    ids.push(id);
    end = far;
  }
  if (end === null) throw new Error('no parts');
  route.push(free(end.x, end.y, end.z + 100));
  return { bus, ids, route };
}

describe('enclosure.openEntry with a hole saw or knockout punch (F3.4 part 2)', () => {
  it('cuts the DIN panel’s 3/4 in drill site with the 1-1/8 in hole saw, not with a wrong size, a wood bit or a screwdriver', () => {
    const { bus, place } = bench();
    place('panel.pellmoor-din-400x500', 0, 0, 0); // entity 1
    const open = (entry: string, tool: { id: string; version: number }) =>
      bus.exec('enclosure.openEntry', { id: 1, entry, tool });
    // 3/4 in trade size: a 1.115 in (28.321 mm) knockout hole. 7/8 in (22.225) and 1-3/8 in (34.925) are off by 6 mm.
    expect(knockoutHoleMm('3/4')).toBeCloseTo(28.321, 9);
    expect(open('drill-top-1', SAW_78)).toMatchObject(refused('wrong-size'));
    expect(open('drill-top-1', SAW_138)).toMatchObject(refused('wrong-size'));
    // A drill site opens by openEntry only: a wood bit (bore) and a screwdriver (drive) can't cut a steel wall.
    expect(ENTRY_TYPES['drillSite'].opens).toStrictEqual(['openEntry']);
    expect(open('drill-top-1', AUGER_34)).toMatchObject(refused('wrong-tool'));
    expect(open('drill-top-1', SCREWDRIVER)).toMatchObject(refused('wrong-tool'));
    const before = bus.state;
    expect(open('drill-top-1', SAW_118).ok).toBe(true);
    expect(bus.state.entities[0].state['openEntries']).toBe(8); // drill-top-1 is entries[3]: bit 3
    expect(open('drill-top-1', SAW_118)).toMatchObject(refused('already-open'));
    bus.exec('edit.undo');
    expect(bus.state).toStrictEqual(before);
    // The punch set's 3/4 in punch opens the other drill site.
    expect(open('drill-top-2', PUNCH).ok).toBe(true);
  });

  it('punches knockouts of the sizes in its set, and refuses a size it has no punch for', () => {
    const { bus, place } = bench();
    place('panel.pellmoor-din-400x500', 0, 0, 0); // entity 1: ko-bottom-1/2 are 3/4 in, ko-bottom-3 is 1 in
    place('box.tinmoor-4sq-steel', 2000, 0, 0); // entity 2: 1/2 in knockouts and a 3/4 in back knockout
    const open = (id: number, entry: string, tool: { id: string; version: number }) =>
      bus.exec('enclosure.openEntry', { id, entry, tool });
    expect(open(1, 'ko-bottom-3', PUNCH).ok).toBe(true); // 1 in
    expect(open(2, 'ko-top-1', PUNCH).ok).toBe(true); // 1/2 in
    expect(open(2, 'ko-back', SAW_118).ok).toBe(true); // a hole saw that fits a knockout's size opens it too
    expect(open(2, 'ko-top-2', SAW_118)).toMatchObject(refused('wrong-size')); // 1-1/8 in on a 1/2 in knockout
    expect(open(2, 'ko-top-2', SAW_78).ok).toBe(true);
    // A knockout still opens with a screwdriver (by drive, no size involved).
    expect(open(1, 'ko-bottom-1', SCREWDRIVER).ok).toBe(true);
    // A 1-1/4 in saw fits no entry in the catalogue's boxes and panel (1/2, 3/4 and 1 in).
    expect(open(1, 'ko-bottom-2', SAW_134)).toMatchObject(refused('wrong-size'));
  });

  it('refuses a punch with no die for the size (a TEST-ONLY 1/2 in-only punch on a 3/4 in site)', () => {
    const half = { ...BUILTIN_CATALOG.tool(PUNCH), id: 'tool.test-punch-half', punches: ['1/2' as const] };
    const catalog = {
      ...BUILTIN_CATALOG,
      tool: (r: { id: string; version: number }) => (r.id === half.id ? half : BUILTIN_CATALOG.tool(r)),
      family: (r: { id: string; version: number }) =>
        r.id === half.id ? ('tool' as const) : BUILTIN_CATALOG.family(r),
    } as typeof BUILTIN_CATALOG;
    const bus = createWorldBus(createWorld({ seed: 3 }), createWorldRegistry({ catalog }));
    expect(bus.exec('entity.place', { ref: ref('panel.pellmoor-din-400x500'), positionMm: at(0, 0, 0) }).ok).toBe(true);
    const result = bus.exec('enclosure.openEntry', { id: 1, entry: 'drill-top-1', tool: { id: half.id, version: 1 } });
    expect(result).toMatchObject(refused('wrong-size'));
    expect(result.ok ? '' : result.error.message).toContain('has no punch for the 3/4 in entry');
  });
});

describe('bores with the real bits (F3.4 part 2 on F3.2 part 4’s rules)', () => {
  it('snaps a bore with the 3/4 and 7/8 in bits (no nail plate), warns for 1-1/8 in, never proposes the 1-3/4 in saw', () => {
    const wall = {
      id: 'studs',
      ref: { id: 'prop.stud-wall', version: 1 },
      transform: { positionMm: at(0, 0, 0), orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      extensions: {},
    };
    const { bus } = bench([wall]);
    const snap = (tool: { id: string; version: number }) =>
      snapWaypoint(bus.state, BUILTIN_CATALOG, at(400, 600, -40), { kinds: ['bore'], boreTool: tool });
    for (const bit of [AUGER_34, ref('tool.corriden-sa-14'), ref('tool.corriden-sa-16'), ref('tool.corriden-sa-18')]) {
      const w = snap(bit);
      expect(w.kind).toBe('bore');
      expect(w.tool).toStrictEqual(bit);
    }
    const diameter = (r: { id: string; version: number }) => BUILTIN_CATALOG.tool(r)?.boreDiameterMm ?? NaN;
    expect(boreNeedsNailPlate(diameter(AUGER_34))).toBe(false); // 19.05 mm leaves 34.925 mm
    expect(boreNeedsNailPlate(diameter(ref('tool.corriden-sa-14')))).toBe(false); // 22.225 mm leaves 33.3375 mm
    expect(boreNeedsNailPlate(diameter(ref('tool.corriden-sa-16')))).toBe(false); // 25.4 mm leaves exactly 31.75 mm
    expect(boreNeedsNailPlate(diameter(ref('tool.corriden-sa-18')))).toBe(true); // 28.575 mm leaves 30.1625 mm
    expect(snap(SAW_134).kind).toBe('free'); // 44.45 mm is over the 35.56 mm bored-hole limit
  });
});

describe('wire.pull with the fish tape (F3.4 part 2)', () => {
  it('measures the run from the first to the last conduit waypoint and counts one quarter bend per elbow', () => {
    const { bus, place } = bench();
    place('emt.stavenor-075', 0, 0, 0); // 1
    place('elbow.stavenor-emt-075', 5000, 0, 0); // 2
    const route = [
      free(-500, 0, 0),
      conduit(1, 0, 0, 0),
      conduit(1, 3000, 0, 0),
      conduit(2, 3000, 4000, 0), // a 3-4-5 triangle: 3000 + 4000 = 7000 mm of run
      conduit(2, 3000, 4000, 100), // the same elbow twice is one bend
      free(3000, 4500, 100),
    ];
    expect(pullRun(bus.state, BUILTIN_CATALOG, route)).toStrictEqual({ lengthMm: 7100, bendDeg: 90, elbows: [2] });
    expect(ELBOW_BEND_DEG).toBe(90);
    const tape = BUILTIN_CATALOG.tool(TAPE);
    if (!tape) throw new Error('no fish tape');
    expect(checkPullReach(bus.state, BUILTIN_CATALOG, route, tape)).toBeNull();
  });

  it('runs an elbow along its centreline (2L + πR/2), not its chord, for each EMT elbow', () => {
    // [entry, L, R, centreline]: 1/2 in 2·64 + π·102/2 = 288.22; 3/4 in 128 + π·114/2 = 307.07;
    // 1 in 2·76 + π·146/2 = 381.34 mm. The chords (R + L)√2 are 234.76, 251.73 and 313.96 mm.
    const elbows: [string, number, number, number][] = [
      ['elbow.stavenor-emt-050', 64, 102, 288.22],
      ['elbow.stavenor-emt-075', 64, 114, 307.07],
      ['elbow.stavenor-emt-100', 76, 146, 381.34],
    ];
    for (const [id, leg, radius, centreline] of elbows) {
      const { bus, place } = bench();
      place(id, 0, 0, 0);
      const path = racewayPaths(bus.state, BUILTIN_CATALOG).find((p) => p.entity === 1);
      if (!path) throw new Error('no elbow path');
      const chord = Math.sqrt(2) * (leg + radius);
      const { x, y, z } = path.a;
      const route = [
        free(x, y - 50, z),
        conduit(1, x, y, z),
        conduit(1, path.b.x, path.b.y, path.b.z),
        free(path.b.x + 50, path.b.y, path.b.z),
      ];
      const run = pullRun(bus.state, BUILTIN_CATALOG, route);
      expect(Math.abs(run.lengthMm - centreline) / centreline).toBeLessThan(0.005);
      expect(run.lengthMm).toBeCloseTo(chord + elbowArcExcessMm(leg, radius), 9);
      expect(run.bendDeg).toBe(90);
      // Two waypoints on the elbow that aren't both its ports stay a chord.
      const off = [route[0], route[1], conduit(1, path.b.x, path.b.y, path.b.z + 1), route[3]];
      expect(pullRun(bus.state, BUILTIN_CATALOG, off).lengthMm).toBeLessThan(chord + 2);
    }
  });

  it('pulls through a run the tape reaches, and refuses one longer than 50 ft or round more than four elbows', () => {
    const pull = (bus: ReturnType<typeof bench>['bus'], route: Waypoint[], tool = TAPE) =>
      bus.exec('wire.pull', { route, lengthMm: lengthOf(route), conductors: [black], tool });
    // 15 240 mm (50 ft) of run is the tape's reach exactly: six 2540 mm sticks end to end. 15 241 is past it.
    const straight = conduitRun([2540, 2540, 2540, 2540, 2540, 2541].map((lengthMm) => ({ id: STICK, lengthMm })));
    expect(pull(straight.bus, straight.route)).toMatchObject(refused('beyond-tool-capacity'));
    expect(pull(straight.bus, straight.route, CUTTERS)).toMatchObject(refused('wrong-tool'));
    const reached = conduitRun(Array.from({ length: 6 }, () => ({ id: STICK, lengthMm: 2540 })));
    expect(pullRun(reached.bus.state, BUILTIN_CATALOG, reached.route).lengthMm).toBe(15240);
    expect(pull(reached.bus, reached.route).ok).toBe(true);
    // Five elbows (450°) are past the tape's 360°; four go (each between short sticks, zigzagging).
    const elbows = (count: number) =>
      conduitRun([
        { id: STICK, lengthMm: 300 },
        ...Array.from({ length: count }, (_, i) => [
          { id: ELBOW, turn: 2 * (i % 2) },
          { id: STICK, lengthMm: 300 },
        ]).flat(),
      ]);
    const five = elbows(5);
    const refusedFive = pull(five.bus, five.route);
    expect(refusedFive).toMatchObject(refused('beyond-tool-capacity'));
    expect(refusedFive.ok ? '' : refusedFive.error.message).toContain('450°');
    const four = elbows(4);
    expect(pullRun(four.bus.state, BUILTIN_CATALOG, four.route)).toMatchObject({ bendDeg: 360 });
    const before = four.bus.state;
    expect(pull(four.bus, four.route).ok).toBe(true);
    expect(four.bus.state.connections.map((c) => [c.id, c.a, c.b, c.lengthMm])).toStrictEqual([
      [1, null, null, lengthOf(four.route)],
    ]);
    four.bus.exec('edit.undo');
    expect(four.bus.state).toStrictEqual(before);
  });

  it('refuses a pull that skips an elbow, leaves the run, cuts a corner or sits off its part (conduit continuity)', () => {
    // A stick, an elbow on its end, a second stick on the elbow: the snapped run, and four ways round it.
    const { bus, route, ids } = conduitRun([{ id: STICK, lengthMm: 500 }, { id: ELBOW }, { id: STICK, lengthMm: 500 }]);
    const [stick1, elbow, stick2] = ids;
    const pull = (r: Waypoint[]) =>
      bus.exec('wire.pull', { route: r, lengthMm: lengthOf(r), conductors: [black], tool: TAPE });
    const [before, start, , elbowB, end, after] = route;
    expect(pullRun(bus.state, BUILTIN_CATALOG, route)).toMatchObject({ bendDeg: 90, elbows: [elbow] });
    // 1. Skipping the elbow: straight from the first stick to the second (not joined: the elbow joins them).
    const skip = pull([before, start, end, after]);
    expect(skip).toMatchObject(refused('conduit-discontinuous'));
    expect(skip.ok ? '' : skip.error.message).toContain(`conduit parts ${stick1} and ${stick2} aren't joined`);
    // 2. Leaving the conduit between conduit waypoints, past the elbow.
    expect(pull([before, start, free(-1000, -1000, -1000), end, after])).toMatchObject(
      refused('conduit-discontinuous'),
    );
    // 3. Cutting the corner: from the middle of the first stick to the elbow's far port.
    const middle = { ...start, positionMm: at(start.positionMm.x + 250, start.positionMm.y, start.positionMm.z) };
    expect(pull([before, middle, elbowB, end, after])).toMatchObject(refused('conduit-discontinuous'));
    // 4. A waypoint off its part: beside the first stick's axis, or mid-bend on the elbow.
    const beside = { ...start, positionMm: at(start.positionMm.x + 250, start.positionMm.y + 1, start.positionMm.z) };
    expect(pull([before, beside, ...route.slice(2)])).toMatchObject(refused('off-raceway'));
    const midBend = { ...elbowB, positionMm: at(elbowB.positionMm.x - 1, elbowB.positionMm.y, elbowB.positionMm.z) };
    expect(pull([before, start, route[2], midBend, end, after])).toMatchObject(refused('off-raceway'));
    // The run as built pulls, and through the stick a stop mid-stick is fine.
    expect(pull([before, start, middle, ...route.slice(2)]).ok).toBe(true);
  });
});
