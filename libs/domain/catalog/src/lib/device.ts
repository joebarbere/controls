import {
  BUILTIN_PROP_PREFIX,
  CatalogId,
  CatalogRef,
  DeviceStateKey,
  Extensions,
  FiniteNumber,
  Int,
  MAX_DEVICE_STATE_STRING,
  SafeString,
  TerminalId,
} from '@controls/save-format';
import * as z from 'zod';
import { Awg, AwgRange } from './gauge';
import {
  Axis,
  DriveType,
  ClampType,
  ColourId,
  ConductorStranding,
  ContactId,
  EnclosureMaterial,
  EntryId,
  MountId,
  NemaConfigId,
  OutletId,
  PinId,
  TerminalAccess,
  TerminalRole,
  TerminalSide,
  TerminalStranding,
  TerminationMethodId,
  TradeSize,
} from './registries';
import { CatalogSource } from './sources';
import { TableRef } from './tables';

/*
 * The device entry format, catalogue format v3 (P4, ADR 0020; v2 was ADR 0016's, v1 ADR 0013's). One device definition
 * per file in `content/devices/` (`<id>.v<version>.json`). Saves reference an entry by `{ id, version }`
 * and never inline it (ADR 0004), so a content fix reaches old saves. Every number in an entry has a
 * `source` (realism charter, plan §3), and brands are fictional.
 *
 * Catalogue v2 adds, with no field optional (absent is `null` or `[]`): per-method termination specs
 * on terminals, the mounts a device fits, enclosure data (mounts, entries, interior volume) and
 * conductor product data (gauge, stranding, pinned material and insulation rows, colours).
 *
 * Catalogue v3 adds, again with no field optional: terminal `role`, `side` and `access`; a per-method
 * `multiConductor` cap; mount contacts on both sides of a mount (a device's `mounts[].contacts`, a
 * host's `EnclosureMount.contacts` and `bus` pattern) and a mount anchor (`alongMm`); `hostMounts` for
 * a device that offers a mount without being an enclosure (a lampholder's `e26`); enclosure
 * `markedVolumeMm3`, `material` and bus `spaces`; receptacle `outlets` and an appliance `plug` over
 * `NEMA_CONFIGS`; `supersededBy`; and the `momentary` control type. The fields the inspector reads
 * (`role`, `side`, `multiConductor`, `markedVolumeMm3`, `material`) are never read by the simulator.
 *
 * This schema validates one entry's shape; `parseCatalog` adds the rules that need the model kind
 * (parameters, terminals, controls), the registries, the tables, and source coverage.
 */

const Label = (max: number) => SafeString.min(1).max(max);

/** Outer size in the device's own frame: width along +x, height along +y, depth along +z (integer mm). */
export const DeviceSizeMm = z.strictObject({
  widthMm: Int.min(1),
  heightMm: Int.min(1),
  depthMm: Int.min(1),
});

/** A point in an entity's own frame (integer mm). */
export const PointMm = z.strictObject({ x: Int, y: Int, z: Int });
export type PointMm = z.infer<typeof PointMm>;

/**
 * A twist-on splice's rated conductor combinations (ADR 0018 §4.4, §8): a count range, a size range
 * and a total-size range. Bounds paraphrased from public packaging data under a fictional brand, never
 * a reproduced combination chart. The total size is the sum of the landed conductors' integer
 * `AWG_GAUGES[n].areaUm2`, so the check is exact integer arithmetic.
 */
export const TwistOnCombination = z
  .strictObject({
    /** The fewest conductors the splice is rated for. */
    minConductors: Int.min(1).max(16),
    /** The most; equals the method spec's `maxConductors`. */
    maxConductors: Int.min(1).max(16),
    /** The conductor sizes each landed conductor must lie in (integer AWG designations). */
    awg: AwgRange,
    /** The landed conductors' total area (integer µm², from `AWG_GAUGES[n].areaUm2`), bounds inclusive. */
    totalAreaUm2: z.strictObject({ min: Int.min(0), max: Int.min(1) }),
  })
  .refine((c) => c.minConductors <= c.maxConductors, { message: 'minConductors must not exceed maxConductors' })
  .refine((c) => c.totalAreaUm2.min <= c.totalAreaUm2.max, { message: 'totalAreaUm2.min must not exceed its max' });
