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

/**
 * Battery parameters (F2.4). The EMF is the rested open-circuit voltage, linear in the state of charge
 * between `openCircuitVoltageEmptyV` (0) and `openCircuitVoltageFullV` (1), behind a constant
 * `internalResistanceOhm`; `capacityAh` is what coulomb counting divides by (`sim-core`'s battery model).
 */
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

/**
 * Bench DC supply parameters (F2.4): a constant-voltage/constant-current supply whose setpoint and
 * current limit the player sets (`device.operate`) up to its maximums.
 */
export const BenchSupplyParams = z.strictObject({
  /** The highest voltage setpoint (V). */
  maxVoltageV: positive,
  /** The highest current limit (A). */
  maxCurrentA: positive,
  /**
   * The output resistance in constant-voltage mode (Ω): the regulated output's droop with load, from
   * its load-regulation figure. Never 0, so supplies in parallel are never an ideal-source loop.
   */
  outputResistanceOhm: positive,
});
export type BenchSupplyParams = z.infer<typeof BenchSupplyParams>;

/**
 * DIN-rail switch-mode power supply parameters (F2.4): a fixed output voltage with a current limit
 * that, when it holds for `hiccupDetectMs`, switches the output off for `hiccupOffMs` and retries
 * (hiccup mode). Times are integer milliseconds, so ticks (1 tick = 1 ms).
 */
export const DinPsuParams = z
  .strictObject({
    /** The regulated output voltage (V). */
    ratedVoltageV: positive,
    /** The rated continuous output current (A). */
    ratedCurrentA: positive,
    /** Where the current limit holds the output (A): at or above the rating. */
    currentLimitA: positive,
    /** The output resistance in regulation (Ω), from its load-regulation figure. Never 0. */
    outputResistanceOhm: positive,
    /** How long the output may sit in current limit before it shuts down (ms, = ticks). */
    hiccupDetectMs: Int.min(1),
    /** How long it stays off before it retries (ms, = ticks). */
    hiccupOffMs: Int.min(1),
  })
  .refine((p) => p.currentLimitA >= p.ratedCurrentA, { message: 'currentLimitA must be at least ratedCurrentA' });
export type DinPsuParams = z.infer<typeof DinPsuParams>;

/**
 * An AC source behind a transformer's (or an alternator's) impedance (F2.4): the utility services and
 * the portable generator stub. The impedance is derived, never tabulated: on the source's own base,
 * Z = (%Z / 100) · V_LL² / S, split into R and X by the X/R ratio (`sim-core`'s `sourceImpedance`).
 */
export const AcSourceParams = z.strictObject({
  /** Rated apparent power (kVA): the base of the per-unit impedance. */
  ratedKva: positive,
  /** Impedance at its rating, in percent of its base (%Z; a generator's subtransient reactance). */
  percentImpedance: positive,
  /** Reactance over resistance of that impedance. */
  xOverR: positive,
  /**
   * Line-to-neutral EMF (V, RMS): the exact magnitude each phase is built from. The line-to-line
   * voltage follows from the phase angles (2 × for split-phase, √3 × for wye), never from a name.
   */
  lineToNeutralV: positive,
});
export type AcSourceParams = z.infer<typeof AcSourceParams>;

/** SPST switch parameters: none in P2 (a closed switch is an ideal merge, F2.1). Ratings arrive with P4. */
export const SwitchSpstParams = z.strictObject({});
export type SwitchSpstParams = z.infer<typeof SwitchSpstParams>;

/**
 * Incandescent lamp parameters (F2.5): the rated point and the filament's thermal behaviour. The
 * filament's resistance is R(T) = (V_r² / P_r) · ρ(T) / ρ(T_r) from tungsten's resistivity
 * (`sim-core`'s lamp model), so the cold resistance and the inrush follow from the material.
 */
export const LampIncandescentParams = z.strictObject({
  /** Rated (design) voltage (V). */
  ratedVoltageV: positive,
  /**
   * Rated power (W), taken at the rated voltage. A lamp category may define its wattage at another test
   * voltage (UNECE R37's W5W: 13.5 V); taking it at the rated voltage is a game-design simplification.
   */
  ratedPowerW: positive,
  /** Filament temperature at the rated voltage and power (K), inside tungsten's tabulated 300–3600 K. */
  filamentRatedTempK: FiniteNumber.min(1000).max(3600),
  /** The filament's thermal time constant at its rated point (ms): how fast it heats and cools there. */
  thermalTimeConstantMs: positive,
});
export type LampIncandescentParams = z.infer<typeof LampIncandescentParams>;

