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
import { z } from 'zod';

/*
 * The catalogue entry format, catalogue v1 (plan P2 decision D4, ADR 0013). One device definition per
 * file in `content/devices/` (`<id>.v<version>.json`). Saves reference an entry by `{ id, version }`
 * and never inline it (ADR 0004), so a content fix reaches old saves. Every number in an entry has a
 * `source` (realism charter, plan §3), and brands are fictional.
 *
 * This schema validates one entry's shape; `parseCatalog` adds the rules that need the model kind
 * (parameters, terminals, controls) and source coverage.
 */

const Label = (max: number) => SafeString.min(1).max(max);

/** Outer size in the device's own frame: width along +x, height along +y, depth along +z (integer mm). */
export const DeviceSizeMm = z.strictObject({
  widthMm: Int.min(1),
  heightMm: Int.min(1),
  depthMm: Int.min(1),
});

/** A terminal: where a lead's clip (and from P3 a conductor) lands. */
export const DeviceTerminal = z.strictObject({
  id: TerminalId,
  /** What the device's marking says (`+`, `−`, `1`). Display text only. */
  label: Label(16),
  /** Position in the device's own frame (integer mm), for drawing leads and picking. */
  positionMm: z.strictObject({ x: Int, y: Int, z: Int }),
});
export type DeviceTerminal = z.infer<typeof DeviceTerminal>;

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

/** Paths a source can cover: one parameter, the size, or the terminal layout. */
export const SOURCE_PATH_PATTERN = /^(?:model\.params\.[a-z][a-zA-Z0-9]*|sizeMm|terminals)$/;

/**
 * Where a value comes from (realism charter, plan §3). `real-world` values cite a standard, a
 * datasheet class or a reference text (paraphrased, never copied; no NEC tables, ADR 0003);
 * `game-design` values say they were chosen for play.
 */
export const DeviceSource = z.strictObject({
  id: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  kind: z.enum(['real-world', 'game-design']),
  citation: Label(600),
  /** What this source supports: `model.params.<name>`, `sizeMm` or `terminals`. */
  covers: z.array(z.string().max(80).regex(SOURCE_PATH_PATTERN)).min(1),
});
export type DeviceSource = z.infer<typeof DeviceSource>;

/** Device categories, for the palette and the build menu. Adding one is a catalogue change. */
export const DeviceCategory = z.enum(['source', 'load', 'switch', 'protection', 'lead']);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

/** One catalogue entry (catalogue format v1). */
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
    sources: z.array(DeviceSource).min(1),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls device catalogue entry, catalogue format v1',
    description:
      'One file in content/devices/ (ADR 0013). Zod in @controls/catalog is authoritative; this JSON Schema omits the rules that depend on the model kind (parameters, terminals, controls) and source coverage.',
  });
export type DeviceDefinition = z.infer<typeof DeviceDefinition>;
