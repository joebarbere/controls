import { CAMEL_ID_PATTERN } from '@controls/save-format';
import * as z from 'zod';

/*
 * Catalogue v2 vocabularies (ADR 0015, ADR 0016). Like `MODEL_KINDS`, each registry is code: a new
 * termination method, mount type or entry type is a code change plus catalogue data, never a save
 * schema change. Their ids are save format once a save names them (a termination's `method`, an
 * entity's `mountedOn.mount` resolves through a catalogue mount of a registered type), so an id is
 * never renamed or removed once v0.4.0 ships.
 *
 * Every row says where its meaning comes from (realism charter, plan §3): `real-world` rows paraphrase
 * practice or a standard by number; `game-design` rows say they are an abstraction chosen for play.
 */

/*
 * ADR 0015's id primitives (`ColourId`, `TerminationMethodId`, `MountId`, `EntryId`, `HoleId`,
 * `DieId`) and their grammar (`CAMEL_ID_PATTERN`) are defined in `save-format`'s primitives, the
 * source of truth for persisted grammar (world v3 stores them), and re-exported here (ADR 0016), so
 * the catalogue and a save can never disagree on what an id may be.
 */
export {
  CAMEL_ID_PATTERN,
  ColourId,
  DieId,
  EntryId,
  HoleId,
  MountId,
  TerminationMethodId,
} from '@controls/save-format';

const camelId = (id: string, description: string) =>
  z.string().max(32).regex(CAMEL_ID_PATTERN).meta({ id, description });

/** A table name (`materials`, `insulation`, `colours`). */
export const TableName = camelId('TableName', 'A catalogue table name: lower camelCase.');
/** A row key of a table (`copperAnnealed`, `thhnThwn2`). */
export const TableKey = camelId('TableKey', 'A row key of a catalogue table: lower camelCase.');

/** One of the six axis directions of an entity's own frame (integer quarter-turn geometry, ADR 0015). */
export const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export const Axis = z.enum(AXES);
export type Axis = z.infer<typeof Axis>;

/** Whether two axes are perpendicular (neither the same axis nor its opposite). */
export function axesPerpendicular(a: Axis, b: Axis): boolean {
  return a[1] !== b[1];
}

/** How a conductor is made. */
export const ConductorStranding = z.enum(['solid', 'stranded']);
export type ConductorStranding = z.infer<typeof ConductorStranding>;

/** What a termination method accepts: a solid conductor, bare strands, or strands in a ferrule. */
export const TerminalStranding = z.enum(['solid', 'stranded', 'strandedFerrule']);
export type TerminalStranding = z.infer<typeof TerminalStranding>;

/** Conduit and fitting trade sizes (inches, as designated). A trade size is a name, not a measurement. */
export const TradeSize = z.enum(['1/2', '3/4', '1', '1-1/4', '1-1/2', '2']);
export type TradeSize = z.infer<typeof TradeSize>;

/** The steps a tool can perform (ADR 0015): a command checks the capability its step needs. */
export const TOOL_STEPS = [
  'cut',
  'strip',
  'stripJacket',
  'crimp',
  'drive',
  'torque',
  'openEntry',
  'bore',
  'pull',
  'label',
] as const;
export const ToolStep = z.enum(TOOL_STEPS);
export type ToolStep = z.infer<typeof ToolStep>;

/** Tool kinds (D10), for the tool belt and the UI. Commands check capabilities, never the kind alone. */
export const ToolKind = z.enum([
  'stripper',
  'cutter',
  'screwdriver',
  'torqueDriver',
  'crimper',
  'nutDriver',
  'drill',
  'holeSaw',
  'knockoutPunch',
  'fishTape',
  'labelMaker',
]);
export type ToolKind = z.infer<typeof ToolKind>;

/** Screw drive (head) types (ADR 0016 amendment, F3.4 part 1): what a driver's tip fits and a screw's head takes. */
export const DRIVE_TYPE_IDS = ['slotted', 'phillips', 'pozidriv', 'square', 'hex', 'hexSocket'] as const;
export const DriveType = z.enum(DRIVE_TYPE_IDS);
export type DriveType = z.infer<typeof DriveType>;

export interface DriveTypeDef extends Provenance {
  readonly id: DriveType;
}

/**
 * Drive types (F3.4 part 1, an ADR 0016 amendment). A command that turns a screw (a clamp-torque
 * termination, an entry opened with `drive`) needs the tool's `drives` to share one with the screw's
 * (`wrong-drive`). **Sizes are names, not modelled** (game-design): a tool with `phillips` fits every
 * Phillips screw, so a #1 tip on a #2 screw isn't a mistake the game can show yet.
 */
