# save-format (`@controls/save-format`)

Framework-free domain library (`type:domain`) that owns every persisted document: the Zod schemas are the single source of truth ([ADR 0004](../../../docs/decisions/0004-save-format.md), [ADR 0007](../../../docs/decisions/0007-world-document-v1.md)). Owner: `save-format-guardian`.

- **Documents:** `ManifestV1`, `WorldV1` and `ReplayLogV1` (all `schemaVersion` 1), and `SettingsV1` (`settingsVersion` 1). Current aliases: `World`, `Manifest`, `ReplayLog`, `Settings`. Types are `z.infer`'d; never hand-write a parallel interface.
- **Loading untrusted JSON:** `migrateWorld`, `migrateManifest`, `migrateReplayLog`, `migrateSettings` (or `loadSettings`, which falls back to `defaultSettings()`). They never throw and return a typed `LoadError`. Don't call `.parse` on untrusted input directly (see the [caveats](../../../docs/caveats/save-format.md)).
- **Constructors:** `createWorld`, `createManifest`, `createReplayLog`, `defaultSettings`.
- **Migrations:** `migrationChain(...).then(V2, v1ToV2).build()` makes a chain total by construction.
- **Fixtures:** `fixtures/v<N>/{world,manifest,replay-log}/` and `fixtures/settings/v<N>/`. Every fixture of every version must load forever.
- **JSON Schema:** generated into `json-schema/` and checked in. Regenerate with `pnpm nx test save-format -u`.

The ZIP container, file I/O and autosave are F1.8b. Tests: `pnpm nx test save-format` (90 % coverage gate).
