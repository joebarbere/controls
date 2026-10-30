import { type DeviceStateValue, FiniteNumber, Int } from '@controls/save-format';
import { z } from 'zod';

/*
 * Device model kinds (plan P2 decision D4, ADR 0011 §1, ADR 0013). A catalogue entry names its kind
 * (`model.kind`); the kind decides, in code:
 *
 * - its parameters (`model.params`), validated when the catalogue loads;
 * - which terminals every device of the kind has;
 * - every key of its two state bags: the owner (`commanded`, written only by commands, persisted in
 *   `EntityV2.state`; or `sim`, written only by the sim engine through `materialiseWorld`, persisted
 *   in `EntityV2.sim`), the value's Zod schema and its initial value.
 *
 * The state keys are save format: **adding a kind needs no `schemaVersion` bump, changing an existing
 * kind's keys (adding, removing, renaming or narrowing one) does**, with a migration of every save's
 * bags. Parameters are catalogue data: changing a parameter schema changes the catalogue, not the save.
 * The P2 kinds here are provisional until their device-model PRs (F2.4, F2.5) finalise them with
 * `sim-engine-engineer`; they are frozen once v0.3.0 ships.
 */

/** Who writes a state key (ADR 0011 §1). Commands never read `sim` keys. */
export type StateOwner = 'commanded' | 'sim';

/** The JSON type of a state value, which decides the controls that can drive it. */
export type StateValueType = 'boolean' | 'number' | 'enum';

/** One key of a device state bag. */
export interface StateKeyDef {
  readonly owner: StateOwner;
  readonly type: StateValueType;
  /** Validates the value. Always narrower than `DeviceStateValue` (a property test checks it). */
  readonly schema: z.ZodType<DeviceStateValue>;
  /**
   * The value a newly placed device starts with (`entity.place`). `null` (for a `sim` key) means the
   * engine initialises it when the device enters the netlist, from the device's params or a sourced
   * `sim-core` constant (the lamp's filament starts at ambient), and never exports `null` after that.
   * The key stays nullable in its schema, because a world saved before the engine first ran holds `null`.
   */
  readonly initial: DeviceStateValue;
  /** For `type: 'enum'`, every value the key can hold. */
  readonly values: readonly string[] | null;
  readonly description: string;
}

/** How a device exists in the world. */
export type Placement =
  /** A placed entity (`entity.place`) with terminals and both state bags. */
  | 'entity'
  /** A connection between two terminals (`lead.connect`): no entity, no terminals, no state. */
  | 'connection';

export interface ModelKindDef {
  readonly kind: string;
  readonly placement: Placement;
  /** The terminal ids every device of this kind has, sorted. Empty for connections. */
  readonly terminals: readonly string[];
  /** Validates `model.params` of a catalogue entry (a strict object of numbers). */
  readonly params: z.ZodType<Readonly<Record<string, number>>>;
  /** Every state key, by name. Names are unique across both bags. */
  readonly keys: Readonly<Record<string, StateKeyDef>>;
  readonly description: string;
}

const positive = FiniteNumber.positive();

/** Battery parameters (provisional; F2.4 finalises the model: EMF against state of charge, internal resistance). */
export const BatteryParams = z
  .strictObject({
    /** Nameplate voltage (V). */
    nominalVoltageV: positive,
    /** Open-circuit voltage at full charge (V). */
    openCircuitVoltageFullV: positive,
    /** Open-circuit voltage at the end of discharge (V). */
    openCircuitVoltageEmptyV: positive,
    /** Internal resistance at full charge (Ω). */
    internalResistanceOhm: positive,
    /** Rated capacity (A·h) at the rated discharge rate. */
    capacityAh: positive,
  })
  .refine((p) => p.openCircuitVoltageFullV > p.openCircuitVoltageEmptyV, {
    message: 'openCircuitVoltageFullV must be above openCircuitVoltageEmptyV',
  });
export type BatteryParams = z.infer<typeof BatteryParams>;

/** SPST switch parameters: none in P2 (a closed switch is an ideal merge, F2.1). Ratings arrive with P4. */
export const SwitchSpstParams = z.strictObject({});
export type SwitchSpstParams = z.infer<typeof SwitchSpstParams>;

/** Incandescent lamp parameters (provisional; F2.5 adds the filament model). */
export const LampIncandescentParams = z.strictObject({
  /** Rated (design) voltage (V). */
  ratedVoltageV: positive,
  /**
   * Rated power (W), taken at the rated voltage. A lamp category may define its wattage at another test
   * voltage (UNECE R37's W5W: 13.5 V); taking it at the rated voltage is a game-design simplification.
   */
  ratedPowerW: positive,
});
export type LampIncandescentParams = z.infer<typeof LampIncandescentParams>;

/**
 * Test lead parameters. The conductor's resistance is derived, never tabulated (plan P2, ADR 0003:
 * no NEC tables): R(T) = ρ₀ · L / A · (1 + α · (T − T₀)), see `leadResistanceOhm`.
 */
export const LeadParams = z.strictObject({
  /** Conductor length (integer mm, like all geometry). */
  lengthMm: Int.min(1),
  /** Conductor cross-sectional area (m²). */
  conductorAreaM2: positive,
  /** Conductor resistivity ρ₀ at the reference temperature (Ω·m). */
  resistivityOhmM: positive,
  /** Temperature coefficient of resistance α at the reference temperature (1/K). */
  temperatureCoefficientPerK: FiniteNumber.min(0),
  /** Reference temperature T₀ of ρ₀ and α (K). */
  referenceTemperatureK: positive,
  /** Contact resistance at each end, where the clip meets a terminal (Ω). */
  contactResistanceOhm: FiniteNumber.min(0),
});
export type LeadParams = z.infer<typeof LeadParams>;