export const DRIVE_TYPES: Readonly<Record<DriveType, DriveTypeDef>> = Object.freeze({
  slotted: {
    id: 'slotted',
    description: 'A straight slot, driven by a flat blade.',
    kind: 'real-world',
    source: 'Slotted screwdriver tips are specified in ISO 2380 (cited by number); sizes are names here (game-design).',
  },
  phillips: {
    id: 'phillips',
    description: 'A cross recess (Type H), driven by a Phillips tip.',
    kind: 'real-world',
    source:
      'Cross-recess (Phillips) tips are specified in ISO 8764 (cited by number); sizes are names here (game-design).',
  },
  pozidriv: {
    id: 'pozidriv',
    description: 'A cross recess with extra ribs (Type Z), common on DIN-rail terminal screws.',
    kind: 'real-world',
    source:
      'Type Z cross-recess (Pozidriv) tips are specified in ISO 8764 (cited by number); sizes are names here (game-design).',
  },
  square: {
    id: 'square',
    description: 'A square socket (Robertson), common with a slot on North American breaker and panel screws.',
    kind: 'real-world',
    source:
      'Square-socket (Robertson) drives are common practice on North American electrical screws, often combined with a slot; sizes are names here (game-design).',
  },
  hex: {
    id: 'hex',
    description: 'An external hex head (a hex-washer-head screw), driven by a nut driver.',
    kind: 'real-world',
    source:
      'Hex-washer-head screws are driven by a nut driver of the head’s size (common practice); sizes are names here (game-design).',
  },
  hexSocket: {
    id: 'hexSocket',
    description: 'A hexagon socket (an Allen head), driven by a hex key or hex bit: large lugs’ set screws.',
    kind: 'real-world',
    source:
      'Hexagon-socket screws are driven by a hex key (ISO 2936, cited by number) or a hex bit; large mechanical lugs, such as a meter base’s service lugs, commonly take one (common practice, P4 PR 14). Sizes are names here (game-design). Catalogue 3 (P4): not in any catalogue-2 entry.',
  },
} satisfies Record<DriveType, DriveTypeDef>);

/** Whether two drive lists share a type: a tool with `tool` fits a screw with `screw`. */
export function drivesFit(tool: readonly DriveType[], screw: readonly DriveType[]): boolean {
  return tool.some((d) => screw.includes(d));
}

/** Accessory kinds (family `accessory`, crimped onto a conductor end). */
export const AccessoryKind = z.enum(['ferrule', 'ringLug', 'forkLug']);
export type AccessoryKind = z.infer<typeof AccessoryKind>;

/** The id prefix each accessory kind's entries use (one catalogue namespace, ADR 0015). */
export const ACCESSORY_PREFIX: Readonly<Record<AccessoryKind, string>> = Object.freeze({
  ferrule: 'ferrule.',
  ringLug: 'lug.',
  forkLug: 'lug.',
});

/**
 * How a terminal holds a conductor (ADR 0018 §8, `TerminalMethodSpec.clampType`): it decides which
 * quality inputs apply to the contact model (§4.3: only a `bindingScrew` splays bare strands). The ids
 * are catalogue format; each termination method allows the ones its row lists (`clampTypes`).
 */
export const CLAMP_TYPES = ['bindingScrew', 'pressurePlate', 'boxLug', 'springCage', 'pushIn', 'twistOn'] as const;
export const ClampType = z.enum(CLAMP_TYPES);
export type ClampType = z.infer<typeof ClampType>;

