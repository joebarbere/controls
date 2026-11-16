import { BUILTIN_CATALOG } from '@controls/catalog';
import type { Game } from '@controls/scripting-api';
import {
  checkCableEnd,
  placeInWorld,
  routeDefaultLengthMm,
  snapWaypoint,
  worldSnapTargets,
  type CatalogRef,
  type PositionMm,
  type Vec3Mm,
  type World,
} from '@controls/world-model';

/*
 * F3.2 part 4: a box-to-box NM-B run, headless. A 2-gang nonmetallic box on the workshop's stud wall
 * (placed as the mouse places it) feeds a DIN panel hung on the wall above it with 14/2 NM-B: up the
 * side of the stud the box is nailed to, stapled within 304.8 mm of each box and well inside 1371.6 mm
 * between staples (NFPA 70 Art. 334.30 by number; the staples snapped as the routing gesture snaps
 * them), into the panel's bottom knockout. The jacket is stripped at both ends, and the black and
 * white conductors (and the bare EGC, on the ground block) are landed individually on DIN terminal
 * blocks in the panel with the NM stripper and a torque screwdriver at the blocks' marked 0.6 N·m.
 * `apps/sim-cli/src/nm-cable-run.spec.ts` pins its hash and checks every step.
 *
 *   pnpm sim run apps/sim-cli/scenarios/nm-cable-run.ts --world content/levels/workshop.json
 */
export default function nmCableRun(game: Game): void {
  const ref = (id: string): CatalogRef => ({ id, version: 1 });
  const place = (part: CatalogRef, cursor: Vec3Mm) => {
    const world = game.world();
    const placed = placeInWorld(world, part, cursor, worldSnapTargets(world));
    if (!placed.ok) throw new Error(`no placement for ${part.id} at ${JSON.stringify(cursor)}: ${placed.reason}`);
    const { positionMm, orientationMdeg, mountedOn } = placed;
    game.execOrThrow('entity.place', { ref: part, positionMm, orientationMdeg, mountedOn });
  };
  const staple = (cursor: PositionMm) => {
    const w = snapWaypoint(game.world() as World, BUILTIN_CATALOG, cursor, { kinds: ['staple'] });
    if (w.kind !== 'staple') throw new Error(`no staple at ${JSON.stringify(cursor)}`);
    return w;
  };
  const screwdriver = ref('tool.veltmark-sd-2');
  const nmStripper = ref('tool.veltmark-ws-nm12');

  // 1. The box against stud 4's side (entity 1, at (-835, -850, -21)), its top clamp opened.
  place(ref('box.tinmoor-2g-nm'), { x: -820, y: -800, z: -21 });
  game.execOrThrow('enclosure.openEntry', { id: 1, entry: 'clamp-top-1', tool: screwdriver });
  // 2. The DIN panel hung on the stud faces above it (entity 2), its middle bottom knockout opened.
  game.execOrThrow('entity.place', {
    ref: ref('panel.pellmoor-din-400x500'),
    positionMm: { x: -1010, y: 800, z: -21 },
  });
  game.execOrThrow('enclosure.openEntry', { id: 2, entry: 'ko-bottom-2', tool: screwdriver });
  // 3. Two feed-through blocks and a ground block on the panel's lower rail (entities 3–5).
  place(ref('tb.quennick-st4'), { x: -815, y: 975, z: 1 });
  place(ref('tb.quennick-st4'), { x: -809, y: 975, z: 1 });
  place(ref('tb.quennick-pe4'), { x: -803, y: 975, z: 1 });

  // 4. The cable: box top clamp → two staples up stud 4 → panel knockout, cut with the diagonal cutters.
  const a = { entity: 1, entry: 'clamp-top-1' };
  const b = { entity: 2, entry: 'ko-bottom-2' };
  const route = [staple({ x: -830, y: -500, z: -65 }), staple({ x: -830, y: 600, z: -65 })];
  const tailsMm = { a: 200, b: 400 };
  const entry = (end: typeof a) => {
    const checked = checkCableEnd(game.world() as World, BUILTIN_CATALOG, end);
    if (!checked.ok) throw new Error(checked.message);
    return checked.value.point.positionMm;
  };
  const points = [entry(a), ...route.map((w) => w.positionMm), entry(b)];
  const lengthMm = routeDefaultLengthMm(points, undefined, tailsMm);
  game.execOrThrow('cable.add', {
    ref: ref('cable.sorrelby-nmb-14-2'),
    a,
    b,
    route,
    lengthMm,
    tailsMm,
    tool: ref('tool.veltmark-dc-8'),
  });

  // 5. Strip the jacket: 150 mm of the box's 200 mm tail, 300 mm of the panel's 400 mm.
  game.execOrThrow('cable.strip', { id: 1, end: 'a', jacketMm: 150, tool: nmStripper });
  game.execOrThrow('cable.strip', { id: 1, end: 'b', jacketMm: 300, tool: nmStripper });

  // 6. Land each conductor at the panel end on its block's bottom clamp (black 1, white 2, bare EGC 3).
  const termination = {
    method: 'screw',
    strip: { tool: nmStripper, hole: 'sol14', lengthMm: 9 },
    accessory: null,
    clamp: { tool: ref('tool.calderyn-ts-03'), torqueNm: 0.6 },
  };
  for (const [wire, block] of [
    [1, 3],
    [2, 4],
    [3, 5],
  ]) {
    game.execOrThrow('wire.land', { id: wire, end: 'b', at: { entity: block, terminal: 'b', termination } });
  }
}
