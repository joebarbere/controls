# World document and saves

> **Status (P1):** F1.8a has landed: the v1 document schemas, settings schema, migration framework, fixtures and JSON Schema export in `libs/domain/save-format` (`@controls/save-format`). The ZIP container, file I/O, IPC and autosave are F1.8b _(later in P1)_. Decisions: [ADR 0004](../decisions/0004-save-format.md) (container and rules) and [ADR 0007](../decisions/0007-world-document-v1.md) (v1 shape and determinism). Gotchas: [save-format caveats](../caveats/save-format.md). The world's operations, `world.hash` and replay are on the [commands](commands.md) page (F1.2).

## Documents

A `.ctrl` save is a ZIP of JSON documents that share one `schemaVersion`. Settings are a separate document with their own `settingsVersion`. Catalogue entries are referenced by id and version, never inlined.

```mermaid
classDiagram
    direction LR
    class ManifestV1 {
        format = "controls.ctrl"
        schemaVersion = 1
        appVersion: SemVer
        catalogVersion: int (0 = none yet)
        extensions
    }
    class WorldV1 {
        schemaVersion = 1
        seed: uint32
        tick: int (0 until P2)
        nextEntityId: int
        regionId: "nec"
        difficulty
        assisted: boolean
        extensions
    }
    class EntityV1 {
        id: int (sorted, unique)
        ref: CatalogRef
        transform.positionMm: x, y, z (int mm)
        transform.orientationMdeg: yaw, pitch, roll (int millidegrees)
        extensions
    }
    class CatalogRef {
        id: "prop.crate"
        version: 1
    }
    class ReplayLogV1 {
        schemaVersion = 1
        initialWorld: WorldV1
    }
    class ReplayEntryV1 {
        seq: 0, 1, 2…
        tick: non-decreasing
        id: command id
        args: JSON object
    }
    class SettingsV1 {
        settingsVersion = 1
        graphics, audio, controls
        palette, console, display
        gameplay, workspace
        autosave, toolBelt
        extensions
    }
    WorldV1 "1" *-- "*" EntityV1 : entities
    EntityV1 --> CatalogRef
    ReplayLogV1 *-- WorldV1 : initialWorld
    ReplayLogV1 "1" *-- "*" ReplayEntryV1 : entries
    SettingsV1 --> CatalogRef : toolBelt.slots
```

| Document                | File in `.ctrl`           | Schema         | Version key       |
| ----------------------- | ------------------------- | -------------- | ----------------- |
| Manifest                | `manifest.json`           | `ManifestV1`   | `schemaVersion`   |
| World                   | `world.json`              | `WorldV1`      | `schemaVersion`   |
| Replay log              | `replay.log` (optional)   | `ReplayLogV1`  | `schemaVersion`   |
| Prints, PLC, HMI        | `prints/`, `plc/`, `hmi/` | (P6, P10, P12) | `schemaVersion`   |
| Settings (not in saves) | settings store (F1.1)     | `SettingsV1`   | `settingsVersion` |

JSON Schema for each document is generated from Zod into `libs/domain/save-format/json-schema/` for docs, mods and tools. Zod stays authoritative.

## Loading

Every load goes through a migrator, which never throws and returns `{ ok: true, value, fromVersion }` or a typed `LoadError`.

```mermaid
flowchart TD
    BYTES["bytes (F1.8b: ZIP entry, UTF-8)"] --> PARSE["JSON.parse"]
    PARSE --> OBJ{"plain object?"}
    OBJ -- no --> E1["not-an-object"]
    OBJ -- yes --> DEPTH{"nesting ≤ 64?<br/>(iterative)"}
    DEPTH -- no --> E2["too-deep"]
    DEPTH -- yes --> VER{"version key"}
    VER -- "missing / not an integer" --> E3["missing-version"]
    VER -- "> current" --> E4["newer-than-build<br/>(refused, never half-loaded)"]
    VER -- "< 1" --> E5["unsupported-version"]
    VER -- "1..current" --> PROTO{"own __proto__ key?"}
    PROTO -- yes --> E6["invalid"]
    PROTO -- no --> V0["validate at its own version (frozen schema)"]
    V0 -- fails --> E6
    V0 --> STEP["migrate n → n+1 (pure)<br/>validate against schema n+1"]
    STEP -- "throws / invalid" --> E7["migration-failed"]
    STEP -- "n+1 < current" --> STEP
    STEP --> OK["current document"]
    V0 -- "already current" --> OK
```

## Who uses it

```mermaid
flowchart LR
    classDef done fill:#dff5e1,stroke:#2e7d32;
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;

    SF["@controls/save-format<br/>schemas · migrations · fixtures"]:::done
    UNITS["@controls/units<br/>APP_VERSION"]:::done
    WM["@controls/world-model (F1.2)<br/>world ops, sfc32, world.hash"]:::later
    CMD["@controls/commands (F1.2)<br/>replay log entries"]:::later
    CTR["container + I/O (F1.8b)<br/>ZIP, atomic write, autosave"]:::later
    SET["SettingsService (F1.1)<br/>platform-api"]:::later
    CLI["apps/sim-cli (F1.6)<br/>replay, hash"]:::later

    SF --> UNITS
    WM --> SF
    CMD --> SF
    CTR --> SF
    SET --> SF
    CLI --> WM
```

## Determinism hooks

- **Ids:** `nextEntityId` counter in the world. Undoing a place restores it, and undoing a delete reinserts the same id.
- **Randomness:** the world `seed` feeds sfc32 streams derived per use, so no generator state is persisted (ADR 0007).
- **Hash:** SHA-256 over canonical JSON of the world document only (sorted keys, normalised `-0`).
- **Replay:** `initialWorld` plus `{ seq, tick, id, args }` entries reproduce the saved world's hash.

## Related

- [Architecture overview](overview.md) · [ADR 0004](../decisions/0004-save-format.md) · [ADR 0007](../decisions/0007-world-document-v1.md) · [save-format caveats](../caveats/save-format.md)
- [Phase 1 plan](../../plans/phase-1-game-shell.md) F1.2, F1.8
