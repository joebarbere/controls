import type { Game } from '@controls/scripting-api';
import type { CatalogRef } from '@controls/world-model';
import { buildLampCircuit, LAMP_CIRCUIT_IDS, screw, TOOLS, twistOn } from './lamp-circuit';

/*
 * P3 phase acceptance: a bad termination is measurable and heats (ADR 0018 §7), headless. The lamp
 * circuit (`lamp-circuit.ts`, at Journeyman) with the breaker's load screw landed at 20 % of its marked
 * 4 N·m (0.8 N·m on the 0.3–1.2 N·m torque driver, ±6 %: the loose-clamp regime, about 85 × R₀), plus
 * the D12 120 V 1500 W heater on the junction box's splices, so the 60 W lamp and the heater draw about
 * 12.8 A through the loose screw. 600 s of sim time with the breaker on: the hot spot (τ ≈ 30 s) and the
 * conductors reach their steady state. `apps/sim-cli/src/bad-termination.spec.ts` pins the hashes and
 * checks the record's end drop, the two-node closed form, the overheat event and the insulation flag;
 * `bad-termination.console` spells it out.
 *
 *   pnpm sim run apps/sim-cli/scenarios/bad-termination.ts --world content/levels/workshop.json --difficulty journeyman
 */

/** 20 % of the breaker load screw's marked 4 N·m. */
export const LOOSE_TORQUE_NM = 0.8;

/** The heater's entity id (placed after the lamp circuit's twelve). */
export const HEATER_ID = 13;

const ref = (id: string): CatalogRef => ({ id, version: 1 });

/** The lamp circuit with the loose screw, plus the heater on its splices (the breaker left off). */
export function buildBadTermination(game: Game, loadTorqueNm: number = LOOSE_TORQUE_NM): void {
  buildLampCircuit(game, loadTorqueNm);
  // The heater element on the floor in front of the junction box.
  game.execOrThrow('entity.place', {
    ref: ref('heater.hearthvale-120v-1500w'),
    positionMm: { x: -1000, y: -1200, z: 150 },
  });
  // Two THHN leads from the junction box's black and white nuts (a third conductor in each large nut)
  // to the heater's pressure-plate screws: stripped 10 mm and torqued to their marked 1.8 N·m.
  const heaterScrew = screw(TOOLS.stripper, 10, TOOLS.torqueLarge, 1.8);
  for (const [nut, terminal, colour] of [
    [LAMP_CIRCUIT_IDS.nutBlack, 'a', 'black'],
    [LAMP_CIRCUIT_IDS.nutWhite, 'b', 'white'],
  ] as const) {
    const a = { entity: nut, terminal: 'splice', termination: twistOn(TOOLS.stripper) };
    const b = { entity: HEATER_ID, terminal, termination: heaterScrew };
    const routed = game.autoRoute(a, b);
    if (!routed.ok) throw new Error(`no route to the heater: ${routed.message}`);
    game.execOrThrow('wire.add', {
      ref: ref('conductor.tallowmere-thhn-14-solid'),
      a,
      b,
      route: routed.route,
      lengthMm: routed.lengthMm,
      colour: { base: colour, stripe: null },
      tool: TOOLS.cutters,
    });
  }
}

export default function badTermination(game: Game): void {
  buildBadTermination(game);
  game.execOrThrow('device.operate', { id: LAMP_CIRCUIT_IDS.breaker, control: 'on', value: true });
  game.execOrThrow('sim.step', { ticks: 600_000 });
}
