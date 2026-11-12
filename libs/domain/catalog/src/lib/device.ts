import {
  BUILTIN_PROP_PREFIX,
  CatalogId,
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
  ColourId,
  ConductorStranding,
  EntryId,
  MountId,
  TerminalStranding,
  TerminationMethodId,
  TradeSize,
} from './registries';
import { CatalogSource } from './sources';
import { TableRef } from './tables';

/*
 * The device entry format, catalogue format v2 (P3, ADR 0016; v1 was ADR 0013's). One device definition
 * per file in `content/devices/` (`<id>.v<version>.json`). Saves reference an entry by `{ id, version }`
 * and never inline it (ADR 0004), so a content fix reaches old saves. Every number in an entry has a
 * `source` (realism charter, plan §3), and brands are fictional.
 *
 * Catalogue v2 adds, with no field optional (absent is `null` or `[]`): per-method termination specs
 * on terminals, the mounts a device fits, enclosure data (mounts, entries, interior volume) and
 * conductor product data (gauge, stranding, pinned material and insulation rows, colours).
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
    /** Whether the method is rated for aluminium conductors (CO/ALR, AL/CU). */
    alRated: z.boolean(),
    /** Where the conductor enters the terminal, in the device's own frame (integer mm). */
    entryMm: PointMm,
    /** The direction a landed conductor leaves the terminal, in the device's own frame. */
    exitAxis: Axis,
  })
  .refine((m) => m.maxConductors >= m.ratedConductors, { message: 'maxConductors must be at least ratedConductors' })
  .refine((m) => new Set(m.stranding).size === m.stranding.length, { message: 'stranding values must be unique' })
  .refine((m) => m.stripLengthMm.tolerance < m.stripLengthMm.nominal, {
    message: 'the strip-length tolerance must be below the nominal length',
  });
export type TerminalMethodSpec = z.infer<typeof TerminalMethodSpec>;

/** A terminal: where a lead's clip and, from P3, a conductor lands. */
export const DeviceTerminal = z.strictObject({
  id: TerminalId,
  /** What the device's marking says (`+`, `−`, `1`). Display text only. */
  label: Label(16),
  /** Position in the device's own frame (integer mm), for drawing leads and picking. */
  positionMm: PointMm,
  /** How conductors land on it, in save-format order; empty for a clip-only terminal (`wrong-method`). */
  methods: z.array(TerminalMethodSpec).max(8),
});
export type DeviceTerminal = z.infer<typeof DeviceTerminal>;

/** A mount type a device fits, and the width it takes along such a mount (D11). */
export const DeviceMount = z.strictObject({
  /** A type in `MOUNT_TYPES` (`din35`, `deviceYoke`), unique within the entry. */
  type: z.string().max(32),
  /** Width along the mount's axis (integer mm), for `mount-full` and overlap. */
  widthMm: Int.min(1),
});
export type DeviceMount = z.infer<typeof DeviceMount>;

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

/** What an enclosure offers (D11): mounts, cable entries and interior volume. */
export const EnclosureSpec = z.strictObject({
  mounts: z.array(EnclosureMount).max(64),
  /** In save-format order: bit i of the `openEntries` key is entry i. */
  entries: z.array(EnclosureEntry).max(MAX_ENCLOSURE_ENTRIES),
  /** Interior volume (mm³) for P4's box fill (stored, not checked in P3), or `null` (a backplate). */
  interiorVolumeMm3: Int.min(1).nullable(),
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

/** Something the player operates (`device.operate {id, control, value}`). Its `id` is a commanded state key. */
export const DeviceControl = z.discriminatedUnion('type', [ToggleControl, SetpointControl, SelectorControl]);
export type DeviceControl = z.infer<typeof DeviceControl>;

/**
 * The P2 name of {@link CatalogSource}: where a value comes from (realism charter, plan §3). Catalogue
 * v2 widened its `covers` paths (`sources.ts`).
 */
export const DeviceSource = CatalogSource;
export type DeviceSource = CatalogSource;

/**
 * Device categories, for the palette and the build menu. Adding one is a catalogue change. `lead` and
 * `conductor` go with connection kinds and only with them; `enclosure` with enclosure kinds.
 */
export const DeviceCategory = z.enum(['source', 'load', 'switch', 'protection', 'lead', 'conductor', 'enclosure']);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

/** One device entry (catalogue format v2). */
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
    title: 'Controls device catalogue entry, catalogue format v2',
    description:
      'One file in content/devices/ (ADR 0013, ADR 0016). Zod in @controls/catalog is authoritative; this JSON Schema omits the rules that depend on the model kind (parameters, terminals, controls), the registries (methods, mount and entry types), the tables, and source coverage.',
  });
export type DeviceDefinition = z.infer<typeof DeviceDefinition>;
