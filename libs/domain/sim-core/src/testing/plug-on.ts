/*
 * TEST-ONLY catalogue entries for breakers v2 (P4 PR 10, ADR 0021 part 2): the plug-on, GFCI and AFCI
 * breaker kinds on test entries, in the engine test catalogue (so the engine's parity guard finds
 * them) and so in the residential one. The real plug-on entries are P4 PR 14's (`content-designer`).
 * Nothing here is a product. The values are the P4 pre-audit's vetted ones (ADR 0021 part 2's
 * reference notes), each restated in the entry's sources:
 *
 * - plug-on 15 and 20 A: the P2 bimetal law (τ 60 s, k_u 1.25); the instantaneous band 240–400 A read
 *   from a maker's published 15–20 A residential curve (absolute, never 8–12 ×); opening above it
 *   8–20 ms (the top read from the curve, the bottom game-design); a pole contact of 5 mΩ (inside the
 *   vetted 5–10 mΩ); the bus stab contact 5 mΩ (test data, PR 9's);
 * - the GFCI breaker: residual pickup 4–6 mA and the mechanism 3–14 ms (vetted); the test resistor
 *   3.9 kΩ (game-design test data: about 31 mA at 120 V, so a held test trips at the Class A limit in
 *   about 0.54 s, inside `GFCI_TEST_HOLD_TICKS`);
 * - the AFCI breakers: a plug-on pole; their detection limits are the region's (UL 1699 by number).
 *
 * Every terminal is clip-reachable so a spec can feed a breaker with a lead as well as from a bus stab.
 */

export const PLUG_ON_15 = { id: 'breaker.test-plug-on-1p-15a', version: 1 };
export const PLUG_ON_20 = { id: 'breaker.test-plug-on-1p-20a', version: 1 };
export const PLUG_ON_2P_20 = { id: 'breaker.test-plug-on-2p-20a', version: 1 };
export const GFCI_20 = { id: 'breaker.test-gfci-1p-20a', version: 1 };
export const AFCI_15 = { id: 'breaker.test-afci-1p-15a', version: 1 };
export const AFCI_20 = { id: 'breaker.test-afci-1p-20a', version: 1 };

/** The bus stab contact of every test breaker (Ω): PR 9's test value. */
export const PLUG_ON_STAB_OHM = 0.005;

/** A plug-on breaker's parameters at `ratedA` (15 or 20 A): the pre-audit's vetted values. */
export function plugOnParams(ratedA: number) {
  return {
    ratedCurrentA: ratedA,
    thermalTimeConstantS: 60,
    ultimateTripRatio: 1.25,
    magneticPickupMinA: 240,
    magneticPickupMaxA: 400,
    openingTimeMinMs: 8,
    openingTimeMaxMs: 20,
    contactResistanceOhm: 0.005,
  };
}

/** The GFCI breaker's sensing parameters (test entry). */
export const GFCI_SENSE_PARAMS = {
  residualPickupMinA: 0.004,
  residualPickupMaxA: 0.006,
  mechanismTimeMinMs: 3,
  mechanismTimeMaxMs: 14,
  testResistanceOhm: 3900,
};

const terminal = (id: string, x: number) => ({
  id,
  label: id,
  positionMm: { x, y: 0, z: 0 },
  methods: [],
  role: null,
  side: null,
  access: 'clip',
});

const PLUG_ON_SOURCE =
  'test data from the P4 pre-audit (ADR 0021 part 2): the P2 bimetal law (τ 60 s, k_u 1.25) inside the read thermal bands at 135 %, 200 %, 500 % and 10 ×; an instantaneous band of 240–400 A read from a maker’s published 15–20 A residential curve; opening 8–20 ms above it (the top read from the curve, the bottom game-design); a 5 mΩ pole (inside the vetted 5–10 mΩ). Never a product.';

function breakerEntry(
  ref: { id: string; version: number },
  title: string,
  kind: string,
  params: Record<string, number>,
  terminals: readonly string[],
  stabs: readonly { contact: string; terminal: string; offset: number }[],
  momentary: boolean,
) {
  const contacts = stabs.map((s) => ({
    id: s.contact,
    terminal: s.terminal,
    host: 'stab',
    positionOffset: s.offset,
    contactOhm: PLUG_ON_STAB_OHM,
  }));
  return {
    ...ref,
    title,
    brand: 'Testbrand',
    modelName: 'B-10',
    category: 'protection',
    sizeMm: { widthMm: 20, heightMm: 80, depthMm: 70 },
    terminals: terminals.map((t, i) => terminal(t, 5 * i)),
    mounts: [{ type: 'busStab', widthMm: 20, crossMm: 0, alongMm: 0, contacts }],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params },
    controls: [
      { id: 'on', label: 'Handle on', type: 'toggle' },
      ...(momentary ? [{ id: 'test', label: 'Test', type: 'momentary' }] : []),
    ],
    sources: [
      {
        id: 'test',
        kind: 'game-design',
        citation: `game-design: test only. ${PLUG_ON_SOURCE}`,
        covers: [
          'sizeMm',
          'terminals',
          'fits.busStab',
          ...stabs.map((s) => `fits.busStab.contacts.${s.contact}.contactOhm`),
          ...Object.keys(params).map((p) => `model.params.${p}`),
        ],
      },
    ],
    extensions: {},
  };
}

const ONE_POLE = [{ contact: 'line1', terminal: 'line', offset: 0 }];
const SENSING_TERMINALS = ['line', 'load', 'loadNeutral', 'pigtail'];

/** The breakers-v2 test entries (in `ENGINE_DOCUMENTS`). */
export const PLUG_ON_DOCUMENTS: readonly unknown[] = [
  breakerEntry(
    PLUG_ON_15,
    'Test 15 A plug-on breaker',
    'breaker.plugOn1p',
    plugOnParams(15),
    ['line', 'load'],
    ONE_POLE,
    false,
  ),
  breakerEntry(
    PLUG_ON_20,
    'Test 20 A plug-on breaker',
    'breaker.plugOn1p',
    plugOnParams(20),
    ['line', 'load'],
    ONE_POLE,
    false,
  ),
  breakerEntry(
    PLUG_ON_2P_20,
    'Test 20 A two-pole plug-on breaker',
    'breaker.plugOn2p',
    plugOnParams(20),
    ['line1', 'line2', 'load1', 'load2'],
    [
      { contact: 'line1', terminal: 'line1', offset: 0 },
      { contact: 'line2', terminal: 'line2', offset: 1 },
    ],
    false,
  ),
  breakerEntry(
    GFCI_20,
    'Test 20 A GFCI breaker',
    'breaker.gfci1p',
    { ...plugOnParams(20), ...GFCI_SENSE_PARAMS },
    SENSING_TERMINALS,
    ONE_POLE,
    true,
  ),
  breakerEntry(
    AFCI_15,
    'Test 15 A AFCI breaker',
    'breaker.afci1p',
    plugOnParams(15),
    SENSING_TERMINALS,
    ONE_POLE,
    true,
  ),
  breakerEntry(
    AFCI_20,
    'Test 20 A AFCI breaker',
    'breaker.afci1p',
    plugOnParams(20),
    SENSING_TERMINALS,
    ONE_POLE,
    true,
  ),
];
