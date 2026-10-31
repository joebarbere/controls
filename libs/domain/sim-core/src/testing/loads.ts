import { BATTERY, LAMP, SPST } from './bench';
import { LAMP_120V } from './engine';
import { SourceHost } from './sources';

/*
 * Helpers for F2.5's load specs: the refs of the built-in loads (the lamp is `LAMP` in `bench.ts`) and
 * the bench demo's circuit on a headless host. Specs only.
 */

export const RESISTOR_10R = { id: 'resistor.orrinwood-10r-10w', version: 1 };
export const HEATER = { id: 'heater.hearthvale-12v-50w', version: 1 };

/**
 * The engine models the load sessions (`devices/loads/properties.spec.ts`) put through the save-and-load
 * and replay properties, by model kind (the engine's parity guard checks every model is covered).
 */
export const LOAD_SESSION_REFS = Object.freeze({
  'lamp.incandescent': LAMP,
  resistor: RESISTOR_10R,
  heater: HEATER,
});

export { LAMP_120V };

/**
 * The bench demo on a headless host: a battery (1), an SPST switch (2) and the lamp (3), joined by
 * three test leads (battery + → switch a, switch b → lamp a, lamp b → battery −), the switch open.
 */
export function benchLampHost(): SourceHost {
  const host = new SourceHost();
  host.place(BATTERY);
  host.place(SPST);
  host.place(LAMP);
  return host.lead(1, 'pos', 2, 'a').lead(2, 'b', 3, 'a').lead(3, 'b', 1, 'neg');
}