export type TwistOnCombination = z.infer<typeof TwistOnCombination>;

/**
 * A termination method's multi-conductor cap (catalogue v3, the carried P3 item): a 4 mm² screw cage
 * takes two conductors only of equal size and only up to about 16 AWG. Integer AWG designations.
 */
export const MultiConductor = z.strictObject({
  /** The sizes each conductor must lie in when two or more are landed (inside the method's `awgRange`). */
  awgRange: AwgRange,
  /** Whether every conductor landed together must be the same size. */
  equalSize: z.boolean(),
});
export type MultiConductor = z.infer<typeof MultiConductor>;

/**
 * How conductors may be landed on a terminal by one method (ADR 0015). A terminal lists its methods
 * in a save-format order: `'auto'` takes the first. From catalogue 2 on its values count as
 * electrical (changing one after v0.4.0 is a new entry version).
 */
export const TerminalMethodSpec = z
  .strictObject({
    /** A method in `TERMINATION_METHODS` (`screw`, `springCage`, `backStab`, `twistOn`), unique within the terminal. */
    method: TerminationMethodId,
    /** How many conductors the terminal is rated for by this method; more (up to `maxConductors`) make a worse termination. */
    ratedConductors: Int.min(1).max(16),
    /** How many physically fit (`terminal-full` beyond it). May be game-design. */
    maxConductors: Int.min(1).max(16),
    /** The conductor sizes it accepts, as integer AWG designations (4/0 = -3). */
    awgRange: AwgRange,
    /** What it accepts: solid, bare stranded, stranded in a ferrule. */
    stranding: z.array(TerminalStranding).min(1).max(3),
    /** The insulation to strip (integer mm): nominal and the tolerance either side. */
    stripLengthMm: z.strictObject({ nominal: Int.min(1).max(100), tolerance: Int.min(0).max(50) }),
    /** The marked tightening torque (N·m) of a clamp-torque method; `null` for every other method. */
    torqueNm: FiniteNumber.positive().nullable(),
    /**
     * The screw's drive types (F3.4 part 1, ADR 0016 amendment): non-empty exactly for a clamp-torque
     * method, whose driver must fit one (`wrong-drive`); empty (the default) for every other method.
     */
    drives: z.array(DriveType).max(5),
    /** Whether the method is rated for aluminium conductors (CO/ALR, AL/CU). */
    alRated: z.boolean(),
    /** Where the conductor enters the terminal, in the device's own frame (integer mm). */
    entryMm: PointMm,
    /** The direction a landed conductor leaves the terminal, in the device's own frame. */
    exitAxis: Axis,
    /**
     * How the conductor is held (ADR 0018 §8; one of the method's `clampTypes`): only a `bindingScrew`
     * splays a bare stranded conductor (§4.3).
     */
    clampType: ClampType,
    /** The length of conductor the clamp grips (integer mm, 1..50, at most the nominal strip length); a shorter strip seats like less torque (§4.3). */
    clampDepthMm: Int.min(1).max(50),
    /** R₀ (Ω): the contact resistance at the marked torque (or the spring's force), copper conductor, at T₀ (§4.1). */
    contactOhm: FiniteNumber.positive(),
    /** G_term (W/K): the hot spot's heat path into the device at ambient (§3.3; F3.6 reads it). */
    heatPathWPerK: FiniteNumber.positive(),
    /** C_h (J/K): the clamp parts' heat capacity, the hot-spot node's (§3.3; F3.6 reads it). */
    hotSpotHeatCapacityJPerK: FiniteNumber.positive(),
    /** A twist-on splice's rated combinations (§4.4): non-null exactly for `twistOn`. */
    combination: TwistOnCombination.nullable(),
    /**
     * The sizes this method takes when more than one conductor is landed (catalogue v3, ADR 0020): each
     * of them inside `awgRange` and, if `equalSize`, all the same size. `null`: no limit beyond the
     * method's own range (every catalogue-2 spec). Non-null only when `maxConductors` is at least 2.
     */
    multiConductor: MultiConductor.nullable(),
  })
  .refine((m) => m.maxConductors >= m.ratedConductors, { message: 'maxConductors must be at least ratedConductors' })
  .refine((m) => new Set(m.stranding).size === m.stranding.length, { message: 'stranding values must be unique' })
  .refine((m) => new Set(m.drives).size === m.drives.length, { message: 'drives must be unique' })
  .refine((m) => m.stripLengthMm.tolerance < m.stripLengthMm.nominal, {
    message: 'the strip-length tolerance must be below the nominal length',
  })
  .refine((m) => m.clampDepthMm <= m.stripLengthMm.nominal, {
    message: 'clampDepthMm must not exceed the nominal strip length',
  });
