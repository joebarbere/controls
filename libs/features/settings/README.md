# @controls/feature-settings

The settings screen (`type:feature`): `ctl-settings-dialog`, `ctl-settings-form`, and `SettingsStore` (the settings document as a signal, debounced saves through `SETTINGS_SERVICE`, theme and motion reflected on `<html>`).

The document is `Settings` from `@controls/save-format`. `apps/game` provides `SETTINGS_SERVICE` from `Platform.settings` (Electron IPC or localStorage); `MemorySettingsService` is the default for tests. Edits made while the stored settings are still loading are replayed on top of them, and nothing is written until the load has finished.

Tests: `pnpm nx test feature-settings`.
