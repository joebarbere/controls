import { BUILTIN_CATALOG } from '@controls/catalog';
import type { Game } from '@controls/scripting-api';
import {
  checkCableEnd,
  placeInWorld,
  proposeRoute,
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
 * P3 phase acceptance: the lamp circuit, with real tool steps (D12), headless. Every step is a logged
 * command naming its tool, as the player builds it at Journeyman (explicit terminations; `'auto'` is
 * Trainee's). `apps/sim-cli/src/lamp-circuit.spec.ts` pins its hashes and checks every step;
 * `lamp-circuit.console` spells it out line by line, and `bad-termination.console` is this circuit plus
 * a heater with one screw at 20 % of its torque.
 *
 *   pnpm sim run apps/sim-cli/scenarios/lamp-circuit.ts --world content/levels/workshop.json --difficulty journeyman
 *
 * The circuit: the split-phase stand-in supply (D12; P4's service and load centre replace it) feeds a
 * DIN-rail panel through a knockout: L1 on the 15 A breaker's line screw, N on a feed-through terminal
 * block. A THHN jumper takes the breaker's load screw to a second block. 14/2 NM-B leaves the panel's
 * bottom knockout, stapled down the side of stud 4 to a 2-gang junction box, where its conductors are
 * spliced with wire nuts to a second 14/2 run that leaves the box's bottom clamp, is stapled to stud 4,
 * passes through stud 5 in a hole bored with the 3/4 in ship auger, and is stapled to stud 6 beside the
 * lamp box, where the black and white land on the 120 V 60 W lamp's binding screws. The bare EGCs land
 * on the panel's ground block and are spliced in the junction box; at the lamp box the bare is folded
 * back (the keyless holder has no grounding terminal, and the stand-in supply has no EGC terminal: P3
 * has no grounding rules; P4's load centre bonds it). The breaker is off while wiring; on lights the
 * lamp and off puts it out.
 *
 * Positions are what `placeInWorld` (the mouse and the keyboard reticle) and `snapWaypoint` (the
 * routing gesture) give for the cursor points below; free conductors take the auto-router's route
 * (`proposeRoute`, the UI's Enter on an empty route) or the waypoints given; cut lengths are
 * `routeDefaultLengthMm`. A wire nut has no mount and nothing may be placed inside a box's body except
 * what is mounted in it (F3.5), so the nuts sit at the junction box's opening, as a splice is made
 * before it is folded in. Likewise the lamp's keyless holder on its base sits on the lamp box's opening.
 */

/** The breaker's load-screw torque (N·m): its marked 4 N·m. `bad-termination` lands it at 20 %. */
export const BREAKER_LOAD_TORQUE_NM = 4;

const ref = (id: string): CatalogRef => ({ id, version: 1 });

export const TOOLS = {
  screwdriver: ref('tool.veltmark-sd-2'),
  auger: ref('tool.corriden-sa-12'),
  cutters: ref('tool.veltmark-dc-8'),
  stripper: ref('tool.veltmark-ws-1018'),
  nmStripper: ref('tool.veltmark-ws-nm12'),
  torqueSmall: ref('tool.calderyn-ts-03'),
  torqueLarge: ref('tool.calderyn-ts-15'),
  labeller: ref('tool.penmarrow-lp-12'),
} as const;

const THHN_14 = ref('conductor.tallowmere-thhn-14-solid');

/** A screw termination: stripped through the 14 AWG solid hole of `stripper`, torqued with `driver`. */
export function screw(stripper: CatalogRef, lengthMm: number, driver: CatalogRef, torqueNm: number) {
  return {
    method: 'screw',
    strip: { tool: stripper, hole: 'sol14', lengthMm },
    accessory: null,
    clamp: { tool: driver, torqueNm },
  };
}

/** A twist-on splice: stripped through the 14 AWG solid hole, twisted on by hand (no tool, no torque). */
export function twistOn(stripper: CatalogRef) {
  return {
    method: 'twistOn',
    strip: { tool: stripper, hole: 'sol14', lengthMm: 13 },
    accessory: null,
    clamp: { tool: null, torqueNm: null },
  };
}

export const free = (positionMm: PositionMm): Waypoint => ({
  kind: 'free',
  positionMm,
  entity: null,
  fixture: null,
  tool: null,
});

/** Entity ids, in placement order. */
export const LAMP_CIRCUIT_IDS = {
  supply: 1,
  panel: 2,
  breaker: 3,
  tbLine: 4,
  tbNeutral: 5,
  tbGround: 6,
  junctionBox: 7,
  lampBox: 8,
  nutBlack: 9,
  nutWhite: 10,
  nutBare: 11,
  lamp: 12,
} as const;

/** Builds the lamp circuit (the breaker left off), with the breaker load screw at `loadTorqueNm`. */
export function buildLampCircuit(game: Game, loadTorqueNm: number = BREAKER_LOAD_TORQUE_NM): void {
  const world = () => game.world() as World;
  const place = (part: CatalogRef, cursor: Vec3Mm) => {
    const placed = placeInWorld(world(), part, cursor, worldSnapTargets(world()));
    if (!placed.ok) throw new Error(`no placement for ${part.id} at ${JSON.stringify(cursor)}: ${placed.reason}`);
    const { positionMm, orientationMdeg, mountedOn, inEntry } = placed;
    game.execOrThrow('entity.place', { ref: part, positionMm, orientationMdeg, mountedOn, inEntry });
  };
  const snap = (cursor: PositionMm, kind: 'staple' | 'bore', boreTool: CatalogRef | null = null) => {
    const w = snapWaypoint(world(), BUILTIN_CATALOG, cursor, { kinds: [kind], boreTool });
    if (w.kind !== kind) throw new Error(`no ${kind} at ${JSON.stringify(cursor)}`);
    return w;
  };
  const entryPoint = (end: { entity: number; entry: string }) => {
    const checked = checkCableEnd(world(), BUILTIN_CATALOG, end);
    if (!checked.ok) throw new Error(checked.message);
    return checked.value.point.positionMm;
  };
  const cable = (
    a: { entity: number; entry: string },
    b: { entity: number; entry: string },
    route: Waypoint[],
    tailsMm: { a: number; b: number },
  ) => {
    const points = [entryPoint(a), ...route.map((w) => w.positionMm), entryPoint(b)];
    const lengthMm = routeDefaultLengthMm(points, undefined, tailsMm);
    game.execOrThrow('cable.add', {
      ref: ref('cable.sorrelby-nmb-14-2'),
      a,
      b,
      route,
      lengthMm,
      tailsMm,
      tool: TOOLS.cutters,
    });
  };
  type End = { entity: number; terminal: string; termination: ReturnType<typeof screw> };
  const wire = (a: End, b: End, colour: string, waypoints: Waypoint[] = []) => {
    const proposal = proposeRoute(world(), BUILTIN_CATALOG, a, b, waypoints);
    if (!proposal.ok) throw new Error(`no route ${JSON.stringify([a, b])}: ${proposal.message}`);
    game.execOrThrow('wire.add', {
      ref: THHN_14,
      a,
      b,
      route: proposal.route,
      lengthMm: proposal.lengthMm,
      colour: { base: colour, stripe: null },
      tool: TOOLS.cutters,
    });
  };
  const land = (id: number, end: 'a' | 'b', entity: number, terminal: string, termination: object) => {
    game.execOrThrow('wire.land', { id, end, at: { entity, terminal, termination } });
  };
  const ids = LAMP_CIRCUIT_IDS;

  // 1. The stand-in supply (D12), headless, out of the way to the left of the panel.
  game.execOrThrow('entity.place', {
    ref: ref('utility.larkmoor-split-phase-25kva'),
    positionMm: { x: -1500, y: 300, z: 0 },
  });
  // 2. The DIN panel hung on the stud faces (as in nm-cable-run); knock out two bottom knockouts with
  //    the screwdriver's blade: ko-bottom-1 for the supply conductors, ko-bottom-2 for the NM-B.
  game.execOrThrow('entity.place', {
    ref: ref('panel.pellmoor-din-400x500'),
    positionMm: { x: -1010, y: 800, z: -21 },
  });
  game.execOrThrow('enclosure.openEntry', { id: ids.panel, entry: 'ko-bottom-1', tool: TOOLS.screwdriver });
  game.execOrThrow('enclosure.openEntry', { id: ids.panel, entry: 'ko-bottom-2', tool: TOOLS.screwdriver });
  // 3. The 15 A breaker on rail 1; two feed-through blocks (L, N) and a ground block on rail 2.
  place(ref('breaker.saltmere-1p-15a'), { x: -920, y: 1105, z: 1 });
  place(ref('tb.quennick-st4'), { x: -815, y: 975, z: 1 });
  place(ref('tb.quennick-st4'), { x: -809, y: 975, z: 1 });
  place(ref('tb.quennick-pe4'), { x: -803, y: 975, z: 1 });
  game.execOrThrow('entity.label', { id: ids.breaker, text: 'CB1', tool: TOOLS.labeller });
  // 4. Make up the panel: the black THHN jumper (wire 1) from the breaker's load screw to the line
  //    block's top clamp, stripped through the general stripper's 14 AWG solid hole (13 mm, the
  //    breaker's marked strip; 9 mm at the block) and torqued: the breaker screw to its marked 4 N·m
  //    with the 1–5 N·m driver (or bad-termination's loose 20 % with the 0.3–1.2 N·m one), the block to
  //    its 0.6 N·m.
  const loadDriver = loadTorqueNm >= 1 ? TOOLS.torqueLarge : TOOLS.torqueSmall;
  wire(
    { entity: ids.breaker, terminal: 'load', termination: screw(TOOLS.stripper, 13, loadDriver, loadTorqueNm) },
    { entity: ids.tbLine, terminal: 'a', termination: screw(TOOLS.stripper, 9, TOOLS.torqueSmall, 0.6) },
    'black',
  );
  // 5. The junction box against stud 4 (as in nm-cable-run) and the lamp box against stud 6's left
  //    face; open the clamps the cables use with the screwdriver.
  place(ref('box.tinmoor-2g-nm'), { x: -820, y: -800, z: -21 });
  place(ref('box.tinmoor-2g-nm'), { x: -150, y: -800, z: -21 });
  game.execOrThrow('enclosure.openEntry', { id: ids.junctionBox, entry: 'clamp-top-1', tool: TOOLS.screwdriver });
  game.execOrThrow('enclosure.openEntry', {
    id: ids.junctionBox,
    entry: 'clamp-bottom-1',
    tool: TOOLS.screwdriver,
  });
  game.execOrThrow('enclosure.openEntry', { id: ids.lampBox, entry: 'clamp-bottom-1', tool: TOOLS.screwdriver });

  // 6. Cable 1 (wires 2 black, 3 white, 4 bare): panel knockout → two staples down stud 4 → the
  //    junction box's top clamp. Cable 2 (5, 6, 7): the junction box's bottom clamp → a staple on stud 4
  //    → a hole bored through stud 5 → a staple on stud 6 → the lamp box's bottom clamp.
  cable(
    { entity: ids.panel, entry: 'ko-bottom-2' },
    { entity: ids.junctionBox, entry: 'clamp-top-1' },
    [snap({ x: -830, y: 600, z: -65 }, 'staple'), snap({ x: -830, y: -500, z: -65 }, 'staple')],
    { a: 400, b: 200 },
  );
  cable(
    { entity: ids.junctionBox, entry: 'clamp-bottom-1' },
    { entity: ids.lampBox, entry: 'clamp-bottom-1' },
    [
      snap({ x: -830, y: -1000, z: -65 }, 'staple'),
      snap({ x: -449, y: -1000, z: -65 }, 'bore', TOOLS.auger),
      snap({ x: -70, y: -1000, z: -65 }, 'staple'),
    ],
    { a: 200, b: 200 },
  );
  // 7. Strip the jackets with the NM stripper: 300 of the panel's 400 mm tail, 150 of each box's 200.
  game.execOrThrow('cable.strip', { id: 1, end: 'a', jacketMm: 300, tool: TOOLS.nmStripper });
  game.execOrThrow('cable.strip', { id: 1, end: 'b', jacketMm: 150, tool: TOOLS.nmStripper });
  game.execOrThrow('cable.strip', { id: 2, end: 'a', jacketMm: 150, tool: TOOLS.nmStripper });
  game.execOrThrow('cable.strip', { id: 2, end: 'b', jacketMm: 150, tool: TOOLS.nmStripper });

  // 8. In the panel: cable 1's conductors on the blocks' bottom clamps, stripped 9 mm through the NM
  //    stripper's 14 AWG solid hole and torqued to the blocks' marked 0.6 N·m.
  const block = screw(TOOLS.nmStripper, 9, TOOLS.torqueSmall, 0.6);
  land(2, 'a', ids.tbLine, 'b', block);
  land(3, 'a', ids.tbNeutral, 'b', block);
  land(4, 'a', ids.tbGround, 'b', block);

  // 9. The wire nuts at the junction box's opening: black and white in large nuts, the bare EGCs in a
  //    small one; each conductor stripped 13 mm through the 14 AWG solid hole and twisted on.
  game.execOrThrow('entity.place', { ref: ref('splice.corvelle-tw-l'), positionMm: { x: -830, y: -830, z: 55 } });
  game.execOrThrow('entity.place', { ref: ref('splice.corvelle-tw-l'), positionMm: { x: -800, y: -830, z: 55 } });
  game.execOrThrow('entity.place', { ref: ref('splice.corvelle-tw-s'), positionMm: { x: -768, y: -830, z: 55 } });
  const nut = twistOn(TOOLS.nmStripper);
  land(2, 'b', ids.nutBlack, 'splice', nut);
  land(5, 'a', ids.nutBlack, 'splice', nut);
  land(3, 'b', ids.nutWhite, 'splice', nut);
  land(6, 'a', ids.nutWhite, 'splice', nut);
  land(4, 'b', ids.nutBare, 'splice', nut);
  land(7, 'a', ids.nutBare, 'splice', nut);

  // 10. The lamp on the lamp box's opening: black on screw a, white on screw b, stripped 16 mm (its
  //    marked strip) and torqued to its marked 1.8 N·m with the 1–5 N·m driver.
  const lampBox = world().entities.find((e) => e.id === ids.lampBox);
  if (!lampBox) throw new Error('lamp box');
  game.execOrThrow('entity.place', {
    ref: ref('lamp.lumivane-120v-60w'),
    positionMm: { x: lampBox.transform.positionMm.x, y: -850, z: 55 },
  });
  const lampScrew = screw(TOOLS.nmStripper, 16, TOOLS.torqueLarge, 1.8);
  land(5, 'b', ids.lamp, 'a', lampScrew);
  land(6, 'b', ids.lamp, 'b', lampScrew);

  // 11. The supply conductors (wires 8 and 9), last (the stand-in has no disconnect, so they go on
  //     once the rest is made up): in through ko-bottom-1, L1 up past the breaker's right side and down
  //     onto its line screw, N to the neutral block's top clamp.
  const serviceScrew = screw(TOOLS.stripper, 13, TOOLS.torqueLarge, 4);
  wire(
    { entity: ids.supply, terminal: 'l1', termination: serviceScrew },
    { entity: ids.breaker, terminal: 'line', termination: serviceScrew },
    'black',
    [
      free({ x: -910, y: 700, z: 79 }),
      free({ x: -910, y: 860, z: 79 }),
      free({ x: -840, y: 900, z: 79 }),
      free({ x: -840, y: 1240, z: 79 }),
      free({ x: -920, y: 1240, z: 21 }),
    ],
  );
  wire(
    { entity: ids.supply, terminal: 'n', termination: serviceScrew },
    { entity: ids.tbNeutral, terminal: 'a', termination: screw(TOOLS.stripper, 9, TOOLS.torqueSmall, 0.6) },
    'white',
    [free({ x: -900, y: 700, z: 79 }), free({ x: -900, y: 860, z: 79 }), free({ x: -810, y: 1030, z: 79 })],
  );
}

/**
 * The scenario: build the circuit with the breaker off, close it (the lamp lights; 1.5 s later it is
 * lit, `LAMP_CIRCUIT_LIT_HASH`), open it (half a second later the lamp is out, `LAMP_CIRCUIT_HASH`).
 */
export default function lampCircuit(game: Game): void {
  buildLampCircuit(game);
  game.execOrThrow('device.operate', { id: LAMP_CIRCUIT_IDS.breaker, control: 'on', value: true });
  game.execOrThrow('sim.step', { ticks: 1500 });
  game.execOrThrow('device.operate', { id: LAMP_CIRCUIT_IDS.breaker, control: 'on', value: false });
  game.execOrThrow('sim.step', { ticks: 500 });
}
