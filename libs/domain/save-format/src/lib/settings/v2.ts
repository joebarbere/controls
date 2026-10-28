import { z } from 'zod';
import { Int, SafeString } from '../primitives';
import { defaultSettingsV1, SettingsV1 } from './v1';

/*
 * FROZEN once v0.2.0 ships: settingsVersion 2. Never edit after that release; add `settings/v3.ts`
 * and a v2 → v3 migration instead.
 *
 * v2 adds `saves.lastPlayed` (Continue resumes the game the player was last in; ADR 0009, "Continue
 * and the last-played save"). Everything else is v1's shape, unchanged. v1 is unpublished (v0.1.0
 * had no settings), so editing it in place was allowed; it is a bump instead because a strict v1
 * with a new required key would refuse every settings file written since F1.1 and reset it to the
 * defaults, and because it gives the settings migration chain a real step before a release relies
 * on it. Both v1 and v2 freeze when v0.2.0 ships.
 */

/** Highest autosave slot a pointer may name: `autosave.slotCount`'s maximum. */
export const MAX_LAST_PLAYED_SLOT = 10;
/** Longest save name a pointer may hold (the platform's `SaveEntry.name` bound). */
export const MAX_LAST_PLAYED_NAME_LENGTH = 255;

/**
 * Where the game the player was last in is in the save directory: a manual save by name, or an
 * autosave slot. A reference, never a handle or a path (handles die with the window, ADR 0009). The
 * game resolves it against a fresh listing; a pointer that matches nothing is ignored, so the name
 * is only bounded here, not checked against the platform's save-name grammar.
 */
export const LastPlayedSave = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), name: SafeString.min(1).max(MAX_LAST_PLAYED_NAME_LENGTH) }),
  z.strictObject({ kind: z.literal('autosave'), slot: Int.min(1).max(MAX_LAST_PLAYED_SLOT) }),
]);
export type LastPlayedSave = z.infer<typeof LastPlayedSave>;

export const SettingsV2 = SettingsV1.extend({
  settingsVersion: z.literal(2),
  saves: z.strictObject({
    /** The save Continue tries first; `null` when the game last played isn't in the save directory. */
    lastPlayed: LastPlayedSave.nullable(),
  }),
}).meta({
  title: 'Controls settings, settingsVersion 2',
  description:
    'The settings document (plan F1.1). Zod in @controls/save-format is authoritative; this JSON Schema omits string well-formedness, JSON nesting limits and the no-repeat rule for palette recents.',
});
export type SettingsV2 = z.infer<typeof SettingsV2>;

/** v1 → v2: no save is known to be the last played, so Continue falls back to the newest save. Pure. */
export function settingsV1ToV2(previous: SettingsV1): SettingsV2 {
  return { ...previous, settingsVersion: 2, saves: { lastPlayed: null } };
}

/** Fresh default settings at v2. Returns a new object on every call, so callers may mutate it. */
export function defaultSettingsV2(): SettingsV2 {
  return settingsV1ToV2(defaultSettingsV1());
}
