import { z } from 'zod';
import {
  boundedJsonValue,
  CatalogRef,
  CommandId,
  Difficulty,
  Extensions,
  FiniteNumber,
  Int,
  RegionId,
  SafeString,
} from '../primitives';

/*
 * FROZEN once v0.2.0 ships: settingsVersion 1 (versioned separately from the save's schemaVersion).
 * Never edit after that release; add `settings/v2.ts` and a v1 → v2 migration instead.
 *
 * Every value here is a game-design or UI preference, not a real-world constant, so none needs a
 * `source` (realism charter §3).
 */

/** Most recent palette commands kept, most recent first. */
export const MAX_PALETTE_RECENTS = 20;
/** Console lines kept in history, oldest first. Writers drop the oldest line beyond this. */
export const MAX_CONSOLE_HISTORY = 200;
/** Longest console line kept in history. */
export const MAX_CONSOLE_LINE_LENGTH = 2000;
/** Tool belt slots, bound to keys 1-9 (plan F1.4). */
export const TOOL_BELT_SLOTS = 9;

const Volume = FiniteNumber.min(0).max(1);

/**
 * A key chord as written by the keybinding service, e.g. `Mod+Shift+P`. The grammar and canonical
 * form are `normaliseChord` in `@controls/commands` (ADR 0006 "Keybindings"); this schema only
 * bounds the string, and the service ignores (and reports) a chord it can't use.
 */
export const KeyChord = SafeString.min(1).max(64);

export const SettingsV1 = z
  .strictObject({
    settingsVersion: z.literal(1),
    graphics: z.strictObject({
      /** `auto` tries WebGPU first and falls back to WebGL2. */
      backend: z.enum(['auto', 'webgl2']),
      /** Upper bound on `devicePixelRatio` used for rendering. */
      pixelRatioCap: FiniteNumber.min(0.5).max(4),
    }),
    /** Volumes in [0, 1]. Stored only until audio arrives in P4. */
    audio: z.strictObject({
      master: Volume,
      effects: Volume,
      ambience: Volume,
      interface: Volume,
    }),
    controls: z.strictObject({
      /** Mouse-look multiplier. */
      lookSensitivity: FiniteNumber.min(0.1).max(10),
      invertY: z.boolean(),
      /**
       * User overrides of default keybindings: **binding id** → chord, or `null` for explicitly unbound.
       * A binding id is a command id (`edit.undo`), a fixed-argument binding (`toolbelt.select.slot3`)
       * or an input action (`input.moveForward`, never logged); all fit the command-id grammar.
       * A binding without an entry uses its default (`CommandDef.keybinding`, `INPUT_ACTIONS`).
       */
      keybindings: z.record(CommandId, KeyChord.nullable()),
    }),
    palette: z.strictObject({
      /** Most recent first, no duplicates. */
      recents: z
        .array(CommandId)
        .max(MAX_PALETTE_RECENTS)
        .refine((ids) => new Set(ids).size === ids.length, { message: 'Palette recents must not repeat' }),
    }),
    console: z.strictObject({
      /** Oldest first. */
      history: z.array(SafeString.max(MAX_CONSOLE_LINE_LENGTH)).max(MAX_CONSOLE_HISTORY),
    }),
    display: z.strictObject({
      /** Display only: storage is always integer mm and SI (ADR 0004). */
      units: z.enum(['imperial', 'metric']),
      /** `system` follows `prefers-color-scheme`. */
      theme: z.enum(['system', 'light', 'dark']),
      /** `system` follows `prefers-reduced-motion`. */
      reducedMotion: z.enum(['system', 'reduce', 'full']),
    }),
    gameplay: z.strictObject({
      /** Default for new games; each world stores its own difficulty. */
      defaultDifficulty: Difficulty,
      /** Region for new games. NEC only (shown disabled in P1). */
      region: RegionId,
    }),
    workspace: z.strictObject({
      /** Docking layout, opaque to this schema (ADR 0005 picks the docking library). `null` = default layout. */
      layout: boundedJsonValue('workspace.layout'),
    }),
    autosave: z.strictObject({
      enabled: z.boolean(),
      /** Rotating autosave slots kept. */
      slotCount: Int.min(1).max(10),
      /** Seconds between autosaves while playing. */
      intervalSeconds: Int.min(60).max(3600),
    }),
    toolBelt: z.strictObject({
      /** Slots 1-9 in order; `null` is an empty slot. In P1 a slot holds a placeable prop. */
      slots: z.array(CatalogRef.nullable()).length(TOOL_BELT_SLOTS),
    }),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls settings, settingsVersion 1',
    description:
      'The settings document (plan F1.1). Zod in @controls/save-format is authoritative; this JSON Schema omits string well-formedness, JSON nesting limits and the no-repeat rule for palette recents.',
  });
export type SettingsV1 = z.infer<typeof SettingsV1>;

/** Fresh default settings. Returns a new object on every call, so callers may mutate it. */
export function defaultSettingsV1(): SettingsV1 {
  const prop = (id: string): CatalogRef => ({ id, version: 1 });
  return {
    settingsVersion: 1,
    graphics: { backend: 'auto', pixelRatioCap: 2 },
    audio: { master: 1, effects: 1, ambience: 1, interface: 1 },
    controls: { lookSensitivity: 1, invertY: false, keybindings: {} },
    palette: { recents: [] },
    console: { history: [] },
    display: { units: 'imperial', theme: 'system', reducedMotion: 'system' },
    gameplay: { defaultDifficulty: 'apprentice', region: 'nec' },
    workspace: { layout: null },
    autosave: { enabled: true, slotCount: 3, intervalSeconds: 300 },
    toolBelt: {
      slots: [prop('prop.box'), prop('prop.crate'), prop('prop.spool'), null, null, null, null, null, null],
    },
    extensions: {},
  };
}
