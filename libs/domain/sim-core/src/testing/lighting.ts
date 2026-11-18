import type { SourceHost } from './sources';

/*
 * TEST-ONLY lighting entries (P4 F4.1 part 1): one entry per lighting kind, for the goldens and the
 * properties in `devices/lighting/` and the lamp's burnout spec. Nothing here is a real product; every
 * number is `game-design: test` unless its comment says otherwise. The shipped entries are
 * `content-designer`'s (`content/devices/`), on this branch after the models.
 *
 * - `SWITCH_1P`, `SWITCH_3WAY`, `SWITCH_4WAY` (`switch.wall1p`, `.wall3way`, `.wall4way`): 15 A 120 V,
 *   lead-clip terminals, the position as a toggle or a two-option selector.
 * - `DIMMER` (`dimmer.wall`): 120 V, 600 W; `on` and `level` (0–1) controls.
 * - `LAMPHOLDER` (`lampholder.e26`): a keyless holder whose `socket` host mount (type `e26`) offers its
 *   `centre` contact on the `hot` screw and its `shell` on the `neutral` screw.
 * - `A19_60W`, `A19_100W` (`lamp.incandescent`): the P3 120 V filament data (2700 K, τ 30 ms, f 0.05;
 *   P3 D17) at 60 W and 100 W, on an `e26` fit: the foot (`a`) touches the socket's centre and the
 *   threaded shell (`b`) its shell, `E26_CONTACT_OHM` each.
 * - `LED_A19` (`light.led`): 9 W at power factor 0.9, dropout 90 V, restart 95 V (the pre-audit's
 *   "constant power from 108 V, dropout about 90 V, PF 0.9"), on the same `e26` fit; `LED_FIXTURE`
 *   (`light.ledFixture`): the same driver at 15 W with ground, hot and neutral leads.
 * - `AC_SOURCES` (`test.acSource`): 120 V test sources at other RMS voltages, behind the same 0.1 Ω.
 */

export const SWITCH_1P = { id: 'switch.test-wall1p', version: 1 };
export const SWITCH_3WAY = { id: 'switch.test-wall3way', version: 1 };
export const SWITCH_4WAY = { id: 'switch.test-wall4way', version: 1 };
export const DIMMER = { id: 'dimmer.test-wall', version: 1 };
export const LAMPHOLDER = { id: 'lampholder.test-e26', version: 1 };
export const PULL_CHAIN = { id: 'lampholder.test-e26-pull-chain', version: 1 };
export const A19_60W = { id: 'lamp.test-a19-60w', version: 1 };
export const A19_100W = { id: 'lamp.test-a19-100w', version: 1 };
export const LED_A19 = { id: 'light.test-led-a19', version: 1 };
export const LED_FIXTURE = { id: 'light.test-led-fixture', version: 1 };

/**
 * The engine models the lighting sessions (`devices/lighting/properties.spec.ts`) put through the
 * save-and-load and replay properties, by model kind (the engine's parity guard checks every model is
 * covered).
 */
export const LIGHTING_SESSION_REFS = Object.freeze({
  'dimmer.wall': DIMMER,
  'light.led': LED_A19,
  'light.ledFixture': LED_FIXTURE,
});

/** The test LED driver (both LED entries but for their power). */
export const LED_PARAMS = {
  ratedVoltageV: 120,
  ratedPowerW: 9,
  powerFactor: 0.9,
  dropoutVoltageV: 90,
  restartVoltageV: 95,
} as const;
export const LED_FIXTURE_POWER_W = 15;

/** Each E26 contact of the test bulbs (Ω): game-design test data. */
export const E26_CONTACT_OHM = 0.002;

/** The RMS voltages of the extra test AC sources (V); each is `source.test-ac-<V>v`. */
export const AC_SOURCE_VOLTS = [80, 89, 92, 100, 108, 110, 115, 125, 127, 200] as const;
export const acSourceAt = (volts: (typeof AC_SOURCE_VOLTS)[number]) => ({ id: `source.test-ac-${volts}v`, version: 1 });

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const terminal = (id: string, x = 0) => ({
  id,
  label: id,
  positionMm: at(x),
  methods: [],
  role: null,
  side: null,
  access: 'clip',
});
const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];

function device(
  ref: { id: string; version: number },
  kind: string,
  terminals: readonly string[],
  params: Record<string, number>,
  overrides: Record<string, unknown> = {},
  covers: string[] = [],
): Record<string, unknown> {
  return {
    ...ref,
    title: 'Test lighting device',
    brand: 'Testbrand',
    modelName: 'L-1',
    category: 'load',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
    terminals: terminals.map((t, i) => terminal(t, 10 * i)),
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params },
    controls: [],
    sources: source(['sizeMm', 'terminals', ...Object.keys(params).map((p) => `model.params.${p}`), ...covers]),
    extensions: {},
    ...overrides,
  };
}