/** A registry row's provenance (realism charter). */
interface Provenance {
  readonly description: string;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

export interface TerminationMethodDef extends Provenance {
  readonly id: string;
  /** Whether the method is clamped by a screw to a torque: its specs then carry `torqueNm`, and a landing a clamp tool. */
  readonly clampTorque: boolean;
  /** The accessories that may be crimped onto a conductor landed by this method. */
  readonly accessories: readonly AccessoryKind[];
  /** The clamp types a spec of this method may declare (ADR 0018 §8). */
  readonly clampTypes: readonly ClampType[];
}

/**
 * Termination methods (P3). The order of a terminal's methods is save format (`'auto'` takes the
 * first); the method ids are save format (a termination records its method).
 */
export const TERMINATION_METHODS: Readonly<Record<string, TerminationMethodDef>> = Object.freeze({
  screw: {
    id: 'screw',
    clampTorque: true,
    accessories: ['ferrule', 'ringLug', 'forkLug'],
    clampTypes: ['bindingScrew', 'pressurePlate', 'boxLug'],
    description:
      'A screw clamp: a binding-head screw or a pressure plate tightened onto the conductor to a marked torque.',
    kind: 'real-world',
    source:
      'Screw-clamp terminals (binding screws, pressure plates, box lugs) are tightened to the torque the equipment is marked with; NFPA 70-2023 Art. 110.14(D) requires the marked value to be used (cited by number, not reproduced). Ferrules on fine strands and ring or fork lugs under binding screws are common practice.',
  },
  springCage: {
    id: 'springCage',
    clampTorque: false,
    accessories: ['ferrule'],
    clampTypes: ['springCage'],
    description:
      'A spring-cage (spring-clamp or push-in) terminal: a spring presses the conductor against a bar; no screw.',
    kind: 'real-world',
    source:
      'Spring-clamp and push-in terminal blocks for control wiring (IEC 60947-7-1 by number): the clamping force comes from the spring, so there is no tightening torque; stranded conductors are usually landed in ferrules.',
  },
  backStab: {
    id: 'backStab',
    clampTorque: false,
    accessories: [],
    clampTypes: ['pushIn'],
    description: 'A push-in (back-wired) device terminal: a spring tab grips a solid conductor pushed into a hole.',
    kind: 'real-world',
    source:
      'Push-in back-wire terminals of US wiring devices (switches and receptacles listed to UL 20 and UL 498, cited by number): a solid conductor is pushed into a hole past a spring contact; no screw and no torque.',
  },
  twistOn: {
    id: 'twistOn',
    clampTorque: false,
    accessories: [],
    clampTypes: ['twistOn'],
    description: 'A twist-on wire connector: a tapered spring twisted onto the stripped conductors of a splice.',
    kind: 'real-world',
    source:
      'Twist-on wire connectors (UL 486C by number): the conductors are twisted together inside a tapered coil spring; each size is rated for a range of conductor counts and sizes, stored as bounds paraphrased from public packaging data, never as a reproduced combination chart.',
  },
} satisfies Record<string, TerminationMethodDef>);

/** A termination method by id (own properties only), or `undefined`. */
export function terminationMethod(id: string): TerminationMethodDef | undefined {
  return Object.prototype.hasOwnProperty.call(TERMINATION_METHODS, id) ? TERMINATION_METHODS[id] : undefined;
}

export interface MountTypeDef extends Provenance {
  readonly id: string;
  /**
   * How a mount of this type fills up (`mount-full`): `single` holds one device (a device yoke, a box's
   * stud bracket); `linear` holds devices side by side along its axis, each taking its declared
   * `widthMm` (a DIN rail); `area` holds devices anywhere on its face without overlap (a backplate).
   */
  readonly occupancy: 'single' | 'linear' | 'area';
  /**
   * The host contacts a mount of this type can offer (catalogue v3, ADR 0020; ADR 0019 "What the
   * netlist compiler reads" 1): the ids a mounted device's contacts name in their `host`. A host mount
   * maps each it offers to one of its own terminals (`EnclosureMount.contacts`); a bus mount's `stab`
   * reaches a leg through its `bus` pattern instead. Append-only once v0.5.0 ships (a compiled contact
   * branch is keyed by the device's contact id, never by these).
   */
  readonly hostContacts: readonly string[];
  /** Whether a mount of this type is a bus (`busStab`): it carries a `bus` pattern, and devices on it may offset their contacts by whole stab positions. */
  readonly bus: boolean;
}

/**
 * Mount types (D11): what a device declares it fits and what an enclosure offers. Catalogue v3 (ADR
 * 0020) adds each type's host contacts and bus flag, and the P4 rows `busStab`, `mainFeed`, `mbj`,
 * `groundBarKit` and `e26`. Ids are save format (an entity's `mountedOn.mount` resolves to a mount of
 * one of these types) and never renamed or removed once a release ships them.
 */
export const MOUNT_TYPES: Readonly<Record<string, MountTypeDef>> = Object.freeze({
  din35: {
    id: 'din35',
    occupancy: 'linear',
    hostContacts: [],
    bus: false,
    description: 'A 35 mm top-hat DIN rail: devices clip on and sit side by side along it.',
    kind: 'real-world',
    source:
      'The 35 mm top-hat mounting rail standardised in IEC 60715 (formerly EN 50022), cited by number: devices snap onto it and can slide along it; their widths along the rail add up.',
  },
  backplate: {
    id: 'backplate',
    occupancy: 'area',
    hostContacts: [],
    bus: false,
    description: 'A panel backplate (mounting pan): rails, duct and devices are fixed anywhere on its face.',
    kind: 'game-design',
    source:
      'game-design: a control-panel backplate is drilled and tapped where parts go, so any free place on its face can take a part; modelled as an area without overlap.',
  },
  deviceYoke: {
    id: 'deviceYoke',
    occupancy: 'single',
    hostContacts: ['chassis'],
    bus: false,
    description:
      "A device box's yoke position: one wiring device (switch, receptacle) screwed to the box by its strap.",
    kind: 'real-world',
    source:
      "US wiring devices mount by their yoke (strap) to a device box with two screws, one device per gang; a two-gang box has two yoke positions (outlet-box practice, UL 514A by number). P4's devices use them. On a metal box the strap's mounting screws also join the yoke to the box metal (the `chassis` host contact); whether that alone bonds a receptacle is NFPA 70-2023 Art. 250.146's question (cited by number), which the inspector asks, not the compiler.",
  },
  studFlange: {
    id: 'studFlange',
    occupancy: 'single',
    hostContacts: [],
    bus: false,
    description: "A box's flange or bracket fixing it to the side of a framing stud.",
    kind: 'real-world',
    source:
      'Nail-on and screw-on boxes for wood framing fix to the side of a stud by a flange or bracket (common practice). In P3 a level fixture (a stud) is never a host, so this type is declared for P4.',
  },
  busStab: {
    id: 'busStab',
    occupancy: 'linear',
    hostContacts: ['stab'],
    bus: true,
    description:
      "A column of a load centre's bus stabs: plug-on breakers clip onto it side by side, each pole onto one stab.",
    kind: 'real-world',
    source:
      "Residential load centres (panelboards listed to UL 67, cited by number) carry two bus bars, one per line of the 120/240 V service, with stabs that plug-on breakers clip onto; the stabs alternate between the two bars row by row, so a two-pole breaker across two adjacent rows of one column reaches both lines (common practice and makers' published panel layouts). The stab pitch and the leg pattern are entry data (ADR 0020); a bus position is looked up exactly, never divided out (ADR 0019).",
  },
  mainFeed: {
    id: 'mainFeed',
    occupancy: 'single',
    hostContacts: ['l1', 'l2'],
    bus: false,
    description:
      "A load centre's main position: a main breaker (or a main-lug kit) whose load side feeds both bus bars.",
    kind: 'real-world',
    source:
      'A main-breaker load centre feeds its bus through a main breaker at the top of the bus; a main-lug load centre takes the feeder on lugs in the same place (common practice; panelboards listed to UL 67, cited by number). One mount type serves both, so one load-centre kind is main-breaker or main-lug by what is mounted (ADR 0020).',
  },
  mbj: {
    id: 'mbj',
    occupancy: 'single',
    hostContacts: ['neutral', 'chassis'],
    bus: false,
    description:
      "A load centre's main bonding jumper position: a green screw or strap joining the neutral bar to the can.",
    kind: 'real-world',
    source:
      "The main bonding jumper joins the grounded (neutral) conductor to the equipment grounding system at the service, often as a green screw through the neutral bar into the enclosure or a strap (NFPA 70-2023 Arts. 250.24(B) and 250.28, cited by number and paraphrased); a load centre used downstream as a subpanel leaves it out. Its two host contacts reach the neutral bar and the can's `chassis` terminal.",
  },
  groundBarKit: {
    id: 'groundBarKit',
    occupancy: 'single',
    hostContacts: ['chassis'],
    bus: false,
    description: "A tapped place on a load centre's can for an accessory equipment grounding bar.",
    kind: 'real-world',
    source:
      "Load-centre makers sell accessory equipment grounding bars screwed to the enclosure at tapped places (makers' published accessory lists, common practice); the bar bonds to the can through its mounting screws, the `chassis` host contact.",
  },
  e26: {
    id: 'e26',
    occupancy: 'single',
    hostContacts: ['shell', 'centre'],
    bus: false,
    description: 'A medium Edison screw lampholder socket (E26): a bulb screws in; its shell and foot make contact.',
    kind: 'real-world',
    source:
      "The medium Edison screw base (E26: a 26 mm thread), the usual North American lamp base: a screwed-in lamp's threaded shell touches the lampholder's screw shell and its foot contact the centre contact (common practice; the base and holder dimensions are standardised in ANSI and IEC lamp-base standards, not cited by number here). The game takes one bulb per socket.",
  },
} satisfies Record<string, MountTypeDef>);

/** A mount type by id (own properties only), or `undefined`. */
export function mountType(id: string): MountTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(MOUNT_TYPES, id) ? MOUNT_TYPES[id] : undefined;
}