export type TerminalMethodSpec = z.infer<typeof TerminalMethodSpec>;

/** The most termination methods a terminal lists (catalogue format; the netlist compiler strides its landed counts by it). */
export const MAX_TERMINAL_METHODS = 8;

/** A terminal: where a lead's clip and, from P3, a conductor lands. */
export const DeviceTerminal = z.strictObject({
  id: TerminalId,
  /** What the device's marking says (`+`, `−`, `1`). Display text only. */
  label: Label(16),
  /** Position in the device's own frame (integer mm), for drawing leads and picking. */
  positionMm: PointMm,
  /** How conductors land on it, in save-format order; empty for a clip-only terminal (`wrong-method`). */
  methods: z.array(TerminalMethodSpec).max(MAX_TERMINAL_METHODS),
  /** What the terminal is for (catalogue v3): the inspector's, never the simulator's; `null` for none. */
  role: TerminalRole.nullable(),
  /** A GFCI device's line or load side (catalogue v3); `null` on every other terminal. */
  side: TerminalSide.nullable(),
  /** What can reach it (catalogue v3): `land` exactly when it has methods; `clip` or `none` otherwise. */
  access: TerminalAccess,
});
export type DeviceTerminal = z.infer<typeof DeviceTerminal>;

/**
 * One contact a mounted device makes with its host (catalogue v3, ADR 0019 "What the netlist compiler
 * reads" 1): the compiler joins the device's `terminal` to the host terminal the host mount maps
 * `host` to (for a bus, the leg of the stab `positionOffset` positions along from the device's own)
 * through one resistor of `contactOhm`, never an ideal join.
 */
export const MountContact = z.strictObject({
  /** Unique within the fit; carried by the contact branch's `ElementRef` and hashed (`topologyHash`). */
  id: ContactId,
  /** The device's own terminal it joins. */
  terminal: TerminalId,
  /** The host contact it touches: one of its mount type's `hostContacts`. */
  host: ContactId,
  /** Whole stab positions along a bus from the device's own (line 1 → 0, line 2 → 1); 0 on any other mount. */
  positionOffset: Int.min(0).max(3),
  /** R (Ω): the contact's resistance, sourced at `fits.<type>.contacts.<id>.contactOhm`. */
  contactOhm: FiniteNumber.positive(),
});
export type MountContact = z.infer<typeof MountContact>;

