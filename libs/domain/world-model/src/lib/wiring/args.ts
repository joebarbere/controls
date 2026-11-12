import { cableRefMeta, connectionRefMeta, entityRefMeta } from '@controls/commands';
import {
  CatalogRef,
  ConductorColourV3,
  DieId,
  EntryId,
  FiniteNumber,
  HoleId,
  Int,
  LabelText,
  MAX_CABLE_TAIL_MM,
  MAX_CONDUCTOR_LENGTH_MM,
  MAX_ROUTE_WAYPOINTS,
  TerminalId,
  TerminationMethodId,
  WaypointV3,
} from '@controls/save-format';
import * as z from 'zod';

/*
 * The argument shapes of the world v3 commands (ADR 0015, "Commands"), exactly as the ADR pins them.
 * Every id and shape here is save format from the moment it is logged: `command-args.spec.ts` freezes
 * each in `json-schema/command-args/<id>.args.schema.json`. `.meta()` only adds form hints (titles,
 * descriptions, `x-controls-ref`), never behaviour.
 *
 * Key order is console grammar (positional words fill keys in declaration order): keep it.
 */

/** Most conductors one `wire.pull` pulls (ADR 0015: 1..16). */
export const MAX_PULL_CONDUCTORS = 16;

/** A tool entry (`content/tools`), checked by the capability its step needs. */
export const ToolRefArg = CatalogRef.meta({ title: 'Tool', description: 'A tool in the catalogue (tool.…)' });

const EntityIdArg = Int.min(1).meta({ ...entityRefMeta, title: 'Entity' });
/** A connection id: a conductor for the `wire.*` commands. */
export const ConnectionIdArg = Int.min(1).meta({ ...connectionRefMeta, title: 'Wire' });
/** A cable id. */
export const CableIdArg = Int.min(1).meta({ ...cableRefMeta, title: 'Cable' });
/** Which end of a connection or cable. */
export const EndName = z.enum(['a', 'b']).meta({ title: 'End' });
export type EndName = z.infer<typeof EndName>;

/** One waypoint of a route (the save-format shape; integer mm). */
export const WaypointArg = WaypointV3.meta({ title: 'Waypoint' });
/** A route's explicit waypoints, from end `a` to end `b` (D5): at most `MAX_ROUTE_WAYPOINTS`. */
export const RouteArg = z.array(WaypointArg).max(MAX_ROUTE_WAYPOINTS).meta({ title: 'Route' });
/** A cut length in integer mm: 1 to `MAX_CONDUCTOR_LENGTH_MM` (the command checks the floor, `too-short`). */
export const LengthMmArg = Int.min(1).max(MAX_CONDUCTOR_LENGTH_MM).meta({ title: 'Length (mm)' });
/** A conductor colour: colour-table ids, base and optional stripe. */
export const ColourArg = ConductorColourV3.meta({ title: 'Colour' });
/** A label's text, or `null` to remove it. */
export const LabelTextArg = LabelText.nullable().meta({ title: 'Text' });

/** The tool steps of one landing (ADR 0015): strip, an optional crimped accessory, and the clamp. */
export const TerminationArgsSchema = z
  .strictObject({
    method: TerminationMethodId.meta({ title: 'Method', description: 'One of the terminal’s methods (screw, …)' }),
    strip: z
      .strictObject({
        tool: ToolRefArg.meta({ title: 'Stripper' }),
        hole: HoleId.meta({ title: 'Hole' }),
        lengthMm: Int.min(1).max(100).meta({ title: 'Strip length (mm)' }),
      })
      .meta({ title: 'Strip' }),
    accessory: z
      .strictObject({
        ref: CatalogRef.meta({ title: 'Ferrule or lug' }),
        tool: ToolRefArg.meta({ title: 'Crimper' }),
        die: DieId.meta({ title: 'Die' }),
      })
      .nullable()
      .meta({ title: 'Accessory' }),
    clamp: z
      .strictObject({
        tool: ToolRefArg.nullable().meta({ title: 'Driver' }),
        torqueNm: FiniteNumber.min(0).nullable().meta({ title: 'Torque setting (N·m)' }),
      })
      .meta({ title: 'Clamp' }),
  })
  .meta({ title: 'Specify' });
export type TerminationArgsInput = z.infer<typeof TerminationArgsSchema>;

/** `'auto'` (Trainee only, D9: a logged value, not shorthand) or the explicit steps. */
export const TerminationArgSchema = z.union([z.literal('auto'), TerminationArgsSchema]).meta({ title: 'Termination' });

/** A landed end: a terminal and how the conductor is terminated on it. */
export const LandedEndArg = z.strictObject({
  entity: EntityIdArg,
  terminal: TerminalId.meta({ title: 'Terminal', description: 'A terminal id of that device (l1, line, …)' }),
  termination: TerminationArgSchema,
});
export type LandedEndArg = z.infer<typeof LandedEndArg>;