function key(
  owner: StateOwner,
  type: Exclude<StateValueType, 'enum'>,
  schema: z.ZodType<DeviceStateValue>,
  initial: DeviceStateValue,
  description: string,
): StateKeyDef {
  return { owner, type, schema, initial, values: null, description };
}

/**
 * Every model kind, by name. Keys sorted. P2: the battery, the SPST switch and the incandescent lamp
 * (the bench demo), plus the test lead. The fuse, breaker, supplies, resistor and heater arrive with
 * their device-model PRs (F2.4, F2.5); adding them needs no `schemaVersion` bump.
 */
export const MODEL_KINDS: Readonly<Record<string, ModelKindDef>> = Object.freeze({
  battery: {
    kind: 'battery',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: BatteryParams,
    keys: {
      stateOfCharge: key(
        'sim',
        'number',
        FiniteNumber.min(0).max(1),
        1,
        'Remaining charge as a fraction of the rated capacity (0 to 1), coulomb-counted by the engine. A new battery starts full.',
      ),
    },
    description: 'A battery: an EMF that falls with the state of charge, behind an internal resistance.',
  },
  'lamp.incandescent': {
    kind: 'lamp.incandescent',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: LampIncandescentParams,
    keys: {
      filamentTempK: key(
        'sim',
        'number',
        FiniteNumber.positive().nullable(),
        null,
        'Filament temperature (K). null until the engine first netlists the lamp; it then initialises it at a sourced ambient constant and never exports null again.',
      ),
    },
    description: 'An incandescent lamp: a tungsten filament whose resistance rises with its temperature.',
  },
  lead: {
    kind: 'lead',
    placement: 'connection',
    terminals: [],
    params: LeadParams,
    keys: {},
    description: 'A test lead: a resistive connection between two terminals, made with lead.connect.',
  },
  'switch.spst': {
    kind: 'switch.spst',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: SwitchSpstParams,
    keys: {
      closed: key(
        'commanded',
        'boolean',
        z.boolean(),
        false,
        'Whether the contacts are closed (set with device.operate). A new switch starts open.',
      ),
    },
    description: 'A single-pole, single-throw switch: closed joins its two terminals, open separates them.',
  },
} satisfies Record<string, ModelKindDef>);

/** The model kind `kind`, or `undefined`. Own properties only (`toString` is not a kind). */
export function modelKind(kind: string): ModelKindDef | undefined {
  return Object.prototype.hasOwnProperty.call(MODEL_KINDS, kind) ? MODEL_KINDS[kind] : undefined;
}

/** The keys of `kind` owned by `owner`, sorted. */
export function stateKeys(kind: ModelKindDef, owner: StateOwner): string[] {
  return Object.keys(kind.keys)
    .filter((name) => kind.keys[name].owner === owner)
    .sort();
}

/** The bags a newly placed device of `kind` starts with: every key at its initial value. */
export function initialBags(kind: ModelKindDef): {
  state: Record<string, DeviceStateValue>;
  sim: Record<string, DeviceStateValue>;
} {
  const bag = (owner: StateOwner) =>
    Object.fromEntries(stateKeys(kind, owner).map((name) => [name, kind.keys[name].initial]));
  return { state: bag('commanded'), sim: bag('sim') };
}

/**
 * Strict Zod schemas for `kind`'s two bags: every key present (`null` for absent), no other key.
 * Exported as `json-schema/device-state.<kind>.schema.json`.
 */
export function bagSchemas(kind: ModelKindDef): {
  state: z.ZodType<Record<string, DeviceStateValue>>;
  sim: z.ZodType<Record<string, DeviceStateValue>>;
} {
  const bag = (owner: StateOwner) =>
    z.strictObject(Object.fromEntries(stateKeys(kind, owner).map((name) => [name, kind.keys[name].schema])));
  return { state: bag('commanded'), sim: bag('sim') };
}

/** One problem with a device's state bags. Never echoes the value. */
export interface BagIssue {
  /** `state.closed`, `sim.stateOfCharge`, … */
  readonly path: string;
  readonly message: string;
}

/**
 * Checks an entity's two bags against its model kind (the load check, error `invalid-device-state`):
 * exactly the kind's keys in each bag, each value accepted by its key's schema.
 */
export function checkBags(
  kind: ModelKindDef,
  state: Readonly<Record<string, DeviceStateValue>>,
  sim: Readonly<Record<string, DeviceStateValue>>,
): BagIssue[] {
  const issues: BagIssue[] = [];
  const check = (bagName: 'state' | 'sim', owner: StateOwner, bag: Readonly<Record<string, DeviceStateValue>>) => {
    const expected = stateKeys(kind, owner);
    for (const name of Object.keys(bag).sort()) {
      if (!expected.includes(name)) {
        issues.push({ path: `${bagName}.${name}`, message: `Not a ${owner} key of model kind ${kind.kind}` });
      }
    }
    for (const name of expected) {
      if (!Object.prototype.hasOwnProperty.call(bag, name)) {
        issues.push({ path: `${bagName}.${name}`, message: 'Missing (an absent value is null, never a missing key)' });
      } else if (!kind.keys[name].schema.safeParse(bag[name]).success) {
        issues.push({ path: `${bagName}.${name}`, message: `Not a valid ${kind.kind} ${name} value` });
      }
    }
  };
  check('state', 'commanded', state);
  check('sim', 'sim', sim);
  return issues;
}
