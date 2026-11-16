import { BUILTIN_CATALOG } from '@controls/catalog';
import type { Game } from '@controls/scripting-api';
import {
  checkCableEnd,
  placeInWorld,
  racewayPaths,
  routeDefaultLengthMm,
  snapWaypoint,
  worldSnapTargets,
  type CatalogRef,
  type PositionMm,
  type Vec3Mm,
  type Waypoint,
  type World,
} from '@controls/world-model';

/*
 * F3.4 part 2, headless: the drill, the hole saw and the fish tape on the workshop stud wall.
 *
 * 1. A DIN panel hung on the stud faces; its 3/4 in top drill site (a custom entry, ADR 0015) cut with
 *    the 1-1/8 in hole saw, which fits a 3/4 in knockout hole (1.115 in published).
 * 2. An EMT run up from it: a 3/4 in connector in the new hole and a stick cut to 1.2 m above it.
 * 3. Two 12 AWG THHN conductors pulled through the run with the 50 ft steel fish tape (what the fish
 *    tape minigame logs on success, D10), both ends free.
 * 4. Two 2-gang boxes on the side faces of studs 4 and 6, joined by 14/2 NM-B stapled near each box and
 *    passed through stud 5 in a hole bored with the 3/4 in ship auger (19.05 mm: under 24.5 mm, so it
 *    leaves 34.9 mm to the stud face and needs no nail plate).
 *
 * Placements and waypoints are what the mouse would give (`placeInWorld`, `snapWaypoint`);
 * `apps/sim-cli/src/drill-and-pull.spec.ts` pins the hash and `drill-and-pull.console` spells it out.
 *
 *   pnpm sim run apps/sim-cli/scenarios/drill-and-pull.ts --world content/levels/workshop.json
 */
export default function drillAndPull(game: Game): void {
  const ref = (id: string): CatalogRef => ({ id, version: 1 });
  const world = () => game.world() as World;
  const place = (part: CatalogRef, cursor: Vec3Mm) => {
    const placed = placeInWorld(world(), part, cursor, worldSnapTargets(world()));
    if (!placed.ok) throw new Error(`no placement for ${part.id} at ${JSON.stringify(cursor)}: ${placed.reason}`);
    const { positionMm, orientationMdeg, mountedOn } = placed;
    game.execOrThrow('entity.place', { ref: part, positionMm, orientationMdeg, mountedOn });
  };
  const snap = (cursor: PositionMm, kind: 'staple' | 'bore' | 'conduit', boreTool: CatalogRef | null = null) => {
    const w = snapWaypoint(world(), BUILTIN_CATALOG, cursor, { kinds: [kind], boreTool });
    if (w.kind !== kind) throw new Error(`no ${kind} at ${JSON.stringify(cursor)}`);
    return w;
  };
  const free = (positionMm: PositionMm): Waypoint => ({
    kind: 'free',
    positionMm,
    entity: null,
    fixture: null,
    tool: null,
  });

  // 1. The panel on the stud faces (entity 1, at (-1010, 800, -21)); cut its drill site with the hole saw.
  game.execOrThrow('entity.place', {
    ref: ref('panel.pellmoor-din-400x500'),
    positionMm: { x: -1010, y: 800, z: -21 },
  });
  game.execOrThrow('enclosure.openEntry', { id: 1, entry: 'drill-top-1', tool: ref('tool.corriden-hs-18') });

  // 2. A 3/4 in connector in the new hole (entity 2), and a stick on it (entity 3) cut to 1.2 m.
  place(ref('connector.stavenor-emt-075'), { x: -880, y: 1310, z: 79 });
  place(ref('emt.stavenor-075'), { x: -880, y: 1350, z: 79 });
  game.execOrThrow('raceway.cut', { id: 3, lengthMm: 1200 });

  // 3. Pull black and white 12 AWG THHN from inside the panel up through the connector and the stick.
  const paths = racewayPaths(world(), BUILTIN_CATALOG);
  const stick = paths.find((p) => p.entity === 3);
  const connector = paths.find((p) => p.entity === 2);
  if (!stick || !connector) throw new Error('the conduit run is missing');
  const inside = connector.a.y < connector.b.y ? connector.a : connector.b;
  const top = stick.a.y > stick.b.y ? stick.a : stick.b;
  const route = [
    free({ ...inside, y: inside.y - 200 }),
    snap(inside, 'conduit'),
    snap({ ...top, y: top.y - 1 }, 'conduit'),
    free({ ...top, y: top.y + 300 }),
  ];
  game.execOrThrow('wire.pull', {
    route,
    lengthMm: routeDefaultLengthMm(route.map((w) => w.positionMm)),
    conductors: [
      { ref: ref('conductor.tallowmere-thhn-12-solid'), colour: { base: 'black', stripe: null } },
      { ref: ref('conductor.tallowmere-thhn-12-solid'), colour: { base: 'white', stripe: null } },
    ],
    tool: ref('tool.veltmark-ft-50'),
  });

  // 4. Two boxes on studs 4 and 6 (entities 4, 5), their top clamps opened, joined through a bore in stud 5.
  place(ref('box.tinmoor-2g-nm'), { x: -820, y: -800, z: -21 });
  place(ref('box.tinmoor-2g-nm'), { x: -10, y: -800, z: -21 });
  game.execOrThrow('enclosure.openEntry', { id: 4, entry: 'clamp-top-1', tool: ref('tool.veltmark-sd-2') });
  game.execOrThrow('enclosure.openEntry', { id: 5, entry: 'clamp-top-1', tool: ref('tool.veltmark-sd-2') });
  const auger = ref('tool.corriden-sa-12');
  const a = { entity: 4, entry: 'clamp-top-1' };
  const b = { entity: 5, entry: 'clamp-top-1' };
  const cableRoute = [
    snap({ x: -830, y: -550, z: -65 }, 'staple'),
    snap({ x: -450, y: -550, z: -65 }, 'bore', auger),
    snap({ x: -30, y: -550, z: -65 }, 'staple'),
  ];
  const tailsMm = { a: 200, b: 200 };
  const entry = (end: typeof a) => {
    const checked = checkCableEnd(world(), BUILTIN_CATALOG, end);
    if (!checked.ok) throw new Error(checked.message);
    return checked.value.point.positionMm;
  };
  const points = [entry(a), ...cableRoute.map((w) => w.positionMm), entry(b)];
  game.execOrThrow('cable.add', {
    ref: ref('cable.sorrelby-nmb-14-2'),
    a,
    b,
    route: cableRoute,
    lengthMm: routeDefaultLengthMm(points, undefined, tailsMm),
    tailsMm,
    tool: ref('tool.veltmark-dc-8'),
  });
}
