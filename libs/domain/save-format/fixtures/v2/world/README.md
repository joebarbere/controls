# World v2 fixtures

Loaded by `fixtures.spec.ts` (every `*.json` here must migrate and validate, and load unchanged).

- **`bench-lamp-mid-interval.json` is schema-only.** Its fuse ref (`fuse.fixture-glass-1a`) and `topologyHash` are invented, and its sim values aren't the output of a real run: it exists to pin the schema's edges (a solve before the world's tick, a tick above 2³¹, 17-digit floats, a subnormal). The fuse bag keys (`blown`, `meltFraction`) are provisional until F2.5 declares the fuse's `MODEL_KINDS`. F2.3a adds a fixture from a real engine run; this one stays, as fixtures are never edited after their version ships.
- `devices-sim-null.json`: catalogue v1 devices and leads, never solved (`sim: null`).
- `props-and-extensions.json`: the v1 fixture of the same name as v2 holds it.
- `empty.json`: `createWorld({ seed: 0 })`.
