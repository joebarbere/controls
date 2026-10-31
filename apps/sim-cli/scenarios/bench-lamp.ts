import type { Game } from '@controls/scripting-api';

/*
 * F2.5: the bench demo as a TypeScript script. Place the battery, the switch and the lamp, connect
 * three leads, close the switch and let 1.5 s pass: the lamp is lit, its light inside the band the
 * published relation gives for the voltage across it. Open the switch and let 0.5 s pass: it is out.
 * `bench-lamp.console` is the same as console lines, and `apps/sim-cli/src/bench-lamp.spec.ts` checks
 * both reach BENCH_LAMP_HASH.
 *
 *   pnpm sim run apps/sim-cli/scenarios/bench-lamp.ts --world content/levels/workshop.json
 */

/** A lamp's light output near its rated voltage: L ∝ V^3.4 (Fink and Beaty, the lamp model's source). */
const LIGHT_VOLTAGE_EXPONENT = 3.4;
/** The model's constant emissivity puts it within 4 % of that relation from 75 % to 115 % of rated volts. */
const LIGHT_BAND = 0.04;
/** One step of an 8-bit display: below it the renderer draws the lamp dark. */
const DISPLAY_STEP = 1 / 255;

function lamp(game: Game): Readonly<Record<string, number | string>> {
  const record = game.device(3);
  if (record === null) throw new Error('the lamp publishes no record');
  if (record.values['status'] !== 'solved') throw new Error(`the lamp's island is ${record.values['status']}`);
  return record.values;
}

export default function benchLamp(game: Game): void {
  const lead = { id: 'lead.quillfern-test-1m', version: 1 };
  const at = (x: number) => ({ x, y: -300, z: 200 });

  game.execOrThrow('entity.place', { ref: { id: 'battery.ferrovane-12v-7ah', version: 1 }, positionMm: at(900) });
  game.execOrThrow('entity.place', { ref: { id: 'switch.tessaline-spst-toggle', version: 1 }, positionMm: at(1100) });
  game.execOrThrow('entity.place', { ref: { id: 'lamp.lumivane-12v-5w', version: 1 }, positionMm: at(1300) });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 3, terminal: 'a' } });
  game.execOrThrow('lead.connect', { ref: lead, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });

  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
  game.execOrThrow('sim.step', { ticks: 1500 });
  const lit = lamp(game);
  const across = game.probe('3:a', '3:b');
  if (across.kind !== 'dc') throw new Error(`expected a DC reading across the lamp, got ${across.kind}`);
  const published = Math.pow(across.volts / 12, LIGHT_VOLTAGE_EXPONENT);
  const light = lit['lightOutputRel'] as number;
  if (!(Math.abs(light / published - 1) < LIGHT_BAND)) {
    throw new Error(`lightOutputRel ${light} is outside ${published} ± ${LIGHT_BAND * 100} %`);
  }

  game.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
  game.execOrThrow('sim.step', { ticks: 500 });
  const dark = lamp(game);
  if (!((dark['lightOutputRel'] as number) < DISPLAY_STEP))
    throw new Error(`the lamp is still lit: ${dark['lightOutputRel']}`);
  if (dark['powerW'] !== 0) throw new Error('an open switch should leave the lamp no power');
  if (game.entries().length !== 10) throw new Error('unexpected replay log');
}
