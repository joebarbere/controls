# Pacing (wall-clock exemption)

This directory is the only place in `libs/sim-worker` allowed to read the wall clock (`performance.now()`, `Date.now()`) or use the `performance` global. The root `eslint.config.mjs` exempts `src/lib/pacing/**` from the determinism lint; everything else in the worker is linted like a domain lib.

The worker reads it for work slicing (`WORK_SLICE_MS`), the publish throttle (`PUBLISH_MIN_WALL_MS`) and the unhashed diagnostics area (`worker-clock.ts`). Which integer tick to advance to is decided on the main thread (`Pacer` in `@controls/sim-protocol`, ADR 0011 §2). Wall-clock readings must never reach `sim-core`, the snapshot bytes or anything hashed.