/** The `e26` fit of a bulb: the foot (`a`) on the socket's centre, the shell (`b`) on its shell. */
const E26_FIT = {
  type: 'e26',
  widthMm: 20,
  crossMm: 0,
  alongMm: 0,
  contacts: [
    { id: 'foot', terminal: 'a', host: 'centre', positionOffset: 0, contactOhm: E26_CONTACT_OHM },
    { id: 'shell', terminal: 'b', host: 'shell', positionOffset: 0, contactOhm: E26_CONTACT_OHM },
  ],
};
const E26_COVERS = ['fits.e26', 'fits.e26.contacts.foot.contactOhm', 'fits.e26.contacts.shell.contactOhm'];

const SWITCH_PARAMS = { ratedCurrentA: 15, ratedVoltageV: 120 };
const lamp = (watts: number) => ({
  ratedVoltageV: 120,
  ratedPowerW: watts,
  filamentRatedTempK: 2700,
  thermalTimeConstantMs: 30,
  conductionFraction: 0.05,
});

export const LIGHTING_DOCUMENTS: readonly unknown[] = [
  device(SWITCH_1P, 'switch.wall1p', ['a', 'b', 'ground'], SWITCH_PARAMS, {
    controls: [{ id: 'closed', label: 'Switch', type: 'toggle' }],
  }),
  device(SWITCH_3WAY, 'switch.wall3way', ['common', 'ground', 't1', 't2'], SWITCH_PARAMS, {
    controls: [{ id: 'position', label: 'Switch', type: 'selector', options: ['t1', 't2'] }],
  }),
  device(SWITCH_4WAY, 'switch.wall4way', ['a1', 'a2', 'b1', 'b2', 'ground'], SWITCH_PARAMS, {
    controls: [{ id: 'position', label: 'Switch', type: 'selector', options: ['straight', 'crossed'] }],
  }),
  device(
    DIMMER,
    'dimmer.wall',
    ['ground', 'line', 'load'],
    { ratedVoltageV: 120, ratedPowerW: 600 },
    {
      controls: [
        { id: 'on', label: 'Switch', type: 'toggle' },
        { id: 'level', label: 'Level', type: 'setpoint', unit: 'level', min: 0, max: 1, step: 0.05 },
      ],
    },
  ),
  device(
    LAMPHOLDER,
    'lampholder.e26',
    ['ground', 'hot', 'neutral'],
    { ratedPowerW: 660, ratedVoltageV: 250 },
    {
      hostMounts: [
        {
          id: 'socket',
          type: 'e26',
          positionMm: at(0, 0, 0),
          axis: '+x',
          facing: '+z',
          extentMm: 0,
          contacts: [
            { id: 'centre', terminal: 'hot' },
            { id: 'shell', terminal: 'neutral' },
          ],
          bus: null,
        },
      ],
    },
    ['mounts.socket'],
  ),
  device(
    PULL_CHAIN,
    'lampholder.e26PullChain',
    ['centre', 'ground', 'hot', 'neutral'],
    { ratedPowerW: 660, ratedVoltageV: 250 },
    {
      // The socket's centre contact behind the switch: sealed (the kind's rule), no methods.
      terminals: ['centre', 'ground', 'hot', 'neutral'].map((t, i) =>
        t === 'centre' ? { ...terminal(t, 10 * i), access: 'none' } : terminal(t, 10 * i),
      ),
      controls: [{ id: 'closed', label: 'Pull chain', type: 'toggle' }],
      hostMounts: [
        {
          id: 'socket',
          type: 'e26',
          positionMm: at(0, 0, 0),
          axis: '+x',
          facing: '+z',
          extentMm: 0,
          contacts: [
            { id: 'centre', terminal: 'centre' },
            { id: 'shell', terminal: 'neutral' },
          ],
          bus: null,
        },
      ],
    },
    ['mounts.socket'],
  ),
  device(A19_60W, 'lamp.incandescent', ['a', 'b'], lamp(60), { mounts: [E26_FIT] }, E26_COVERS),
  device(A19_100W, 'lamp.incandescent', ['a', 'b'], lamp(100), { mounts: [E26_FIT] }, E26_COVERS),
  device(LED_A19, 'light.led', ['a', 'b'], { ...LED_PARAMS }, { mounts: [E26_FIT] }, E26_COVERS),
  device(LED_FIXTURE, 'light.ledFixture', ['ground', 'hot', 'neutral'], {
    ...LED_PARAMS,
    ratedPowerW: LED_FIXTURE_POWER_W,
  }),
  ...AC_SOURCE_VOLTS.map((volts) =>
    device(acSourceAt(volts), 'test.acSource', ['n', 'l'], { nominalVoltageV: volts }, { category: 'source' }),
  ),
];

/**
 * A lampholder placed clear of everything else (the test hosts place at the origin) with `bulb` screwed
 * into its socket; returns both ids.
 */
export function socket(
  host: SourceHost,
  bulb: { id: string; version: number },
  holderRef: { id: string; version: number } = LAMPHOLDER,
): { holder: number; bulb: number } {
  const positionMm = { x: 5000 + 100 * host.bus.state.nextEntityId, y: 0, z: 0 };
  host.exec('entity.place', { ref: holderRef, positionMm });
  const holder = host.bus.state.nextEntityId - 1;
  host.exec('entity.place', { ref: bulb, positionMm, mountedOn: { entity: holder, mount: 'socket' } });
  return { holder, bulb: host.bus.state.nextEntityId - 1 };
}