/** Resistor parameters (F2.5): a fixed resistance and the power it is rated to dissipate. */
export const ResistorParams = z.strictObject({
  /** Resistance (Ω). */
  resistanceOhm: positive,
  /** Rated dissipation (W): above it the record says `overRated` (no damage model in P2). */
  powerRatingW: positive,
});
export type ResistorParams = z.infer<typeof ResistorParams>;

/** Heater parameters (F2.5): rated watts at rated volts, a fixed resistance R = V_r² / P_r. */
export const HeaterParams = z.strictObject({
  /** Rated voltage (V). */
  ratedVoltageV: positive,
  /** Rated power at the rated voltage (W). */
  ratedPowerW: positive,
});
export type HeaterParams = z.infer<typeof HeaterParams>;

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

function enumKey<const V extends readonly [string, ...string[]]>(
  owner: StateOwner,
  values: V,
  initial: V[number],
  description: string,
): StateKeyDef {
  return { owner, type: 'enum', schema: z.enum(values), initial, values, description };
}

/**
 * Every model kind, by name. Keys sorted. P2: the battery, the SPST switch and the incandescent lamp
 * (the bench demo), the test lead, F2.4's bench supply, DIN-rail supply, utility services
 * (split-phase and three-phase, headless in P2) and portable generator stub, and F2.5's resistor and
 * heater. The fuse and breaker arrive with F2.5 part 2; adding a kind needs no `schemaVersion` bump.
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
  'generator.portable': {
    kind: 'generator.portable',
    placement: 'entity',
    terminals: ['l1', 'l2', 'n'],
    params: AcSourceParams,
    keys: {},
    description:
      'A portable generator (a stub): a 120/240 V split-phase EMF behind its nameplate source impedance, with no engine dynamics.',
  },
  heater: {
    kind: 'heater',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: HeaterParams,
    keys: {},
    description: 'A resistance heater: its rated watts at its rated volts, a fixed resistance.',
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
  resistor: {
    kind: 'resistor',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: ResistorParams,
    keys: {},
    description: 'A fixed resistor with a power rating; its record says when it is over-rated (no damage model in P2).',
  },
  'supply.bench': {
    kind: 'supply.bench',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: BenchSupplyParams,
    keys: {
      currentLimitA: key(
        'commanded',
        'number',
        FiniteNumber.min(0),
        1,
        "Current limit (A), set with device.operate up to the supply's maxCurrentA. A new supply starts at 1 A.",
      ),
      mode: enumKey(
        'sim',
        ['cv', 'cc'],
        'cv',
        'Regulation mode the engine last settled in: constant voltage or constant current. Kept so the crossover has hysteresis (no chatter) and a load continues in the same mode.',
      ),
      outputOn: key(
        'commanded',
        'boolean',
        z.boolean(),
        false,
        'Whether the output is switched on (device.operate). A new supply starts with its output off.',
      ),
      setpointV: key(
        'commanded',
        'number',
        FiniteNumber.min(0),
        12,
        "Voltage setpoint (V), set with device.operate up to the supply's maxVoltageV. A new supply starts at 12 V.",
      ),
    },
    description:
      'A bench DC supply: constant voltage behind a small output resistance up to its current limit, then constant current.',
  },
  'supply.dinPsu': {
    kind: 'supply.dinPsu',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: DinPsuParams,
    keys: {
      mode: enumKey(
        'sim',
        ['ok', 'limit', 'hiccupOff'],
        'ok',
        'Where the supply is: regulating (ok), holding its current limit, or switched off between hiccup retries.',
      ),
      phaseTicks: key(
        'sim',
        'number',
        Int.min(0),
        0,
        'Ticks spent in the current overload (limit) or off period (hiccupOff); 0 while regulating.',
      ),
    },
    description:
      'A DIN-rail switch-mode supply: a fixed voltage with a current limit that hiccups (off, then retry) under a sustained overload.',
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
  'utility.splitPhase': {
    kind: 'utility.splitPhase',
    placement: 'entity',
    terminals: ['l1', 'l2', 'n'],
    params: AcSourceParams,
    keys: {},
    description:
      'A utility service, single-phase three-wire (120/240 V): L1 and L2 180° apart about the neutral, behind the transformer impedance.',
  },
  'utility.threePhase': {
    kind: 'utility.threePhase',
    placement: 'entity',
    terminals: ['l1', 'l2', 'l3', 'n'],
    params: AcSourceParams,
    keys: {},
    description:
      'A utility service, three-phase four-wire wye: L1, L2 and L3 120° apart about the neutral, behind the transformer impedance.',
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
