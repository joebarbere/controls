# save-format (`@controls/save-format`)

Framework-free domain library (`type:domain`) that owns every persisted document: the Zod schemas are the single source of truth ([ADR 0004](../../../docs/decisions/0004-save-format.md), [ADR 0007](../../../docs/decisions/0007-world-document-v1.md)). Owner: `save-format-guardian`.

- **Documents:** `ManifestV1`, `WorldV1` and `ReplayLogV1` (all `schemaVersion` 1), and `SettingsV1` (`settingsVersion` 1). Current aliases: `World`, `Manifest`, `ReplayLog`, `Settings`. Types are `z.infer`'d; never hand-write a parallel interface.
- **Loading untrusted JSON:** `migrateWorld`, `migrateManifest`, `migrateReplayLog`, `migrateSettings` (or `loadSettings`, which falls back to `defaultSettings()`). They never throw and return a typed `LoadError`. Don't call `.parse` on untrusted input directly (see the [caveats](../../../docs/caveats/save-format.md)).
- **Constructors:** `createWorld`, `createManifest`, `createReplayLog`, `defaultSettings`.
- **Migrations:** `migrationChain(...).then(V2, v1ToV2).build()` makes a chain total by construction.
- **Fixtures:** `fixtures/v<N>/{world,manifest,replay-log}/` and `fixtures/settings/v<N>/`. Every fixture of every version must load forever.
- **JSON Schema:** generated into `json-schema/` and checked in. Regenerate with `pnpm nx test save-format -u`.

- **`.ctrl` container (F1.8b):** `writeCtrl({ manifest, world, replayLog?, thumbnail? }) → Uint8Array` (deterministic bytes; throws `CtrlWriteError`) and `readCtrl(bytes, { limits? }) → { ok, value } | { ok: false, error: CtrlError }` (never throws, never trusts the archive). Caps in `CTRL_LIMITS`; layout in `CTRL_ENTRY`. fflate does DEFLATE; the ZIP structure is `src/lib/container/zip.ts`. Fixtures: `fixtures/v<N>/ctrl/*.ctrl`.
- **Test helpers** (`@controls/save-format/testing`): fast-check arbitraries, `rawZip` (writes any archive, hostile ones included) and `TINY_PNG`.

File I/O, IPC and autosave are F1.8b parts 2 and 3. Tests: `pnpm nx test save-format` (90 % coverage gate).
