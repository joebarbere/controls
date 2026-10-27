# ADR 0004: Save format (`.ctrl`)

**Status:** Accepted (implementation in P1, F1.8)
**Date:** 2026-10-26 (Phase 0)
**Sources:** plan §4.4, §4.6, §4.8, §9.3; [tech-stack research](../research/2026-10-tech-stack.md) §4

## Context

A save must hold the physical as-built world, prints (which may disagree with the as-built), PLC programs, HMI screens, an optional replay log and a thumbnail. Saves must survive app upgrades for years, be diffable and debuggable, reference catalogue devices rather than copying them (so content fixes reach old saves), and later double as the basis of the mod-pack format. The world seed and command log must reproduce a session exactly.

## Options

1. **A single JSON file.** Simple, but a thumbnail and large replay logs bloat it, and every editor document is coupled into one blob.
2. **SQLite.** Good for partial updates, but opaque to diff, needs a native module in main, and adds migration tooling.
3. **A ZIP container of JSON documents** with a manifest.
4. **A binary format** (MessagePack/protobuf). Compact but hard to debug and to keep forward-compatible.

## Decision

**Option 3.** A `.ctrl` file is a ZIP (fflate) containing `manifest.json`, `world.json`, `prints/*.json`, `plc/*.json`, `hmi/*.json`, an optional `replay.log` and `thumbnail.png`.

- **Zod schemas in `libs/domain/save-format` are the source of truth**; JSON Schema is exported from them for docs and mods.
- An integer **`schemaVersion`** drives a pure, total **migration chain** (`n → n+1`). Published schema versions are never edited in place.
- Data is plain: `JSON.parse(JSON.stringify(x))` is lossless. Catalogue devices are stored as references (id + version), never inlined. An `extensions` bag keeps forward compatibility. The world `seed` is part of the state.
- Geometry is integer millimetres (right-handed, +y up); electrical values are SI floats. AWG and inches are display-only.
- Saves are written **atomically** (temp file, then rename) in the Electron main process. Autosave rotates N slots.
- `schemaVersion` and `catalogVersion` are versioned independently of the app version and recorded in [`docs/history.md`](../history.md).

## Consequences

- `save-format-guardian` (created in P1) owns the format. Every schema change ships with a fixture and a round-trip test; every fixture from every version must load.
- The manifest records the app version (from `@controls/units` `version.ts`) and `schemaVersion`.
- Pre-1.0, breaking changes are allowed only with a migration.
- The same container shape is the starting point for the P13 mod-pack format.
