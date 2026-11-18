import { type DeviceStateValue, FiniteNumber, Int } from '@controls/save-format';
import * as z from 'zod';
import type { ModelKindDef, StateKeyDef } from './model-kinds';

/*
 * The lighting model kinds of P4 F4.1 part 1 (plan D10, D11; ADR 0019's key table, ADR 0021 part 3):
 * the wall switches, the dimmer, the E26 lampholder and the LED lamp and fixture. Kept in their own
 * file and spread into `MODEL_KINDS`, so the breakers v2 kinds (P4 PR 10) and these merge without
 * touching each other's lines.
 *
 * None of them reuses `switch.spst`, whose terminal set is fixed (D10). Each wiring device has a
 * `ground` terminal for its yoke's green screw; how that terminal reaches a metal box (a `deviceYoke`
 * fit contact to the box's `chassis`) and which of a terminal's methods it offers (binding screw and,
 * on 15 A switches, a 14 AWG solid copper push-in hole, UL 20 by number; receptacles' are UL 498) are catalogue entry
 * data, not the kind's: a back-stab hole is another method on the same terminal, never another
 * terminal, because the screw and the hole clamp onto one brass plate.
 *
 * The incandescent A19 bulbs keep the P3 kind (`lamp.incandescent`, terminals `a` foot and `b` shell)
 * and reach a lampholder through their `e26` fit; nothing about the kind changes here.
 */

const positive = FiniteNumber.positive();

function key(
  owner: StateKeyDef['owner'],
  type: 'boolean' | 'number',
  schema: z.ZodType<DeviceStateValue>,
  initial: DeviceStateValue,
  description: string,
): StateKeyDef {
  return { owner, type, schema, initial, values: null, description };
}

function enumKey<const V extends readonly [string, ...string[]]>(
  values: V,
  initial: V[number],
  description: string,
): StateKeyDef {
  return { owner: 'commanded', type: 'enum', schema: z.enum(values), initial, values, description };
}

/**
 * A wall switch's nameplate (`switch.wall1p`, `switch.wall3way`, `switch.wall4way`): its AC rating.
 * The simulator reads neither (a closed switch is an ideal join, as `switch.spst`); the inspector and
 * the termination rules do (push-in holes only on 15 A devices).
 */
export const WallSwitchParams = z.strictObject({
  /** Rated current (A, AC), as marked on the strap. */
  ratedCurrentA: positive,
  /** Rated voltage (V, AC), as marked. */
  ratedVoltageV: positive,
});
export type WallSwitchParams = z.infer<typeof WallSwitchParams>;

/**
 * A forward-phase-cut (leading-edge) wall dimmer (`dimmer.wall`, D10): its rated voltage, which the
 * model takes as the supply's open-circuit voltage only to guess its first operating point (it then
 * measures the circuit), and its rated incandescent load, which only the inspector reads.
 */
export const DimmerParams = z.strictObject({
  /** Rated voltage (V, AC). */
  ratedVoltageV: positive,
  /** The largest incandescent load it is rated for (W). */
  ratedPowerW: positive,
});
export type DimmerParams = z.infer<typeof DimmerParams>;

/** A lampholder's nameplate (`lampholder.e26`): the largest lamp it takes. The simulator reads neither. */
export const LampholderParams = z.strictObject({
  /** The largest lamp wattage it is marked for (W). */
  ratedPowerW: positive,
  /** Rated voltage (V). */
  ratedVoltageV: positive,
});
export type LampholderParams = z.infer<typeof LampholderParams>;

/**
 * A constant-power LED driver (`light.led`, `light.ledFixture`, D11): it draws `ratedPowerW` at
 * `powerFactor` (carried as a lagging displacement) whatever its voltage while it runs; it stops below
 * `dropoutVoltageV` and starts again at `restartVoltageV`, a hysteresis band, so it never chatters at
 * the edge. `ratedVoltageV` is its class (120 V), its cold-start guess and the overvoltage class (F4.4).
 */
export const LedDriverParams = z
  .strictObject({
    /** Rated (class) voltage (V, AC). */
    ratedVoltageV: positive,
    /** Input power while running (W), constant over the operating range. */
    ratedPowerW: positive,
    /**
     * The datasheet (true) power factor (0 to 1), carried as a lagging displacement so |I| and the VA
     * match a meter; the phase angle it implies (and its sign) and the harmonic current are abstractions.
     */
    powerFactor: FiniteNumber.gt(0).max(1),
    /** Below this RMS voltage (V) a running driver stops and draws nothing. */
    dropoutVoltageV: positive,
    /** At or above this RMS voltage (V) a stopped driver starts. */
    restartVoltageV: positive,
  })
  .refine((p) => p.restartVoltageV > p.dropoutVoltageV, {
    message: 'restartVoltageV must be above dropoutVoltageV (the hysteresis band)',
  })
  .refine((p) => p.restartVoltageV < p.ratedVoltageV, {
    message: 'restartVoltageV must be below ratedVoltageV, so the driver starts at its rated voltage',
  });
export type LedDriverParams = z.infer<typeof LedDriverParams>;