/** A mount type a device fits, and the width it takes along such a mount (D11). */
export const DeviceMount = z.strictObject({
  /** A type in `MOUNT_TYPES` (`din35`, `deviceYoke`), unique within the entry. */
  type: z.string().max(32),
  /** Width along the mount's axis (integer mm), for `mount-full` and overlap. */
  widthMm: Int.min(1),
  /**
   * Where the device's origin sits across a `linear` mount (integer mm along the mount's +y from its
   * origin; F3.5 part 2, an ADR 0016 amendment). A DIN rail's mount origin is where a DIN 43880
   * modular device's bottom edge goes (45 mm below the rail centreline), so a modular device declares
   * 0; a shorter one centred on the rail, such as a terminal block, declares 45 - floor(height / 2).
   * Catalogue v3: may also be non-zero on a `single` mount (the anchor, with `alongMm`); must be 0 on an
   * `area` mount (load-checked).
   */
  crossMm: Int.min(-1000).max(1000),
  /**
   * The mount anchor along the mount's axis (catalogue v3, ADR 0019 R4; integer mm): where the device's
   * origin sits from a `single` mount's origin, so different devices on one kind of mount (bulbs on an
   * E26 socket) share its axis. 0 on `linear` and `area` mounts, where the device's place along the
   * mount is the player's (load-checked), and on every catalogue-2 entry.
   */
  alongMm: Int.min(-1000).max(1000),
  /** The contacts the device makes with its host when mounted (catalogue v3); `[]` for none (every catalogue-2 fit). */
  contacts: z.array(MountContact).max(8),
});
export type DeviceMount = z.infer<typeof DeviceMount>;

/**
 * A bus mount's stab pattern (catalogue v3, ADR 0019 "What the netlist compiler reads" 2): stab k
 * (from 0) sits at `k × pitchMm` along the mount from its origin, looked up exactly (`busStabIndex`,
 * never by division), and reaches the host terminal `legs[k mod 2]`: each column alternates legs by
 * row. A column whose stabs count the other way lists its legs the other way round.
 */
export const BusPattern = z.strictObject({
  /** The stab pitch along the mount (integer mm). */
  pitchMm: Int.min(1).max(200),
  /** How many stabs the column has; the last sits within the mount's `extentMm`. */
  stabs: Int.min(1).max(42),
  /** The host terminals even and odd stabs reach (the two bus bars), in that order. */
  legs: z.tuple([TerminalId, TerminalId]),
});
export type BusPattern = z.infer<typeof BusPattern>;

/** A host contact a mount offers, and the host terminal it reaches (catalogue v3). */
export const HostContact = z.strictObject({ id: ContactId, terminal: TerminalId });
export type HostContact = z.infer<typeof HostContact>;

/**
 * A mount an enclosure offers (D11). Its frame is the mounted device's: the device's +x lies along
 * `axis` and its +z (its front) faces `facing`, both in the enclosure's frame.
 */
export const EnclosureMount = z
  .strictObject({
    id: MountId,
    /** A type in `MOUNT_TYPES`. */
    type: z.string().max(32),
    /** The mount's origin in the enclosure's frame (integer mm): one end of a rail, a yoke's centre. */
    positionMm: PointMm,
    /** The direction a device slides along (a rail's length), and the mounted device's +x. */
    axis: Axis,
    /** The direction the mounted device's front (+z) faces. */
    facing: Axis,
    /** Usable length along `axis` from `positionMm` (integer mm); 0 for a single-device mount. */
    extentMm: Int.min(0),
    /**
     * The host contacts this mount offers, each mapped to one of the host's terminals (catalogue v3):
     * ids from its mount type's `hostContacts`, each once. `[]` offers none: a device's contacts on it
     * then add nothing (a yoke on a nonmetallic box). A bus mount maps its `stab` through `bus` instead.
     */
    contacts: z.array(HostContact).max(8),
    /** The bus pattern of a `busStab` mount (catalogue v3), `null` on every other mount. */
    bus: BusPattern.nullable(),
  })
  .refine((m) => m.axis[1] !== m.facing[1], { message: 'axis and facing must be perpendicular' });
export type EnclosureMount = z.infer<typeof EnclosureMount>;

/** A way for a cable into an enclosure (ADR 0015). The order of an enclosure's entries is save format. */
export const EnclosureEntry = z.strictObject({
  id: EntryId,
  /** A type in `ENTRY_TYPES` (`knockout`, `pryout`, `clamp`, `drillSite`). */
  type: z.string().max(32),
  /** The conduit trade size it takes, or `null` for a cable clamp or pryout. */
  tradeSize: TradeSize.nullable(),
  /** How many cables it takes (`entry-full` beyond it). */
  maxCables: Int.min(1).max(8),
  /** Whether the box clamps the cable itself (no connector needed). */
  internalClamp: z.boolean(),
  /** The entry point in the enclosure's frame (integer mm). */
  positionMm: PointMm,
  /** The inward direction through the entry. */
  axis: Axis,
});
export type EnclosureEntry = z.infer<typeof EnclosureEntry>;