export interface EntryTypeDef extends Provenance {
  readonly id: string;
  /** The tool capabilities that open an entry of this type (`enclosure.openEntry` accepts a tool with any one). */
  readonly opens: readonly ToolStep[];
  /** A tool opening it by `drive` needs one of these drive types (`wrong-drive`); empty when `drive` doesn't open it. */
  readonly drives: readonly DriveType[];
}

/** Enclosure entry types (ADR 0015): how a cable gets into an enclosure, and what opens the way. */
export const ENTRY_TYPES: Readonly<Record<string, EntryTypeDef>> = Object.freeze({
  knockout: {
    id: 'knockout',
    opens: ['drive', 'openEntry'],
    drives: ['slotted'],
    description: 'A pre-scored knockout in a metal box, sized for a conduit trade size.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: a pre-scored knockout slug is tapped loose with a screwdriver and twisted off with pliers, or punched with a knockout punch; one tool with either capability opens it (the pliers step is folded in).',
  },
  pryout: {
    id: 'pryout',
    opens: ['drive'],
    drives: ['slotted'],
    description: 'A pryout (twist-out) for a cable clamp, pried out with a screwdriver.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: pryouts behind a box’s cable clamps are pried out with a flat screwdriver.',
  },
  clamp: {
    id: 'clamp',
    opens: ['drive'],
    drives: ['slotted'],
    description: 'A built-in cable clamp or knock-in tab of a non-metallic box, pushed open with a screwdriver.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: the knock-in tabs of non-metallic boxes are pushed in with a screwdriver blade; every entry starts closed (ADR 0015), so a clamp entry is opened like the others.',
  },
  drillSite: {
    id: 'drillSite',
    opens: ['openEntry'],
    drives: [],
    description: 'A place on a blank enclosure wall where a hole may be sawn or punched for a conduit trade size.',
    kind: 'game-design',
    source:
      "game-design abstraction of practice: a blank wall is opened with a hole saw or knockout punch at a place the catalogue entry declares (ADR 0015: custom entries are catalogue drill sites, not a world list). A wood-boring bit (step `bore` alone) cuts no steel box wall; the hole must fit the site's trade size (`KNOCKOUT_HOLES`, F3.4 part 2).",
  },
} satisfies Record<string, EntryTypeDef>);