const LED_KEYS: Readonly<Record<string, StateKeyDef>> = Object.freeze({
  running: key(
    'sim',
    'boolean',
    z.boolean(),
    false,
    "Whether the constant-power driver is running, decided at each solve with hysteresis (it stops below the entry's dropoutVoltageV and starts at its restartVoltageV), so a save inside the band reloads into the same state. A new light starts stopped.",
  ),
  overvoltageSinceTick: key(
    'sim',
    'number',
    Int.min(0).nullable(),
    null,
    'The first tick of the current excursion above ANSI C84.1 Range B for the light’s rated-voltage class (the overvoltage event fires after a dwell from it), or null: no excursion.',
  ),
});

/** The lighting kinds (P4 F4.1 part 1), spread into `MODEL_KINDS`. Keys sorted. */
export const LIGHTING_MODEL_KINDS: Readonly<Record<string, ModelKindDef>> = Object.freeze({
  'dimmer.wall': {
    kind: 'dimmer.wall',
    placement: 'entity',
    terminals: ['ground', 'line', 'load'],
    params: DimmerParams,
    keys: {
      level: key(
        'commanded',
        'number',
        FiniteNumber.min(0).max(1),
        1,
        'The slider (device.operate), 0 (its lowest setting, still lit) to 1 (its highest). The load sees the RMS voltage of a forward-phase-cut sine at the firing angle the level maps to. A new dimmer starts at 1.',
      ),
      on: key(
        'commanded',
        'boolean',
        z.boolean(),
        false,
        'Whether its switch is on (device.operate). Off opens the circuit (an air-gap switch). A new dimmer starts off.',
      ),
    },
    description:
      'A single-pole forward-phase-cut wall dimmer: on, the load sees the RMS voltage of a phase-cut sine at its level, through a lossless series reactance chosen at each solve; off, open. A ground terminal for its yoke.',
  },
  'lampholder.e26': {
    kind: 'lampholder.e26',
    placement: 'entity',
    terminals: ['ground', 'hot', 'neutral'],
    params: LampholderParams,
    keys: {},
    description:
      "A keyless medium-base (E26) lampholder: its brass screw (hot) is the socket's centre contact and its silver screw (neutral) the screw shell, both offered to a bulb through its e26 host mount. No state.",
  },
  'lampholder.e26PullChain': {
    kind: 'lampholder.e26PullChain',
    placement: 'entity',
    terminals: ['centre', 'ground', 'hot', 'neutral'],
    // The socket's centre contact sits behind the pull-chain switch, inside the holder: nothing lands on it.
    sealedTerminals: ['centre'],
    params: LampholderParams,
    keys: {
      closed: key(
        'commanded',
        'boolean',
        z.boolean(),
        false,
        'Whether the pull-chain switch is closed (device.operate), joining the brass screw to the socket’s centre contact. A new holder starts open.',
      ),
    },
    description:
      "A pull-chain medium-base (E26) lampholder: its brass screw (hot) reaches the socket's centre contact (a sealed terminal) only through its pull-chain switch; its silver screw (neutral) is the screw shell. Its e26 host mount offers centre and shell to a bulb.",
  },
  'light.led': {
    kind: 'light.led',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: LedDriverParams,
    keys: LED_KEYS,
    description:
      'An LED lamp (an A19 bulb on an E26 base: a foot and a shell): a constant-power driver that draws its rated watts at its power factor above a dropout voltage and nothing below it.',
  },
  'light.ledFixture': {
    kind: 'light.ledFixture',
    placement: 'entity',
    terminals: ['ground', 'hot', 'neutral'],
    params: LedDriverParams,
    keys: LED_KEYS,
    description:
      'An LED light fixture: the constant-power driver of light.led between its hot and neutral leads, and a ground lead for its housing.',
  },
  'switch.wall1p': {
    kind: 'switch.wall1p',
    placement: 'entity',
    terminals: ['a', 'b', 'ground'],
    params: WallSwitchParams,
    keys: {
      closed: key(
        'commanded',
        'boolean',
        z.boolean(),
        false,
        'Whether the contacts are closed (device.operate). A new switch starts open.',
      ),
    },
    description:
      'A single-pole wall switch: closed joins its two brass terminals, open separates them. A ground terminal for its yoke.',
  },
  'switch.wall3way': {
    kind: 'switch.wall3way',
    placement: 'entity',
    terminals: ['common', 'ground', 't1', 't2'],
    params: WallSwitchParams,
    keys: {
      position: enumKey(
        ['t1', 't2'],
        't1',
        'Which traveller terminal the common is joined to (device.operate, a two-option selector). A new switch starts on t1.',
      ),
    },
    description:
      'A 3-way wall switch (single-pole, double-throw): the common terminal joins one of the two traveller terminals. A ground terminal for its yoke.',
  },
  'switch.wall4way': {
    kind: 'switch.wall4way',
    placement: 'entity',
    terminals: ['a1', 'a2', 'b1', 'b2', 'ground'],
    params: WallSwitchParams,
    keys: {
      position: enumKey(
        ['straight', 'crossed'],
        'straight',
        'straight joins a1–b1 and a2–b2; crossed joins a1–b2 and a2–b1 (device.operate, a two-option selector). A new switch starts straight.',
      ),
    },
    description:
      'A 4-way wall switch (double-pole, double-throw, crossed): two pairs of traveller terminals, passed straight through or crossed over. A ground terminal for its yoke.',
  },
} satisfies Record<string, ModelKindDef>);