/** Most entries an enclosure entry may have: its open entries are a 32-bit set (ADR 0015). */
export const MAX_ENCLOSURE_ENTRIES = 32;

/** Most panel spaces a load centre may have (catalogue v3; ADR 0019's `directory1` … `directory42`). */
export const MAX_PANEL_SPACES = 42;

/** A panel space (catalogue v3): a stab `index` of one of the enclosure's bus mounts. */
export const PanelSpace = z.strictObject({ mount: MountId, index: Int.min(0).max(41) });
export type PanelSpace = z.infer<typeof PanelSpace>;

/** What an enclosure offers (D11): mounts, cable entries and interior volume. */
export const EnclosureSpec = z.strictObject({
  mounts: z.array(EnclosureMount).max(64),
  /** In save-format order: bit i of the `openEntries` key is entry i. */
  entries: z.array(EnclosureEntry).max(MAX_ENCLOSURE_ENTRIES),
  /** Interior volume (mm³) of the drawn box (its geometry, never a marked volume), or `null` (a backplate). */
  interiorVolumeMm3: Int.min(1).nullable(),
  /**
   * The volume the maker marks on the box (mm³; catalogue v3), what the inspector's box-fill report
   * shows (UL 514A and 514C by number); `null` where no marking is stated (every catalogue-2 box).
   */
  markedVolumeMm3: Int.min(1).nullable(),
  /** What it is made of (catalogue v3): the inspector expects a metal enclosure to be bonded. */
  material: EnclosureMaterial,
  /**
   * A load centre's panel spaces in order (catalogue v3): space n (from 1) is `spaces[n - 1]`. `[]` for
   * every other enclosure. Save format once shipped (the directory keys and `panel.directory` count them).
   */
  spaces: z.array(PanelSpace).max(MAX_PANEL_SPACES),
});
export type EnclosureSpec = z.infer<typeof EnclosureSpec>;

/** A conductor's colour: an insulation colour and an optional tracer stripe, both colour-table ids. */
export const ConductorColour = z.strictObject({ base: ColourId, stripe: ColourId.nullable() });
export type ConductorColour = z.infer<typeof ConductorColour>;

/**
 * Conductor product data (a connection kind that `requires: 'conductor'`, F3.1). The electrical values
 * the model reads come from the pinned table rows and the entry's own `model.params`.
 */
export const ConductorSpec = z
  .strictObject({
    /** Its size, an integer AWG designation (4/0 = -3). */
    awg: Awg,
    stranding: ConductorStranding,
    /** Strands (1 for solid). */
    strandCount: Int.min(1).max(10000),
    /** The conductor metal: a `materials` row. */
    material: TableRef,
    /** The insulation: an `insulation` row, or `null` for a bare conductor. */
    insulation: TableRef.nullable(),
    /** Insulation wall thickness (mm), product data per entry; `null` for a bare conductor. */
    insulationThicknessMm: FiniteNumber.positive().nullable(),
    /**
     * Wall thickness of the outer jacket layer over the insulation (mm, the nylon on THHN), product
     * data per entry; `null` exactly when the pinned insulation row has no jacket layer (or the
     * conductor is bare). The thermal model's second cylinder (ADR 0018 §3.2).
     */
    jacketThicknessMm: FiniteNumber.positive().nullable(),
    /** The colours it is made in (`unavailable-colour` for others); a bare conductor is exactly `bare`. */
    colours: z.array(ConductorColour).min(1).max(32),
  })
  .refine((c) => (c.stranding === 'solid') === (c.strandCount === 1), {
    message: 'a solid conductor has one strand, a stranded one more',
  })
  .refine((c) => (c.insulation === null) === (c.insulationThicknessMm === null), {
    message: 'insulationThicknessMm is null exactly when the conductor is bare',
  })
  .refine((c) => c.insulation !== null || c.jacketThicknessMm === null, {
    message: 'a bare conductor has no jacket layer: jacketThicknessMm must be null',
  });
