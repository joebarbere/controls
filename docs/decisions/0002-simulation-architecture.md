# ADR 0002: Simulation architecture

**Status:** Accepted (implementation starts in P2)
**Date:** 2026-10-26 (Phase 0)
**Sources:** plan §1 pillars, §3, §4.3–4.5; [circuit-simulation research](../research/2026-10-circuit-simulation.md)

## Context

The game's pillars require that the simulator runs **what is wired, not what is drawn**, and that **meters tell the truth**: voltage under load, ghost voltage on a 10 MΩ meter, current imbalance on a single-phased motor. The same engine must handle 24 VDC control circuits, 120/240 V residential and 208Y/120 / 480Y/277 three-phase power, relay and contactor timing, protection trip curves, motor dynamics, process models and (later) PLC scans, for plants of about 2,000 nodes, at interactive rates and deterministically.

## Options

1. **Full time-domain transient simulation** (SPICE-style, ngspice via WASM, or a port). Most accurate, but a 60 Hz waveform needs sub-millisecond steps for the whole plant, eecircuit-engine is batch-only and about 43 MB, and stiff relay/motor systems make it slow and fragile.
2. **Logic-level only** (boolean signal propagation, as in most PLC trainers). Fast, but can't produce voltage drop, ghost voltage, imbalance or fault current, which defeats the "meters tell the truth" pillar.
3. **Quasi-static hybrid**: phasor MNA for the electrical network, solved on topology change and periodically, plus fixed-step discrete, continuous and protection layers.
4. **Depend on an existing GPL engine** (CircuitJS1, SimulIDE). Ruled out by the licence policy ([ADR 0003](0003-licence-policy.md)).

## Decision

**Option 3**, in `libs/domain/sim-core` (framework-free), run in a dedicated **sim worker**:

- **Electrical layer:** real-valued MNA for DC islands; **complex phasor MNA at 60 Hz** for AC islands. One unknown per conductor node (L1, L2, L3, N, PE separate), so unbalance, open neutrals and ground faults emerge. Closed switches merged by union-find before assembly; `gmin` to ground for islands. Dense LU below about 300 unknowns, sparse Gilbert–Peierls LU (CSC + AMD) above, factorisations cached by topology hash. Warm-started outer loop for nonlinear loads. Re-solved on topology change and every 10–20 ms.
- **Discrete layer:** relay/contactor state machines (`OPEN → PICKING → CLOSED → DROPPING`), fixed-point iteration per tick capped at about 20 passes, reporting races and oscillation.
- **Continuous layer:** I²R thermal, Steinmetz induction motor + mechanical ODE, process models (P8).
- **Protection layer:** breaker thermal state plus seeded magnetic band, fuse I²t, overload classes, GFCI residual current.
- **Instruments are stamped devices** (DMM 10 MΩ, LoZ ~3 kΩ, clamp = vector sum of enclosed branches).
- **Loop:** fixed step at **1 kHz sim time**; time control pause/step/1×/10×/60×.
- **Determinism:** integer tick counts, seeded PRNG for all randomness and tolerances; seed + command log reproduces a session byte-for-byte.
- **Transport:** commands into the worker through a ring buffer; state out through double-buffered `SharedArrayBuffer` snapshots with a sequence counter (requires `crossOriginIsolated`, see [electron caveats](../caveats/electron.md)), with a `postMessage` fallback.
- **PLCs** (P10) run one worker each, scanning on sim-clock ticks.
- An optional **scope bench** (post-P11) runs a true transient of a small isolated subcircuit with @spice-ts/core (MIT), never in the main loop.

## Consequences

- No waveforms in the main loop: harmonics, PWM and arc physics are abstracted (realism charter §3.2).
- Budgets become CI gates in P2: a 2,000-node re-solve under 2 ms after a topology change; discrete + continuous + protection under 0.3 ms per tick (`sim-cli bench`).
- Correctness is checked by hand-calculated golden fixtures, fast-check properties (KCL, energy balance) and an **ngspice oracle** (BSD, dev-only).
- Design comes from CircuitJS1's documented approach (reimplemented, never copied), the Modelica Standard Library and OpenDSS (both BSD-3). The MIT sparse LU in spice-ts/brownout may be adapted with attribution in `THIRD_PARTY_NOTICES.md`.
- `sim-core` must stay framework-free so `sim-cli` can run every career job's solver script headlessly in CI.
