import { CatalogId, CatalogRef, Extensions, FiniteNumber, Int, SafeString } from '@controls/save-format';
import * as z from 'zod';
import { ConductorColour } from './device';
import { Awg, AwgRange } from './gauge';
import {
  AccessoryKind,
  ColourId,
  ConductorStranding,
  DieId,
  DriveType,
  HoleId,
  ToolKind,
  ToolStep,
  TradeSize,
} from './registries';
import { CatalogSource } from './sources';
import { TableRef } from './tables';

/*
 * The catalogue families beside devices (catalogue format v2, ADR 0015, ADR 0016): cable assemblies,
 * tools and accessories. Every family shares one id namespace, told apart by prefix (`cable.*`,
 * `tool.*`, `ferrule.*`, `lug.*`; devices use none of them), so a `CatalogRef` names exactly one entry
 * and a command decides what it is by what the ref resolves to (`not-a-cable`, `unknown-tool`). One file
 * per entry version, `<id>.v<version>.json`, in `content/cables/`, `content/tools/` and
 * `content/accessories/` (each mirrored when its first entry lands).
 */

const Label = (max: number) => SafeString.min(1).max(max);

const identity = (prefix: string, family: string) => ({
  id: CatalogId.refine((id) => id.startsWith(prefix), { message: `A ${family} id starts with "${prefix}"` }),
  /** Entry version: a saved ref names it. */
  version: Int.min(1),
  /** What the player sees. */
  title: Label(80),
  /** A fictional brand (realism charter: never a real vendor). */
  brand: Label(40),
  /** The fictional brand's model designation. */
  modelName: Label(40),
});

/** The role of a conductor in a cable assembly. */
export const ConductorRole = z.enum(['ungrounded', 'grounded', 'egc']);
export type ConductorRole = z.infer<typeof ConductorRole>;

/**
 * One conductor of a cable assembly. Its index is its place in `conductors[]`, which is save format
 * (`ConnectionV3.cable.conductor`): reordering is a new entry version.
 */
export const CableConductor = z.strictObject({
  /** Its index in the assembly, equal to its position in `conductors[]`. */
  index: Int.min(0),
  /** The conductor entry, pinned (`conductor.*`). */
  conductor: CatalogRef,
  role: ConductorRole,
  /** Whether it is insulated (a bare EGC isn't); must match the conductor entry. */
  insulated: z.boolean(),
  /** Its colour, one the conductor entry is made in. */
  colour: ConductorColour,
});
export type CableConductor = z.infer<typeof CableConductor>;

/** A cable assembly's outer jacket. */
export const CableJacket = z.strictObject({
  /** An `insulation` table row (the jacket compound and its rating). */
  material: TableRef,
  /** Its colour, a colour-table id. */
  colour: ColourId,
  /** Jacket wall thickness (mm). */
  thicknessMm: FiniteNumber.positive(),
  /** Outer width (mm): the major axis of a flat cable, the diameter of a round one. */
  widthMm: FiniteNumber.positive(),
  /** Outer height (mm): the minor axis of a flat cable, equal to `widthMm` for a round one. */
  heightMm: FiniteNumber.positive(),
});
export type CableJacket = z.infer<typeof CableJacket>;