export type ConductorSpec = z.infer<typeof ConductorSpec>;

/** One blade or slot of an outlet or a plug, and the device terminal it is (catalogue v3). */
export const PinTerminal = z.strictObject({ pin: PinId, terminal: TerminalId });
export type PinTerminal = z.infer<typeof PinTerminal>;

/**
 * A receptacle outlet (catalogue v3, ADR 0019 C6): one face a plug enters. Its slots are terminals of
 * the device with no methods; a plug's contact branches join its pins to them through `contactOhm`.
 * Outlet ids are save format per entry version once a release ships them.
 */
export const Outlet = z.strictObject({
  id: OutletId,
  /** A receptacle configuration of `NEMA_CONFIGS`. */
  config: NemaConfigId,
  /** The face point a plug's reach is measured to, in the device's own frame (integer mm). */
  positionMm: PointMm,
  /** R (Ω): each pin-to-slot contact's resistance. */
  contactOhm: FiniteNumber.positive(),
  /** Every slot of its configuration, each mapped to one of the device's terminals. */
  pins: z.array(PinTerminal).min(1).max(4),
});
export type Outlet = z.infer<typeof Outlet>;

/** The longest cord a plug may have (integer mm; game-design: 15 m, a long extension cord). */
export const MAX_CORD_LENGTH_MM = 15_000;

/**
 * An appliance's cord and plug (catalogue v3, ADR 0019 C6): the plug's blades are terminals of the
 * device with no methods; the cord's conductors are resistances inside the appliance's own model,
 * derived from `cordAwg` and `cordLengthMm` (D12).
 */
export const PlugSpec = z.strictObject({
  /** A plug configuration of `NEMA_CONFIGS`. */
  config: NemaConfigId,
  /** The cord's conductor size (integer AWG designation). */
  cordAwg: Awg,
  /** The cord's length (integer mm): how far the plug reaches (`out-of-reach`). */
  cordLengthMm: Int.min(1).max(MAX_CORD_LENGTH_MM),
  /** Where the cord leaves the appliance, in its own frame (integer mm); reach is measured from it. */
  cordExitMm: PointMm,
  /** Every blade of its configuration, each mapped to one of the device's terminals. */
  pins: z.array(PinTerminal).min(1).max(4),
});
export type PlugSpec = z.infer<typeof PlugSpec>;

/** Turns a boolean commanded key on or off (`device.operate … --value true`). */
export const ToggleControl = z.strictObject({ id: DeviceStateKey, label: Label(40), type: z.literal('toggle') });

/** Sets a number commanded key within `[min, max]`. `step` is the UI's increment, not enforced. */
export const SetpointControl = z
  .strictObject({
    id: DeviceStateKey,
    label: Label(40),
    type: z.literal('setpoint'),
    /** SI unit symbol shown next to the value (`V`, `A`). */
    unit: Label(8),
    min: FiniteNumber,
    max: FiniteNumber,
    step: FiniteNumber.positive(),
  })
  .refine((c) => c.min <= c.max, { message: 'min must not be above max' });

/** Chooses one of an enum commanded key's values. */
export const SelectorControl = z.strictObject({
  id: DeviceStateKey,
  label: Label(40),
  type: z.literal('selector'),
  options: z.array(SafeString.min(1).max(MAX_DEVICE_STATE_STRING)).min(2),
});

/**
 * A button (catalogue v3, D7): pressing it adds one to its commanded `counter` key (`device.press`, one
 * logged command per press). `device.operate` never sets it.
 */
export const MomentaryControl = z.strictObject({ id: DeviceStateKey, label: Label(40), type: z.literal('momentary') });

/**
 * Something the player operates (`device.operate {id, control, value}`; a momentary control with
 * `device.press {id, control}`). Its `id` is a commanded state key.
 */
export const DeviceControl = z.discriminatedUnion('type', [
  ToggleControl,
  SetpointControl,
  SelectorControl,
  MomentaryControl,
]);
export type DeviceControl = z.infer<typeof DeviceControl>;