/** An entry type by id (own properties only), or `undefined`. */
export function entryType(id: string): EntryTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(ENTRY_TYPES, id) ? ENTRY_TYPES[id] : undefined;
}

export interface KnockoutHoleDef extends Provenance {
  readonly tradeSize: TradeSize;
  /** The hole a conduit-size knockout punch of this trade size makes, in inches as published. */
  readonly diameterIn: number;
}

const KNOCKOUT_PUNCH_CLASS =
  "One maker's standard round knockout punch catalogue (read 2026-11-15; maker not named in content): conduit-size punches make a hole about the outside diameter of the conduit's connector thread, published as 0.885 in (1/2), 1.115 in (3/4), 1.362 in (1), 1.701 in (1-1/4), 1.951 in (1-1/2) and 2.416 in (2), for mild steel up to 10 gauge (3.5 mm). Another maker's individual 1 in die page gives the same 1.362 in. Product data, not a code table; the mm values are the exact inch conversion (NIST SP 811).";

/**
 * The hole an entry of each conduit trade size takes (F3.4 part 2): what a knockout punch of that size
 * makes, from published punch data. A hole saw opens a drill site of a trade size only when its
 * diameter is within {@link HOLE_FIT_TOLERANCE_MM} of it (`wrong-size`); the mm value is
 * {@link knockoutHoleMm}.
 */
