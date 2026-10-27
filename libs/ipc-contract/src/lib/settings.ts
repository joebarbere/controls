import {
  CURRENT_SETTINGS_VERSION,
  defaultSettings,
  loadSettings,
  migrateSettings,
  type LoadError,
  type Settings,
} from '@controls/save-format';
import { z } from 'zod';

/**
 * Upper bound for a settings document, in UTF-16 code units of its JSON (≈ bytes for the ASCII
 * the schema mostly holds). The largest valid document (200 × 2000-char console lines) is ≈400 KB,
 * so 1 MiB leaves room without letting a renderer make main parse or write megabytes.
 */
export const MAX_SETTINGS_JSON_LENGTH = 1024 * 1024;

/** Why stored settings were not used. `missing` is a first run and is not worth a warning. */
export const SettingsFallbackReason = z.enum(['missing', 'corrupt', 'unknown-version']);
export type SettingsFallbackReason = z.infer<typeof SettingsFallbackReason>;

/** What `settings:get` returns, and what every `SettingsService.load()` resolves to. */
export interface SettingsLoadResult {
  readonly settings: Settings;
  readonly fallbackReason: SettingsFallbackReason | null;
}

/** Shape check for the `settings:get` response; the settings themselves are re-validated by `loadSettings`. */
export const SettingsGetResponseSchema = z.strictObject({
  settings: z.unknown(),
  fallbackReason: SettingsFallbackReason.nullable(),
});

/** Maps a save-format load error to the reason shown to the player. */
export function fallbackReasonFor(error: LoadError): SettingsFallbackReason {
  switch (error.kind) {
    case 'newer-than-build':
    case 'unsupported-version':
    case 'missing-version':
      return 'unknown-version';
    default:
      return 'corrupt';
  }
}

/**
 * Parses stored settings text (a file in Electron, localStorage in the web harness). `null` means
 * nothing is stored. Anything unusable — not JSON, too large, invalid, newer than this build —
 * yields `defaultSettings()` and a reason, never an exception.
 */
export function parseStoredSettings(text: string | null): SettingsLoadResult {
  if (text === null) return { settings: defaultSettings(), fallbackReason: 'missing' };
  if (text.length > MAX_SETTINGS_JSON_LENGTH) return corrupt();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return corrupt();
  }
  const { settings, error } = loadSettings(json);
  return { settings, fallbackReason: error ? fallbackReasonFor(error) : null };
}

/** Serialises settings for storage. Stable 2-space JSON with a trailing newline (diffable). */
export function serialiseSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export type SettingsWriteCheck =
  | { readonly ok: true; readonly settings: Settings; readonly json: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'not-serialisable' | 'invalid' };

/**
 * Validates a settings document before it is written: it must serialise, fit the size cap and be a
 * valid **current-version** document (no silent migration on write). Returns the canonical JSON.
 * Errors carry a reason code only, never the payload.
 */
export function checkSettingsForWrite(input: unknown): SettingsWriteCheck {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(input);
  } catch {
    return { ok: false, reason: 'not-serialisable' };
  }
  if (raw === undefined) return { ok: false, reason: 'not-serialisable' };
  if (raw.length > MAX_SETTINGS_JSON_LENGTH) return { ok: false, reason: 'too-large' };
  // Re-parse the JSON text rather than the live object: what we validate is exactly what we write.
  const parsed: unknown = JSON.parse(raw);
  const result = migrateSettings(parsed);
  if (!result.ok || (parsed as { settingsVersion?: unknown }).settingsVersion !== CURRENT_SETTINGS_VERSION) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, settings: result.value, json: serialiseSettings(result.value) };
}

function corrupt(): SettingsLoadResult {
  return { settings: defaultSettings(), fallbackReason: 'corrupt' };
}