/**
 * The P2 name of {@link CatalogSource}: where a value comes from (realism charter, plan §3). Catalogue
 * v2 widened its `covers` paths (`sources.ts`).
 */
export const DeviceSource = CatalogSource;
export type DeviceSource = CatalogSource;

/**
 * Device categories, for the palette and the build menu. Adding one is a catalogue change. `lead` and
 * `conductor` go with connection kinds and only with them; `enclosure` with enclosure kinds; `raceway`
 * with raceway kinds and `terminalBlock` with the `terminalBlock.*` kinds (F3.5 part 2).
 */
export const DeviceCategory = z.enum([
  'source',
  'load',
  'switch',
  'protection',
  'lead',
  'conductor',
  'enclosure',
  'splice',
  'raceway',
  'terminalBlock',
]);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

/** One device entry (catalogue format v3). */
export const DeviceDefinition = z
  .strictObject({
    /** Catalogue id (`battery.ferrovane-12v-7ah`). `prop.*` is reserved for the built-in props. */
    id: CatalogId.refine((id) => !id.startsWith(BUILTIN_PROP_PREFIX), {
      message: `Catalogue ids may not start with "${BUILTIN_PROP_PREFIX}" (reserved for built-in props)`,
    }),
    /** Entry version: a saved ref names it. A changed entry that would change old saves gets a new version. */
    version: Int.min(1),
    /** What the player sees (`12 V 7 Ah sealed lead-acid battery`). */
    title: Label(80),
    /** A fictional brand (realism charter: never a real vendor). */
    brand: Label(40),
    /** The fictional brand's model designation. */
    modelName: Label(40),
    category: DeviceCategory,
    /** Outer size, or `null` for connections (leads have no body of their own). */
    sizeMm: DeviceSizeMm.nullable(),
    terminals: z.array(DeviceTerminal),
    /** The mount types the device fits (D11); `[]` for a free-standing device or a connection. */
    mounts: z.array(DeviceMount).max(8),
    /** What an enclosure offers, or `null` for anything that isn't one. */
    enclosure: EnclosureSpec.nullable(),
    /**
     * The mounts a device that isn't an enclosure offers (catalogue v3, ADR 0019 R5): a lampholder's
     * `e26` socket. `[]` for an enclosure (its mounts are `enclosure.mounts`) and for most devices;
     * `offeredMounts(device)` reads either. Ids share the entry's terminal and mount namespace.
     */
    hostMounts: z.array(EnclosureMount).max(8),
    /** A receptacle's outlets (catalogue v3), `[]` for anything else. */
    outlets: z.array(Outlet).max(4),
    /** An appliance's cord and plug (catalogue v3), `null` for anything else. */
    plug: PlugSpec.nullable(),
    /**
     * The entry that replaces this one (catalogue v3, ADR 0019 C12): the build menu hides a superseded
     * entry and the inspector words its findings "replace". Saves that name it keep loading it.
     */
    supersededBy: CatalogRef.nullable(),
    /** Conductor product data, or `null` for anything that isn't a conductor. */
    conductor: ConductorSpec.nullable(),
    /** The electrical model: a kind from `MODEL_KINDS` and its parameters (SI floats, lengths in integer mm). */
    model: z.strictObject({
      kind: z
        .string()
        .max(64)
        .regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/),
      params: z.record(
        z
          .string()
          .max(64)
          .regex(/^[a-z][a-zA-Z0-9]*$/),
        FiniteNumber,
      ),
    }),
    controls: z.array(DeviceControl),
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls device catalogue entry, catalogue format v3',
    description:
      'One file in content/devices/ (ADR 0013, ADR 0016, ADR 0020). Zod in @controls/catalog is authoritative; this JSON Schema omits the rules that depend on the model kind (parameters, terminals, controls), the registries (methods, mount, entry and host-contact types, NEMA configurations), the tables, and source coverage.',
  });
export type DeviceDefinition = z.infer<typeof DeviceDefinition>;