export const WireAddArgs = z.strictObject({
  ref: CatalogRef.meta({ title: 'Conductor', description: 'A conductor in the catalogue (conductor.…)' }),
  a: LandedEndArg.nullable().meta({ title: 'End a' }),
  b: LandedEndArg.nullable().meta({ title: 'End b' }),
  route: RouteArg,
  lengthMm: LengthMmArg,
  colour: ColourArg,
  tool: ToolRefArg.meta({ title: 'Cutter' }),
});
export type WireAddArgs = z.infer<typeof WireAddArgs>;

export const WireDeleteArgs = z.strictObject({ id: ConnectionIdArg });
export type WireDeleteArgs = z.infer<typeof WireDeleteArgs>;

export const WireRerouteArgs = z.strictObject({ id: ConnectionIdArg, route: RouteArg });
export type WireRerouteArgs = z.infer<typeof WireRerouteArgs>;

export const WireLandArgs = z.strictObject({
  id: ConnectionIdArg,
  end: EndName,
  at: LandedEndArg.meta({ title: 'At' }),
});
export type WireLandArgs = z.infer<typeof WireLandArgs>;

export const WireUnlandArgs = z.strictObject({ id: ConnectionIdArg, end: EndName });
export type WireUnlandArgs = z.infer<typeof WireUnlandArgs>;

export const WireLabelArgs = z.strictObject({
  id: ConnectionIdArg,
  text: LabelTextArg,
  tool: ToolRefArg.meta({ title: 'Label maker' }),
});
export type WireLabelArgs = z.infer<typeof WireLabelArgs>;

export const PulledConductorArg = z
  .strictObject({
    ref: CatalogRef.meta({ title: 'Conductor', description: 'A conductor in the catalogue (conductor.…)' }),
    colour: ColourArg,
  })
  .meta({ title: 'Conductor' });

export const WirePullArgs = z.strictObject({
  route: RouteArg,
  lengthMm: LengthMmArg,
  conductors: z.array(PulledConductorArg).min(1).max(MAX_PULL_CONDUCTORS).meta({ title: 'Conductors' }),
  tool: ToolRefArg.meta({ title: 'Fish tape' }),
});
export type WirePullArgs = z.infer<typeof WirePullArgs>;

/** A cable end: `CableEndV3`'s shape, with form hints. */
const CableEndArg = z
  .strictObject({
    entity: EntityIdArg.meta({ ...entityRefMeta, title: 'Enclosure' }),
    entry: EntryId.meta({ title: 'Entry', description: "An entry id of the enclosure's catalogue entry (ko1, top)" }),
  })
  .meta({ title: 'Entry' });

const PerEndMm = z.strictObject({
  a: Int.min(0).max(MAX_CABLE_TAIL_MM).meta({ title: 'End a' }),
  b: Int.min(0).max(MAX_CABLE_TAIL_MM).meta({ title: 'End b' }),
});

export const CableAddArgs = z.strictObject({
  ref: CatalogRef.meta({ title: 'Cable', description: 'A cable assembly in the catalogue (cable.…)' }),
  a: CableEndArg.nullable().meta({ title: 'End a' }),
  b: CableEndArg.nullable().meta({ title: 'End b' }),
  route: RouteArg,
  lengthMm: LengthMmArg,
  tailsMm: PerEndMm.meta({ title: 'Tails (mm)' }),
  tool: ToolRefArg.meta({ title: 'Cutter' }),
});
export type CableAddArgs = z.infer<typeof CableAddArgs>;

export const CableStripArgs = z.strictObject({
  id: CableIdArg,
  end: EndName,
  jacketMm: Int.min(0).max(MAX_CABLE_TAIL_MM).meta({ title: 'Jacket stripped (mm)' }),
  tool: ToolRefArg.meta({ title: 'Stripper' }),
});
export type CableStripArgs = z.infer<typeof CableStripArgs>;

export const CableDeleteArgs = z.strictObject({ id: CableIdArg });
export type CableDeleteArgs = z.infer<typeof CableDeleteArgs>;

export const CableRerouteArgs = z.strictObject({ id: CableIdArg, route: RouteArg });
export type CableRerouteArgs = z.infer<typeof CableRerouteArgs>;

export const CableLabelArgs = z.strictObject({
  id: CableIdArg,
  text: LabelTextArg,
  tool: ToolRefArg.meta({ title: 'Label maker' }),
});
export type CableLabelArgs = z.infer<typeof CableLabelArgs>;

export const EnclosureOpenEntryArgs = z.strictObject({
  id: EntityIdArg.meta({ ...entityRefMeta, title: 'Enclosure' }),
  entry: EntryId.meta({ title: 'Entry', description: "An entry id of the enclosure's catalogue entry (ko1, top)" }),
  tool: ToolRefArg,
});
export type EnclosureOpenEntryArgs = z.infer<typeof EnclosureOpenEntryArgs>;

export const EntityLabelArgs = z.strictObject({
  id: EntityIdArg,
  text: LabelTextArg,
  tool: ToolRefArg.meta({ title: 'Label maker' }),
});
export type EntityLabelArgs = z.infer<typeof EntityLabelArgs>;