export const KNOCKOUT_HOLES: Readonly<Record<TradeSize, KnockoutHoleDef>> = Object.freeze({
  '1/2': {
    tradeSize: '1/2',
    diameterIn: 0.885,
    description: 'The hole of a 1/2 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
  '3/4': {
    tradeSize: '3/4',
    diameterIn: 1.115,
    description: 'The hole of a 3/4 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
  '1': {
    tradeSize: '1',
    diameterIn: 1.362,
    description: 'The hole of a 1 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
  '1-1/4': {
    tradeSize: '1-1/4',
    diameterIn: 1.701,
    description: 'The hole of a 1-1/4 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
  '1-1/2': {
    tradeSize: '1-1/2',
    diameterIn: 1.951,
    description: 'The hole of a 1-1/2 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
  '2': {
    tradeSize: '2',
    diameterIn: 2.416,
    description: 'The hole of a 2 in conduit-size punch',
    kind: 'real-world',
    source: KNOCKOUT_PUNCH_CLASS,
  },
} satisfies Record<TradeSize, KnockoutHoleDef>);

/** The knockout hole of trade size `size` in mm: its published inches × 25.4 (exact, NIST SP 811). */
export function knockoutHoleMm(size: TradeSize): number {
  return KNOCKOUT_HOLES[size].diameterIn * 25.4;
}

/**
 * How far a sawn hole may be from a trade size's knockout hole and still take that size's connector:
 * 1/16 in = 1.5875 mm either way. game-design: a connector's locknut covers a slightly large hole and
 * a hole a little small is filed out; the electrician's hole saw sizes (7/8, 1-1/8, 1-3/8, 1-3/4 in)
 * all fall within it of the 1/2, 3/4, 1 and 1-1/4 punch holes, the next size up or down never does.
 */
export const HOLE_FIT_TOLERANCE_MM = 1.5875;

/** Whether a hole of `diameterMm` fits an entry of trade size `size`: within {@link HOLE_FIT_TOLERANCE_MM} either way, inclusive. */
export function holeFitsTradeSize(diameterMm: number, size: TradeSize): boolean {
  // Compared in whole tenths of a micrometre, so the tolerance's edge is exact (1.5875 mm = 15 875).
  const tenthsUm = (mm: number) => Math.round(mm * 10_000);
  const off = tenthsUm(diameterMm) - tenthsUm(knockoutHoleMm(size));
  const limit = tenthsUm(HOLE_FIT_TOLERANCE_MM);
  return off <= limit && -off <= limit;
}

/** Id prefixes reserved for the non-device families (one catalogue namespace, ADR 0015). */
export const FAMILY_PREFIXES = Object.freeze({
  tool: ['tool.'],
  cable: ['cable.'],
  accessory: ['ferrule.', 'lug.'],
  conductor: ['conductor.'],
} as const);

/*
 * Catalogue v3 (P4, ADR 0020) vocabularies and id grammars.
 *
 * `OutletId` and `AreaUseId` are the grammars world v4 stores (`EntityV4.pluggedInto.outlet`,
 * `AreaV4.use`; ADR 0019). They are defined in `save-format`'s primitives, the source of truth for
 * persisted grammar, and re-exported here (world v4, P4 PR 7), as catalogue v2 did with `ColourId` and
 * the other v3 ids (ADR 0016): a second schema with the same `.meta({ id })` would collide in the JSON
 * Schema export. `ContactId` is the grammar of a mount contact's id, which a compiled contact branch's
 * `ElementRef` carries (ADR 0019 "What the netlist compiler reads" 8) and `topologyHash` hashes; no
 * save stores it, so it stays here.
 */
export { AreaUseId, OutletId } from '@controls/save-format';

/** A mount contact's id, and a mount type's host contact id (lower camelCase, at most 32; ADR 0019, ADR 0020). */
export const ContactId = camelId('ContactId', 'A mount contact id: lower camelCase, at most 32 characters.');
export type ContactId = z.infer<typeof ContactId>;

/** A NEMA configuration's id (`5-15R`, `14-50P`): a row of {@link NEMA_CONFIGS}. */
export const NemaConfigId = z
  .string()
  .max(16)
  .regex(/^L?\d{1,2}-\d{2,3}[PR]$/)
  .meta({ id: 'NemaConfigId', description: 'A NEMA wiring-device configuration: a row of NEMA_CONFIGS.' });
export type NemaConfigId = z.infer<typeof NemaConfigId>;

/** A blade or slot of a NEMA configuration (`hot`, `neutral`, `ground`, `x`, `y`). */
export const PinId = camelId('PinId', 'A blade or slot of a NEMA configuration: lower camelCase.');
export type PinId = z.infer<typeof PinId>;

/**
 * What a terminal is for (catalogue v3, ADR 0020): **read by the inspector only, never by the
 * simulator** (the compiler joins what is landed, whatever a terminal is called). The words follow
 * NFPA 70-2023 Art. 100's definitions (grounded conductor, ungrounded conductor, equipment grounding
 * conductor; cited by number, paraphrased) and switch practice (a 3-way switch's common and its two
 * travellers); `line` and `load` name a protective or switching device's supply and load sides where
 * the conductor's role isn't fixed (a breaker's terminals). `null`: no role worth checking.
 */
export const TERMINAL_ROLES = ['ungrounded', 'grounded', 'egc', 'traveller', 'common', 'line', 'load'] as const;
export const TerminalRole = z.enum(TERMINAL_ROLES);
export type TerminalRole = z.infer<typeof TerminalRole>;

/**
 * Which side of a GFCI device a terminal is on (catalogue v3): the line pair is fed, the load pair
 * feeds downstream outlets; the inspector traces protection through it and a GFCI fed on its load
 * side never latches (ADR 0019). `null` on every terminal of a device without line and load sides.
 */
export const TerminalSide = z.enum(['line', 'load']);
export type TerminalSide = z.infer<typeof TerminalSide>;

/**
 * What can reach a terminal (catalogue v3, ADR 0019 C5): `land`, conductors land on it by one of its
 * methods (and a test lead's clip fits too); `clip`, only a test lead's clip (no methods); `none`,
 * nothing from outside (a plug's blade inside its cord cap, a slot behind a receptacle's face where
 * the entry says so): `lead.connect` refuses it (`inaccessible`). A terminal has methods exactly when
 * it is `land`.
 */
export const TerminalAccess = z.enum(['land', 'clip', 'none']);
export type TerminalAccess = z.infer<typeof TerminalAccess>;

/** What an enclosure is made of (catalogue v3): whether it is metal the inspector expects to be bonded. */
export const EnclosureMaterial = z.enum(['steel', 'nonmetallic']);
export type EnclosureMaterial = z.infer<typeof EnclosureMaterial>;

export interface NemaConfigDef extends Provenance {
  readonly id: string;
  /** A cord cap (`plug`, a `P` designation) or a wiring device's face (`receptacle`, `R`). */
  readonly form: 'plug' | 'receptacle';
  /** Its blades or slots, as pin ids; a plug's pins are a subset of every receptacle that accepts it. */
  readonly pins: readonly string[];
  /** For a receptacle, the plug configurations that enter it; empty for a plug. */
  readonly accepts: readonly string[];
  /** The rating its designation names: amperes, and the highest voltage (V). */
  readonly ratedA: number;
  readonly ratedV: number;
}

const NEMA_WD6 =
  "NEMA WD 6 (cited by number) defines the US wiring-device configurations: the number before the dash names the pattern (1: two-pole two-wire 125 V; 5: two-pole three-wire grounding 125 V; 6: two-pole three-wire grounding 250 V; 14: three-pole four-wire grounding 125/250 V), the number after it the rating in amperes, P a plug and R a receptacle. Which plugs enter which receptacle follows from the blade patterns: a 20 A receptacle's T-slot also takes the 15 A plug of its pattern, and a two-blade 1-15P enters a 5-15R or 5-20R (it has no ground pin to meet). Paraphrased from makers' published configuration charts and NEMA's designations; no chart reproduced. Pin ids (hot, neutral, ground; x and y for the two line blades of 250 V patterns) are the game's names for the blades.";

const nema = (
  id: string,
  form: 'plug' | 'receptacle',
  pins: readonly string[],
  accepts: readonly string[],
  ratedA: number,
  ratedV: number,
  description: string,
): NemaConfigDef => ({ id, form, pins, accepts, ratedA, ratedV, description, kind: 'real-world', source: NEMA_WD6 });

const PINS_2W = ['hot', 'neutral'] as const;
const PINS_GROUNDING_125 = ['hot', 'neutral', 'ground'] as const;
const PINS_GROUNDING_250 = ['x', 'y', 'ground'] as const;
const PINS_4W = ['x', 'y', 'neutral', 'ground'] as const;

/**
 * NEMA wiring-device configurations (catalogue v3, ADR 0019 C6): which plug mates which receptacle,
 * and the pins a plug contact joins (`plug.insert` refuses `wrong-configuration`). Geometry and mating
 * only: a plug's contact resistance is its outlet's (`outlets.<id>.contactOhm`). Ids are save format
 * through the entries that name them; append-only.
 */
export const NEMA_CONFIGS: Readonly<Record<string, NemaConfigDef>> = Object.freeze({
  '1-15P': nema('1-15P', 'plug', PINS_2W, [], 15, 125, 'A two-blade 15 A 125 V plug (no ground pin).'),
  '5-15P': nema('5-15P', 'plug', PINS_GROUNDING_125, [], 15, 125, 'A grounding 15 A 125 V plug.'),
  '5-15R': nema(
    '5-15R',
    'receptacle',
    PINS_GROUNDING_125,
    ['1-15P', '5-15P'],
    15,
    125,
    'A grounding 15 A 125 V receptacle.',
  ),
  '5-20P': nema(
    '5-20P',
    'plug',
    PINS_GROUNDING_125,
    [],
    20,
    125,
    'A grounding 20 A 125 V plug (a turned neutral blade).',
  ),
  '5-20R': nema(
    '5-20R',
    'receptacle',
    PINS_GROUNDING_125,
    ['1-15P', '5-15P', '5-20P'],
    20,
    125,
    'A grounding 20 A 125 V receptacle with a T-slot neutral.',
  ),
  '6-15P': nema('6-15P', 'plug', PINS_GROUNDING_250, [], 15, 250, 'A grounding 15 A 250 V plug.'),
  '6-20P': nema('6-20P', 'plug', PINS_GROUNDING_250, [], 20, 250, 'A grounding 20 A 250 V plug.'),
  '6-20R': nema(
    '6-20R',
    'receptacle',
    PINS_GROUNDING_250,
    ['6-15P', '6-20P'],
    20,
    250,
    'A grounding 20 A 250 V receptacle.',
  ),
  '14-30P': nema('14-30P', 'plug', PINS_4W, [], 30, 250, 'A four-wire grounding 30 A 125/250 V plug (a dryer).'),
  '14-30R': nema(
    '14-30R',
    'receptacle',
    PINS_4W,
    ['14-30P'],
    30,
    250,
    'A four-wire grounding 30 A 125/250 V receptacle.',
  ),
  '14-50P': nema('14-50P', 'plug', PINS_4W, [], 50, 250, 'A four-wire grounding 50 A 125/250 V plug (a range).'),
  '14-50R': nema(
    '14-50R',
    'receptacle',
    PINS_4W,
    ['14-50P'],
    50,
    250,
    'A four-wire grounding 50 A 125/250 V receptacle.',
  ),
} satisfies Record<string, NemaConfigDef>);

/** A NEMA configuration by id (own properties only), or `undefined`. */
export function nemaConfig(id: string): NemaConfigDef | undefined {
  return Object.prototype.hasOwnProperty.call(NEMA_CONFIGS, id) ? NEMA_CONFIGS[id] : undefined;
}

/** Whether a plug of configuration `plug` enters a receptacle outlet of configuration `receptacle`. */
export function nemaMates(plug: string, receptacle: string): boolean {
  const r = nemaConfig(receptacle);
  return r !== undefined && r.form === 'receptacle' && nemaConfig(plug)?.form === 'plug' && r.accepts.includes(plug);
}

export interface AreaUseDef extends Provenance {
  readonly id: string;
}

const AREA_USE_SOURCE =
  "game-design: the location categories the inspector's location rules read. NFPA 70-2023 Arts. 210.8(A) (GFCI protection in dwelling units) and 210.12(B) (AFCI protection in dwelling units) name dwelling locations such as kitchens, bathrooms, garages, outdoors, laundry areas, basements, crawl spaces, bedrooms, living rooms and hallways (cited by number, paraphrased); which rule applies to which use, and whether a basement is finished, are rule parameters (content/rules), not area data.";

const useRow = (id: string, description: string): AreaUseDef => ({
  id,
  description,
  kind: 'game-design',
  source: AREA_USE_SOURCE,
});

/**
 * Area uses (ADR 0019, `WorldV4.areas[].use`): **append-only** across catalogue versions, like the
 * colour ids, so a new use is a catalogue addition and never a `schemaVersion` bump. The load check
 * refuses a use this registry lacks. `basement` replaces the plan's `unfinishedBasement`.
 */
export const AREA_USES: Readonly<Record<string, AreaUseDef>> = Object.freeze({
  kitchen: useRow('kitchen', 'A kitchen.'),
  bathroom: useRow('bathroom', 'A bathroom.'),
  garage: useRow('garage', 'A garage.'),
  outdoor: useRow('outdoor', 'Outdoors.'),
  laundry: useRow('laundry', 'A laundry area.'),
  bedroom: useRow('bedroom', 'A bedroom.'),
  living: useRow('living', 'A living, family or dining room, a den or a similar room.'),
  hall: useRow('hall', 'A hallway.'),
  basement: useRow('basement', 'A basement, finished or not.'),
  crawlSpace: useRow('crawlSpace', 'A crawl space.'),
} satisfies Record<string, AreaUseDef>);

/** An area use by id (own properties only), or `undefined`. */
export function areaUse(id: string): AreaUseDef | undefined {
  return Object.prototype.hasOwnProperty.call(AREA_USES, id) ? AREA_USES[id] : undefined;
}
