import { TERMINAL_ID_PATTERN } from '@controls/save-format';
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

/** The grammar of colour, method, table and table-key ids: lower camelCase, at most 32 (ADR 0015). */
export const CAMEL_ID_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

const camelId = (id: string, description: string) =>
  z.string().max(32).regex(CAMEL_ID_PATTERN).meta({ id, description });
const terminalGrammar = (id: string, description: string) =>
  z.string().max(32).regex(TERMINAL_ID_PATTERN).meta({ id, description });

/*
 * ADR 0015 names these primitives for world v3 (`ColourId`, `TerminationMethodId`, `MountId`,
 * `EntryId`, `HoleId`, `DieId`). The catalogue defines them here with exactly the ADR's grammar;
 * `save-format`'s v3 schemas (world v3 PR) declare their own copies, and a test there pins that the
 * two accept the same strings.
 */

/** A row of the catalogue colour table (`black`, `white`, `green`, `bare`). */
export const ColourId = camelId('ColourId', 'A row of the catalogue colour table: lower camelCase, at most 32.');
/** A termination method in {@link TERMINATION_METHODS}. */
export const TerminationMethodId = camelId('TerminationMethodId', 'A termination method id: lower camelCase.');
/** A mount of an enclosure entry, unique within the entry (TerminalId's grammar). */
export const MountId = terminalGrammar('MountId', 'A mount id within one catalogue entry (TerminalId grammar).');
/** A cable entry of an enclosure entry, unique within the entry (TerminalId's grammar). */
export const EntryId = terminalGrammar('EntryId', 'An enclosure entry id within one catalogue entry.');
/** A strip hole of a tool entry, unique within it (TerminalId's grammar). */
export const HoleId = terminalGrammar('HoleId', 'A stripping hole id within one tool entry.');
/** A crimp die of a tool entry, unique within it (TerminalId's grammar). */
export const DieId = terminalGrammar(
  'DieId',
  'A crimp die id within one tool entry; accessories list the die ids that crimp them.',
);
/** A table name (`materials`, `insulation`, `colours`). */
export const TableName = camelId('TableName', 'A catalogue table name: lower camelCase.');
/** A row key of a table (`copper`, `thhnThwn2`). */
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

/** Accessory kinds (family `accessory`, crimped onto a conductor end). */
export const AccessoryKind = z.enum(['ferrule', 'ringLug', 'forkLug']);
export type AccessoryKind = z.infer<typeof AccessoryKind>;

/** The id prefix each accessory kind's entries use (one catalogue namespace, ADR 0015). */
export const ACCESSORY_PREFIX: Readonly<Record<AccessoryKind, string>> = Object.freeze({
  ferrule: 'ferrule.',
  ringLug: 'lug.',
  forkLug: 'lug.',
});

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
    description: 'A push-in (back-wired) device terminal: a spring tab grips a solid conductor pushed into a hole.',
    kind: 'real-world',
    source:
      'Push-in back-wire terminals of US wiring devices (switches and receptacles listed to UL 20 and UL 498, cited by number): a solid conductor is pushed into a hole past a spring contact; no screw and no torque.',
  },
  twistOn: {
    id: 'twistOn',
    clampTorque: false,
    accessories: [],
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
}

/** Mount types (D11): what a device declares it fits and what an enclosure offers. */
export const MOUNT_TYPES: Readonly<Record<string, MountTypeDef>> = Object.freeze({
  din35: {
    id: 'din35',
    occupancy: 'linear',
    description: 'A 35 mm top-hat DIN rail: devices clip on and sit side by side along it.',
    kind: 'real-world',
    source:
      'The 35 mm top-hat mounting rail standardised in IEC 60715 (formerly EN 50022), cited by number: devices snap onto it and can slide along it; their widths along the rail add up.',
  },
  backplate: {
    id: 'backplate',
    occupancy: 'area',
    description: 'A panel backplate (mounting pan): rails, duct and devices are fixed anywhere on its face.',
    kind: 'game-design',
    source:
      'game-design: a control-panel backplate is drilled and tapped where parts go, so any free place on its face can take a part; modelled as an area without overlap.',
  },
  deviceYoke: {
    id: 'deviceYoke',
    occupancy: 'single',
    description:
      "A device box's yoke position: one wiring device (switch, receptacle) screwed to the box by its strap.",
    kind: 'real-world',
    source:
      "US wiring devices mount by their yoke (strap) to a device box with two screws, one device per gang; a two-gang box has two yoke positions (outlet-box practice, UL 514A by number). P4's devices use them.",
  },
  studFlange: {
    id: 'studFlange',
    occupancy: 'single',
    description: "A box's flange or bracket fixing it to the side of a framing stud.",
    kind: 'real-world',
    source:
      'Nail-on and screw-on boxes for wood framing fix to the side of a stud by a flange or bracket (common practice). In P3 a level fixture (a stud) is never a host, so this type is declared for P4.',
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
}

/** Enclosure entry types (ADR 0015): how a cable gets into an enclosure, and what opens the way. */
export const ENTRY_TYPES: Readonly<Record<string, EntryTypeDef>> = Object.freeze({
  knockout: {
    id: 'knockout',
    opens: ['drive', 'openEntry'],
    description: 'A pre-scored knockout in a metal box, sized for a conduit trade size.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: a pre-scored knockout slug is tapped loose with a screwdriver and twisted off with pliers, or punched with a knockout punch; one tool with either capability opens it (the pliers step is folded in).',
  },
  pryout: {
    id: 'pryout',
    opens: ['drive'],
    description: 'A pryout (twist-out) for a cable clamp, pried out with a screwdriver.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: pryouts behind a box’s cable clamps are pried out with a flat screwdriver.',
  },
  clamp: {
    id: 'clamp',
    opens: ['drive'],
    description: 'A built-in cable clamp or knock-in tab of a non-metallic box, pushed open with a screwdriver.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: the knock-in tabs of non-metallic boxes are pushed in with a screwdriver blade; every entry starts closed (ADR 0015), so a clamp entry is opened like the others.',
  },
  drillSite: {
    id: 'drillSite',
    opens: ['bore', 'openEntry'],
    description: 'A place on a blank enclosure wall where a hole may be drilled, sawn or punched.',
    kind: 'game-design',
    source:
      'game-design abstraction of practice: a blank wall is opened with a hole saw, step drill or knockout punch at a place the catalogue entry declares (ADR 0015: custom entries are catalogue drill sites, not a world list).',
  },
} satisfies Record<string, EntryTypeDef>);

/** An entry type by id (own properties only), or `undefined`. */
export function entryType(id: string): EntryTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(ENTRY_TYPES, id) ? ENTRY_TYPES[id] : undefined;
}

/** Id prefixes reserved for the non-device families (one catalogue namespace, ADR 0015). */
export const FAMILY_PREFIXES = Object.freeze({
  tool: ['tool.'],
  cable: ['cable.'],
  accessory: ['ferrule.', 'lug.'],
  conductor: ['conductor.'],
} as const);
