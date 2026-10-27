import type { SettingsLoadResult } from '@controls/ipc-contract';
import type { Settings } from '@controls/save-format';

export type { SettingsFallbackReason, SettingsLoadResult } from '@controls/ipc-contract';

/**
 * Loads and saves the player's settings document (`Settings`, from `@controls/save-format`).
 * Implementations validate with `loadSettings` and fall back to `defaultSettings()` when the stored
 * document is missing, corrupt, foreign or newer than this build, reporting why. `load()` never
 * rejects. `save()` rejects if the document can't be stored (the caller tells the player).
 */
export interface SettingsService {
  load(): Promise<SettingsLoadResult>;
  save(settings: Settings): Promise<void>;
}
