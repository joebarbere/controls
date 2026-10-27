> Research snapshot gathered 2026-10-26 by a planning sub-agent for controls-development-plan.md. Versions, licences and figures were verified on that date; re-verify before relying on them.

# Open-source circuit simulators for a real-time electrician / industrial-automation game (research as of 2026-10-26)

**Bottom line:** No existing package is the right engine to depend on. Build your own MIT-licensed TypeScript solver in a Web Worker, borrowing CircuitJS1's solver design (reimplemented, not copied) and the Modelica, OpenDSS and pandapower motor and protection equations. Keep SPICE (spice-ts or eecircuit-engine) for an optional "scope bench" mode. I got the licences and activity dates from the GitHub and npm APIs today, and confirmed the solver details from READMEs and docs.

## 1. Project survey

| Project                                                                                                                               | Language                                                                                                                                         | Licence                                                             | Status                                      | Usable from TS?                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Falstad CircuitJS1** ([pfalstad/circuitjs1](https://github.com/pfalstad/circuitjs1))                                                | **Now TypeScript + Vite** (moved off Java/GWT). The older [sharpie7 fork](https://github.com/sharpie7/circuitjs1) is Java/GWT, last push 2024-01 | **GPL-2.0**                                                         | Very active (pushed 2025-10-25, 2.4k stars) | Source only. GPL means reference only for a closed or MIT game                                                                                                                                |
| **ngspice** ([site](https://ngspice.sourceforge.io/))                                                                                 | C                                                                                                                                                | Modified BSD; XSPICE is public domain                               | Active, ngspice-47                          | Through WASM, below                                                                                                                                                                           |
| **eecircuit-engine** ([GitHub](https://github.com/eelab-dev/EEcircuit-engine), [npm](https://www.npmjs.com/package/eecircuit-engine)) | TS wrapper around ngspice WASM                                                                                                                   | MIT wrapper + BSD ngspice. Check whether the build links KLU (LGPL) | Very active (v1.9.0, 2025-10-25)            | Yes, npm, but about 43 MB and batch-only: `setNetList` / `runSim`                                                                                                                             |
| **@spice-ts/core** ([GitHub](https://github.com/mfiumara/spice-ts))                                                                   | Pure TypeScript                                                                                                                                  | MIT                                                                 | Young (v0.4.0, 28 stars)                    | Yes. DC/AC/transient, NR with voltage limiting, Gilbert-Peierls sparse LU, complex sparse LU for AC, adaptive BE/trapezoidal                                                                  |
| **brownout** ([GitHub](https://github.com/devkapa/brownout))                                                                          | Pure TypeScript                                                                                                                                  | MIT                                                                 | Very young (v0.6.5, 0 stars)                | Yes. Sparse MNA with AMD + Gilbert-Peierls, host-driven `step(h)`, 90 device kinds incl. electromechanics. Good to read; risky to depend on                                                   |
| **SimulIDE** ([site](https://simulide.com/))                                                                                          | C++/Qt                                                                                                                                           | **AGPLv3** on the homepage (Debian says GPL-3)                      | Active, 1.1.x                               | Reference only. A real-time, low-CPU design worth studying                                                                                                                                    |
| **Qucs-S** ([GitHub](https://github.com/ra3xdh/qucs_s))                                                                               | C++                                                                                                                                              | GPL-2.0                                                             | Active                                      | Reference only. It is a GUI front end for ngspice/Xyce, so little solver value                                                                                                                |
| **Xyce** ([Sandia](https://xyce.sandia.gov/downloads/source-code/))                                                                   | C++                                                                                                                                              | GPL-3.0                                                             | Active, 7.10                                | Reference only. Good literature on parallel and homotopy methods, overkill for a game                                                                                                         |
| **Logisim-evolution** ([GitHub](https://github.com/logisim-evolution/logisim-evolution))                                              | Java                                                                                                                                             | GPL-3.0                                                             | Very active                                 | Reference for event-driven digital propagation                                                                                                                                                |
| **CircuitVerse** ([GitHub](https://github.com/CircuitVerse/CircuitVerse))                                                             | JS / Ruby                                                                                                                                        | **MIT**                                                             | Very active                                 | Its event-queue digital simulator can be borrowed directly                                                                                                                                    |
| **digitaljs** ([npm](https://www.npmjs.com/package/digitaljs))                                                                        | JS                                                                                                                                               | BSD-2                                                               | Maintained (2026-02)                        | Usable, for 3-valued logic                                                                                                                                                                    |
| **OpenModelica** ([GitHub](https://github.com/OpenModelica/OpenModelica))                                                             | C++ / Modelica                                                                                                                                   | OSMC-PL (GPL-3 based)                                               | Active                                      | Tool is reference only                                                                                                                                                                        |
| **Modelica Standard Library** ([GitHub](https://github.com/modelica/ModelicaStandardLibrary))                                         | Modelica                                                                                                                                         | **BSD-3**                                                           | Active                                      | Port its equations freely. `Electrical.Machines` has DC, induction (space-phasor) and synchronous machines plus transformers; `QuasiStatic.*` has phasor versions; `Polyphase` covers 3-phase |
| **pandapower** ([GitHub](https://github.com/e2nIEE/pandapower))                                                                       | Python                                                                                                                                           | BSD-3                                                               | Very active                                 | Reference for NR load flow, IEC 60909 short-circuit calculation, and line/transformer/motor element models                                                                                    |
| **OpenDSS / dss_capi** ([GitHub](https://github.com/dss-extensions/dss_capi))                                                         | Pascal / C API                                                                                                                                   | BSD-3                                                               | Active                                      | Best reference for an unbalanced 3-phase phasor solver with fuse, relay and recloser trip curves (TCCs)                                                                                       |
| **PyPSA** ([GitHub](https://github.com/PyPSA/PyPSA))                                                                                  | Python                                                                                                                                           | MIT                                                                 | Active                                      | Load-flow reference                                                                                                                                                                           |
| **OpenPLC v3** ([GitHub](https://github.com/thiagoralves/OpenPLC_v3))                                                                 | C++                                                                                                                                              | GPL-3.0                                                             | **Archived**                                | Reference for the IEC 61131 PLC scan cycle                                                                                                                                                    |
| **klu-js** ([npm](https://www.npmjs.com/package/klu-js))                                                                              | WASM                                                                                                                                             | LGPL-2.1                                                            | v0.1.0                                      | Usable as a separate dynamically loaded module if you need sparse LU                                                                                                                          |

**Copyleft:** CircuitJS1, SimulIDE (AGPL), Xyce, Logisim, Qucs-S, OpenPLC and OpenModelica are reference only. Algorithms such as MNA, companion models and Newton-Raphson are not copyrightable, but code is. Don't paste or translate their code. Reimplement from the papers and docs (CircuitJS1's `INTERNALS.md` is a good description of the design). Safe to copy or depend on: MSL (BSD), pandapower (BSD), OpenDSS (BSD), ngspice (BSD), CircuitVerse (MIT), spice-ts, brownout and eecircuit-engine (MIT).

## 2. What's worth borrowing

- **CircuitJS1 solver design**, the best fit for a game:
  - MNA with ground eliminated; wires merged into shared nodes rather than modelled as 0 V sources.
  - Floating nodes tied to ground through a large resistor; trivial rows simplified away.
  - **LU factored once for linear circuits, so each step only does a back-substitution**; a full re-factor only when something nonlinear is present.
  - Capacitors and inductors as Norton companions (conductance G plus a history current source). Backward Euler by default, trapezoidal optional (it rings after switching events).
  - Newton-Raphson with per-iteration voltage limiting for exponential devices.
- **spice-ts / brownout:** sparse LU in TS with a symbolic/numeric split (Gilbert-Peierls), plus brownout's step-acceptance rules: Newton converged, matrix non-singular, values finite, residual ≤ 1e-8.
- **MSL `Machines` / `QuasiStatic`:** the induction-machine equivalent circuit, the slip/torque relation, saturation-free transformer models, and Y/Δ connectors.
- **OpenDSS:** per-phase nodal admittance (Y) matrix with explicit neutral and ground conductors, plus fuse and relay elements that integrate TCCs between solves.
- **pandapower:** IEC 60909 fault-current methodology and the "constant power / current / impedance" (ZIP) load models.
- **Logisim / CircuitVerse:** an event wheel (priority queue keyed by time) with propagation delays and oscillation detection.

## 3. Recommendation: a three-layer hybrid

**Don't run SPICE-style transient simulation of the 60 Hz power system.** A 60 Hz waveform needs time steps of about 50 µs, which is around 330 solves per 16 ms frame on a 500–2000-node plant. Mixed with contactor chatter, the step size would also keep changing. Use a **quasi-static phasor power solver**, a **discrete control solver**, and **ODE integrators for slow state** (heat, motor speed, timers).

### Layer A: control solver (24 VDC, 120 VAC control, relays, PLC I/O)

Run it every tick, 1 kHz fixed step inside the worker.

- **Data structure:** for each control circuit, a graph with conductors as edges and terminals as vertices. Each tick:
  1. Build a **union-find** over closed contacts, wires and fuses.
  2. A coil is energised when its terminal A shares a set with source L/+ and terminal B shares a set with N/0V, with no short in between.
  3. A short is detected when L and N end up in the same set.
- This is O(E·α) and needs no matrix solve. Run a real MNA solve on a control circuit only when you need undervoltage (long runs, overloaded transformer) or LED and lamp brightness. Those circuits are tiny, so a dense solve is fine.
- **Relays and contactors:**
  - States `OPEN → PICKING(t) → CLOSED → DROPPING(t)`, with pick-up around 15 ms, drop-out around 10 ms, and pickup ≥ 85 % / dropout ≤ 60 % of rated voltage.
  - Mechanically linked contacts flip together. Add optional bounce events.
  - Iterate until stable, capped at about 20 passes; if it still hasn't settled, flag a race or oscillation (borrowed from Logisim).
- **PLC:** an IEC-style scan cycle:
  1. Latch the input image.
  2. Run the ladder or ST program.
  3. Write the output image every scan period (e.g. 10 ms).

  Use an event queue for TON/TOF timers.

### Layer B: power solver, complex MNA in phasor form at 60 Hz

**Unknowns:** one complex node voltage per **conductor**, not per bus: L1, L2, L3, N and PE/ground are all separate nodes. This gives unbalance, single-phasing, open neutrals and ground faults for free, instead of a balanced per-phase equivalent.

**Stamps:**

| Element             | Stamp                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire                | `Z = (R′ + jX′)·length` from the NEC Ch. 9 Table 8/9 values (e.g. Cu 14 AWG 3.07 Ω/kft, 12 AWG 1.93 Ω/kft, 10 AWG 1.21 Ω/kft, X ≈ 0.05 Ω/kft), with a temperature correction on R |
| Utility service     | Thevenin source behind `Z_src` (sets the available fault current)                                                                                                                 |
| Transformer         | Ideal transformer stamp + leakage Z + magnetising branch. Δ/Y windings stamped per winding                                                                                        |
| Neutral/ground bond | Main bonding jumper as a 1 mΩ branch at the service                                                                                                                               |
| Earth               | Through `R_earth` (≈ 25 Ω)                                                                                                                                                        |

**Switches, contactors and breakers:**

- Closed: merge nodes with union-find before assembling the matrix, so there are no 1e-6 Ω entries ruining conditioning. Open: drop the branch.
- Add `gmin` (≈ 1e-9 S) from every node to ground so islanded sections aren't singular; islanded sections then read 0 V.

**Loads (ZIP model):** constant-impedance loads stamp directly. Constant-power loads (VFDs, SMPS) need an outer fixed-point / NR loop, `Y = conj(S)/|V|²`. Usually 3–5 iterations, warm-started from the last frame.

**Induction motor:** the Steinmetz per-phase equivalent circuit (R1, X1, Xm, R2/s, X2) stamped per phase, Y or Δ. Slip comes from the mechanical ODE `J·dω/dt = Te(s, V) − T_load(ω)`, integrated at 1 kHz.

- **Inrush emerges on its own:** at s = 1, current is about 6× full-load amps (FLA).
- Single-phasing and voltage drop also emerge, as do stalls: Te ∝ V², so a sag stalls the motor and the current rises.
- Optionally add a decaying first-cycle DC-offset multiplier for magnetic-trip realism.

**Solve cadence:**

- Re-factor only when the topology changes, on an event: a contactor flips, a breaker trips, the player edits wiring.
- Otherwise refresh the right-hand side and nonlinear loads at 50–100 Hz.
- Cache the symbolic factorisation per topology hash.
- Below about 300 complex unknowns a dense LU on interleaved `Float64Array`s is fine. Above that, use a Gilbert-Peierls sparse LU in CSC format with AMD ordering (as in spice-ts and brownout), or klu-js.

### Layer C: protection and thermal integrators (1 kHz, per pole)

Each frame, read |I| per phase from Layer B.

- **Thermal-magnetic breaker:**
  - Thermal state `dθ/dt = ((I/In)² − θ)/τ`; trip at θ ≥ 1.
  - Tune τ and the curve to UL 489 / IEC 60898 (for example, 1.13 In must not trip, 1.45 In trips within 1 h).
  - Instantaneous magnetic trip at B 3–5 In, C 5–10 In, D 10–20 In (randomise within the band per device). Unlatching takes about 8–16 ms.
- **Fuse:** a log-log interpolated melting curve, `log t = f(log I)`, from a manufacturer-style table. Accumulate `∫I²dt` against melting I²t. Fast-acting vs time-delay is just a different table.
- **Overload relay:**
  - Class 10/20/30, meaning it trips within 10/20/30 s at 7.2× FLA.
  - Same θ model, with thermal memory and cooldown.
  - Phase-loss sensitivity: trip faster when the phase currents are unbalanced.
- **GFCI / ground-fault:**
  - Residual current `|ΣI_phase + I_N| > 5 mA` → trip in under 25 ms.
  - Equipment-ground-fault relay at a set threshold.
- **Faults:**
  - Bolted short: a branch of about 1 mΩ.
  - Arcing fault: 0.5–2 Ω, nonlinear.
  - Ground fault: a phase-to-PE branch; when PE is properly bonded, enough current flows to trip the breaker.
  - Open ground: the chassis floats to line voltage, which is a shock hazard for the player.

  All of these are just stamps. The resulting currents drive Layer C, and a trip mutates Layer B's topology.

- **Wire heating:** `I²R` integrated against the conductor's thermal mass, compared with NEC 310.16 ampacity, producing insulation-damage events.

### Optional Layer D: "scope bench"

For instruction minigames (rectifiers, RC timing, VFD waveforms), run a true transient sim on a small isolated subcircuit with **@spice-ts/core** (MIT, pure TS) or **eecircuit-engine** (ngspice). Don't use it in the main loop.

### Worker architecture

```
UI thread (Angular/Three.js, 60 fps)
   │  postMessage: edit ops (addWire, toggle, setFault)  → command ring buffer
   ▼
SimWorker: fixed-step accumulator (1 ms)
   ├─ Control (union-find + event queue)   every tick
   ├─ Protection/thermal/mech ODEs         every tick
   └─ Phasor MNA                           on topology change / every 10–20 ms
   │  results → SharedArrayBuffer (Float64Array: node |V|∠θ, branch I, device states)
   ▼  UI reads latest snapshot (double-buffered with a seq counter); no per-frame messaging
```

- **Storage:** components in struct-of-arrays layout, integer node IDs, and a topology hash as the cache key for factorisations.
- **SharedArrayBuffer:** in Electron, enable cross-origin isolation (COOP/COEP headers) for it to work.
- **Determinism:** a seeded RNG for curve tolerances gives replayable fault scenarios.

### Reading order

1. CircuitJS1 `INTERNALS.md` (concepts only).
2. MSL `Electrical.Machines.BasicMachines.AsynchronousInductionMachines` and `QuasiStatic` (equations).
3. OpenDSS's Fuse/Relay/TCC_Curve docs.
4. pandapower's short-circuit docs.
5. The spice-ts / brownout sparse LU source (MIT, can be lifted).

Sources: [CircuitJS1](https://github.com/pfalstad/circuitjs1), [CircuitJS1 INTERNALS](https://github.com/pfalstad/circuitjs1/blob/master/INTERNALS.md), [EEcircuit-engine](https://github.com/eelab-dev/EEcircuit-engine), [ngspice download](https://ngspice.sourceforge.io/download.html), [ngspice FAQ (licence)](https://ngspice.sourceforge.io/faq.html), [spice-ts](https://github.com/mfiumara/spice-ts), [brownout](https://github.com/devkapa/brownout), [SimulIDE](https://simulide.com/), [Xyce source](https://xyce.sandia.gov/downloads/source-code/), [Qucs-S](https://github.com/ra3xdh/qucs_s), [Logisim-evolution](https://github.com/logisim-evolution/logisim-evolution), [CircuitVerse](https://github.com/CircuitVerse/CircuitVerse), [digitaljs](https://github.com/tilk/digitaljs), [OpenModelica](https://github.com/OpenModelica/OpenModelica), [Modelica Standard Library](https://github.com/modelica/ModelicaStandardLibrary), [pandapower](https://github.com/e2nIEE/pandapower), [dss_capi/OpenDSS](https://github.com/dss-extensions/dss_capi), [PyPSA](https://github.com/PyPSA/PyPSA), [OpenPLC v3](https://github.com/thiagoralves/OpenPLC_v3), [klu-js](https://www.npmjs.com/package/klu-js).
