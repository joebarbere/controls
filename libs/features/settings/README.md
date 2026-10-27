# @controls/feature-settings

The settings screen (`type:feature`): `ctl-settings-dialog`, `ctl-settings-form`, and `SettingsStore` (the settings document as a signal, debounced saves through `SETTINGS_SERVICE`, theme and motion reflected on `<html>`).

`SettingsDocument` and `PLACEHOLDER_DEFAULT_SETTINGS` are placeholders until `SettingsV1` and `defaultSettings()` land in `@controls/save-format` (F1.8a). Until then `SETTINGS_SERVICE` defaults to an in-memory `MemorySettingsService`.

Tests: `pnpm nx test feature-settings`.
