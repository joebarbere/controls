import type { SettingsDocument } from '@controls/platform-api';

/**
 * Default settings. TODO(F1.8a): replace with `defaultSettings()` from `@controls/save-format`.
 * The workspace layout default mirrors `DEFAULT_WORKSPACE_LAYOUT` in feature-workspace.
 */
export const PLACEHOLDER_DEFAULT_SETTINGS: SettingsDocument = {
  graphics: { backend: 'auto', pixelRatioCapPercent: 200 },
  audio: { master: 80, effects: 80, ambience: 60 },
  controls: { lookSensitivityPercent: 100, invertY: false },
  units: { display: 'imperial' },
  difficulty: { default: 'apprentice' },
  region: { id: 'nec' },
  interface: { theme: 'system', motion: 'system' },
  workspace: {
    layout: { inspector: { size: 320, collapsed: false }, bottom: { size: 200, collapsed: false } },
  },
};