/** A cable assembly (NM-B 14/2 with ground, …): pinned conductors in a jacket (F3.1 part 2). */
export const CableDefinition = z
  .strictObject({
    ...identity('cable.', 'cable'),
    conductors: z.array(CableConductor).min(1).max(16),
    jacket: CableJacket,
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .refine((c) => c.jacket.heightMm <= c.jacket.widthMm, { message: 'jacket heightMm must not exceed widthMm' })
  .meta({
    title: 'Controls cable assembly, catalogue format v2',
    description:
      'One file in content/cables/ (ADR 0016). Zod in @controls/catalog is authoritative; conductor refs, colours, table refs and source coverage are checked by parseCatalog.',
  });
export type CableDefinition = z.infer<typeof CableDefinition>;

/** A capability of a tool (ADR 0015): a step it performs, with a size limit where it has one. */
export const ToolCapability = z.strictObject({
  step: ToolStep,
  /** The largest conductor it handles, as an AWG designation (`beyond-tool-capacity` above it), or `null`. */
  maxAwg: Awg.nullable(),
});
export type ToolCapability = z.infer<typeof ToolCapability>;

/** A stripping hole: the conductor size and stranding it is cut for (nicks otherwise, D8). Ids are save format. */
export const ToolHole = z.strictObject({ id: HoleId, awg: Awg, stranding: ConductorStranding });
export type ToolHole = z.infer<typeof ToolHole>;

/** A crimp die (ids are save format); accessories list the die ids that crimp them. */
export const ToolDie = z.strictObject({
  id: DieId,
  /** What the die is marked (`16-14`). Display text. */
  label: Label(40),
  /** The conductor sizes it is marked for. */
  awgRange: AwgRange,
});
export type ToolDie = z.infer<typeof ToolDie>;

/** A torque tool's range and stated accuracy. */
export const ToolTorque = z
  .strictObject({
    minNm: FiniteNumber.positive(),
    maxNm: FiniteNumber.positive(),
    /** Stated accuracy as a fraction of the setting (0.06 for ±6 %). */
    accuracyFraction: FiniteNumber.min(0).lt(1),
  })
  .refine((t) => t.maxNm > t.minNm, { message: 'maxNm must be above minNm' });
export type ToolTorque = z.infer<typeof ToolTorque>;

/**
 * A fish tape's reach (F3.4 part 2): how far it can be pushed through conduit and round how much bend.
 * `wire.pull` refuses a run past either (`beyond-tool-capacity`).
 */
export const ToolPull = z.strictObject({
  /** The tape's length (integer mm): the longest conduit run it reaches through. */
  lengthMm: Int.min(1).max(1_000_000),
  /** The most total bend (degrees, a whole number of quarter bends) it can be pushed round in one run. */
  maxBendDeg: Int.min(0)
    .max(3600)
    .refine((d) => d % 90 === 0, { message: 'maxBendDeg is a whole number of quarter bends (a multiple of 90)' }),
});
export type ToolPull = z.infer<typeof ToolPull>;

/** A hand tool (D10, ADR 0015). Commands check its capabilities, never its kind alone. */
export const ToolDefinition = z
  .strictObject({
    ...identity('tool.', 'tool'),
    kind: ToolKind,
    capabilities: z.array(ToolCapability).min(1).max(16),
    /** Stripping holes; non-empty exactly when it can `strip`. */
    holes: z.array(ToolHole).max(32),
    /** Crimp dies; non-empty exactly when it can `crimp`. */
    dies: z.array(ToolDie).max(16),
    /** Torque range and accuracy; non-null exactly when it can `torque`. */
    torque: ToolTorque.nullable(),
    /** The hole a bit or saw makes (mm); non-null exactly when it can `bore` (one entry per size). */
    boreDiameterMm: FiniteNumber.positive().nullable(),
    /**
     * The screw drive types its tip or socket fits (F3.4 part 1, ADR 0016 amendment); non-empty exactly
     * when it can `drive`. Sizes are names, not modelled.
     */
    drives: z.array(DriveType).max(5),
    /**
     * The conduit trade sizes its punches and dies make knockout holes for (F3.4 part 2); non-empty only
     * when it can `openEntry`. A tool that can `openEntry` has punches or a `boreDiameterMm` (a hole saw).
     */
    punches: z.array(TradeSize).max(6),
    /** A fish tape's reach (F3.4 part 2); non-null exactly when it can `pull`. */
    pull: ToolPull.nullable(),
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .refine((t) => new Set(t.drives).size === t.drives.length, { message: 'drives must be unique' })
  .refine((t) => new Set(t.punches).size === t.punches.length, { message: 'punches must be unique' })
  .meta({
    title: 'Controls tool, catalogue format v2',
    description:
      'One file in content/tools/ (ADR 0016). Zod in @controls/catalog is authoritative; capability consistency and source coverage are checked by parseCatalog.',
  });
export type ToolDefinition = z.infer<typeof ToolDefinition>;

/** A ferrule or lug, crimped onto a conductor end (family `accessory`, ADR 0015). */
export const AccessoryDefinition = z
  .strictObject({
    id: CatalogId,
    version: Int.min(1),
    title: Label(80),
    brand: Label(40),
    modelName: Label(40),
    kind: AccessoryKind,
    /** The conductor sizes it fits. */
    awgRange: AwgRange,
    /** The strandings it fits. */
    stranding: z.array(ConductorStranding).min(1).max(2),
    /** The die ids that crimp it (`wrong-accessory` / `unknown-die` otherwise). */
    dies: z.array(DieId).min(1).max(16),
    /** The ferrule sleeve or lug barrel length (mm): what the strip length must match. */
    barrelLengthMm: FiniteNumber.positive(),
    /** A lug's stud (screw) size (mm); `null` for a ferrule. */
    studDiameterMm: FiniteNumber.positive().nullable(),
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .refine((a) => (a.kind === 'ferrule') === (a.studDiameterMm === null), {
    message: 'studDiameterMm is null exactly for a ferrule',
  })
  .refine((a) => new Set(a.stranding).size === a.stranding.length && new Set(a.dies).size === a.dies.length, {
    message: 'stranding and dies must be unique',
  })
  .meta({
    title: 'Controls accessory (ferrule, lug), catalogue format v2',
    description:
      'One file in content/accessories/ (ADR 0016). Zod in @controls/catalog is authoritative; the id prefix (ferrule. or lug.) and source coverage are checked by parseCatalog.',
  });
export type AccessoryDefinition = z.infer<typeof AccessoryDefinition>;
