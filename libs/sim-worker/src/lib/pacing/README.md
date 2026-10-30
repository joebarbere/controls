# Pacing (wall-clock exemption)

This directory is the only place in `libs/sim-worker` allowed to read the wall clock (`performance.now()`, `Date.now()`) or use the `performance` global. The root `eslint.config.mjs` exempts `src/lib/pacing/**` from the determinism lint; everything else in the worker is linted like a domain lib.

Pacing decides _when_ to advance the sim (how many integer ticks to run this frame to approach the requested speed), never _what_ the sim computes: wall-clock readings must never reach `sim-core`, the snapshot bytes or anything hashed. Empty until F2.3b (plan `plans/phase-2-circuit-engine.md`, ADR 0011).
