# ADR 0012: Oracle tolerance and corpus

**Status:** Proposed (2026-10-30). F2.7. The tolerance is **to be confirmed by measurement when F2.2 part 1 lands** (DC) and part 2 (AC); the corpus, its format and the regeneration rules stand now.
**Date:** 2026-10-30 (Phase 2)
**Owners:** `test-engineer` and `sim-engine-engineer`.
**Sources:** [phase 2 plan](../../plans/phase-2-circuit-engine.md) decision D5, kickoff step 4 (ngspice notes) and F2.7; [ADR 0003](0003-licence-policy.md) (the external-program exception); [ADR 0013](0013-world-document-v2.md) (solution order); [ADR 0007](0007-world-document-v1.md) (sfc32 streams); ngspice 47 user manual (`.options`, `noopac`, `rshunt`, `numdgt`).

## Context

`sim-core`'s solvers (F2.2) need an independent check beyond hand-calculated golden fixtures: many random circuits solved by an established simulator. D5 chose a **checked-in corpus**: seeded random decks and ngspice's results, committed, with `pnpm verify` reading files only. ngspice is a regeneration tool that developers run, never a dependency, so `verify` stays hermetic on Linux, macOS and Windows and the build's licence (numparam and usually KLU are LGPL) never enters the dependency tree (ADR 0003's external-program exception).

## Decision

### One circuit, two emitters

`@controls/sim-core/oracle` (`libs/domain/sim-core/src/oracle/`) holds an intermediate representation, `OracleCircuit`: a node count and a list of elements, each from node `a` to node `b`, current positive from `a` to `b`. Two pure functions emit it:

- `oracleDeck(circuit)`: the SPICE deck text;
- `oracleNetlist(circuit)`: the circuit in F2.1's netlist vocabulary (`NetlistBranch`-shaped branches with sorted `values`), the input the solvers are compared on. `resistor` and `vsource` are F2.1's element kinds; `isource` (F2.2 part 1) and `inductor`/`capacitor` (part 2) are the stamps F2.2 adds. The adapter to the solver's input type is written when that type lands (`TODO(F2.2)`).

Every value is a decimal `mantissa × 10^exponent` (an E12 mantissa), so the deck's text and the netlist's double are the same number.

### The generator

`generateOracleCircuit(domain, seed, index)` draws from `deriveStream(seed, 'oracle:<domain>:<index>')` (sfc32, ADR 0007): no `Math.random`, integer arithmetic only.

- **Size:** 2–30 nodes, node 0 included; both ends of the range occur in the corpus.
- **DC:** resistors, voltage sources with internal resistance, and current sources. **AC (60 Hz):** resistors, inductors, capacitors and phasor voltage sources (with internal resistance) whose angles are 0°, 180° and ±120°, from exact constants (`cos 120° = −0.5`, `sin 120° = √3/2` by `Math.sqrt`, decision D6).
- **Ranges** (numerical test choices, not device data): R 0.10 Ω–82 kΩ; EMF 1.0–820 V; internal R 10 mΩ–8.2 Ω; I 1.0 mA–8.2 A; L 0.10 mH–0.82 H; C 1.0 µF–8.2 mF.
- **Shape:** a random spanning tree first, so every node reaches the reference through finite impedances (resistive in DC), then up to `nodeCount` extra elements, which make loops and parallel elements. Element order and node labels are shuffled.
- **Every circuit is excited.** A tree, or a voltage source on no loop, carries only `gmin` current, which is rounding noise rather than a test (the first corpus had such circuits: their KCL residuals were 1e-4 of their tiny currents). If no current source exists and no voltage source closes a loop, a passive element is added across a source.
- **One island, referenced as sim-core references it.** sim-core takes as an island's reference the negative end of its first voltage source in branch order, otherwise its smallest node, and stamps `gmin` from every node to that reference. The generator relabels nodes so that node is node 0, SPICE's ground. So both simulators stamp `gmin` to the same node and report every voltage against it, and a comparison needs no rebasing. Floating and multi-island circuits are left to the golden fixtures (F2.2's "floating island under `gmin`").

### The deck

- `.options sparse`: Sparse 1.3, so results don't depend on whether the ngspice build links KLU. `regen` refuses results whose run did not report Sparse.
- **`gmin` is stamped explicitly**, as `RG<n> n 0 1/gmin` on each circuit node, with `gmin` = 1e-12 S, matching sim-core's `GMIN_S.value` (until F2.2 part 1 lands the oracle uses a placeholder with a `TODO(F2.2)` naming that import). ngspice's `gmin` option shunts only semiconductor junctions, so it is set (`gmin=1e-12`) only for the record. **Not `.options rshunt=1e12`**, although it was suggested in review: `rshunt` shunts every node of the deck, including its internal ones. Each element's sense node `s<k>` sits at its `a` node's voltage, so a node with m elements would get (m + 1)·`gmin`, and each source's internal node `e<k>` one sim-core doesn't have. Explicit shunts on the circuit nodes only are exactly sim-core's stamp.
- **Branch currents** come from a 0 V sense source `VS<k>` in series with each element, from its `a` end: ngspice 47 reports no complex device currents in AC (`@r1[i]` is real-only), and a sense current is a direct entry of ngspice's solution vector.
- A voltage source is `V<k>` (EMF) in series with `RI<k>` (its internal resistance); an AC one is `DC 0 AC <mag> <deg>`. ngspice computes the phasor with its own `cos`/`sin` of the angle in radians, which differs from the exact constants by about 1e-16 relative: negligible.
- `noopac`: the AC analysis skips the DC operating point, which would be singular for a loop of inductors.
- **Printing:** `set numdgt=17`, so every value prints with 17 significant digits and round-trips to the exact double. Without it ngspice prints 6, which would make a 1e-6 relative target meaningless.

### The corpus

`libs/domain/sim-core/oracle/`: `dc/dc-NNNN.cir` and `ac/ac-NNNN.cir` (one deck per circuit, runnable on its own with `ngspice -b`), and `dc.results.txt` and `ac.results.txt`.

- **Size: 500 DC and 500 AC circuits** (`ORACLE_CORPUS`, seeds 20261030 and 20261031). That is the plan's target; it covers both node-count extremes, every element kind and every phasor angle, and the whole corpus is read and checked in about 0.1 s.
- **Checked-in size:** about 3.1 MB of text (decks 1.6 MB, results 1.5 MB), about 0.9 MB compressed as git stores it.
- **Results format:** a header (`domain`, `ngspice`, `solver`, `options`, `gmin`, `seed`, `count`), then per circuit `circuit <name> <SHA-256 of the deck>`, a `v` row (nodes 1 … n − 1) and an `i` row (branches in order). Values are ngspice's own 17-digit text, `re,im` in AC. `parseOracleResults` returns `re, im` pairs, node 0 first, interleaved like `WorldV2.sim` (ADR 0013).
- **Recorded:** ngspice 47 (`ngspice-47` from its banner), Sparse 1.3, the `.options` line, `gmin` and the seeds.

### Checks in `pnpm verify` (`libs/domain/sim-core/src/oracle/corpus.spec.ts`)

- **Staleness:** regenerating every deck from the pinned seeds reproduces the checked-in decks byte for byte, with no stray files; each result's deck hash matches its checked-in deck; the header matches the pinned seeds, counts, options and `gmin`.
- **Consistency:** ngspice's solution satisfies every element's equation, with values taken from `oracleNetlist`, and KCL with `gmin` at every node. This proves the deck and the netlist describe the same circuit with the same sign conventions, and that the parser puts each value in the right slot, before any solver is compared. Measured worst residual, normalised by the circuit's largest voltage (element equations) or current (KCL): **2.9e-9 (DC), 1.2e-9 (AC)**, all double rounding; the check allows 1e-7, while a wrong sign, slot or value is of order 1.
- **The comparison** (`it.todo` until the solvers exist): sim-core's DC solution of every DC circuit (F2.2 part 1) and its phasor solution of every AC circuit (part 2), within the tolerance below.

### Tolerance (Proposed: to be confirmed by measurement when F2.2 part 1 lands)

Each node voltage and branch current is a phasor `x` (DC has `im = 0`), compared with ngspice's `x_ref` by `compareOracleSolution`:

```
|x − x_ref| ≤ relative · |x_ref| + floor
floor = max(absolute floor, scale · max over the circuit of |x_ref| of the same quantity)
```

| Parameter       | Proposed | Why                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relative`      | 1e-6     | The plan's target. Both solvers do one LU solve of the same linear system in doubles, so agreement should be near 1e-12; 1e-6 leaves room for different pivoting without hiding a wrong stamp. **Never looser than the 0.5 % golden bound** (a spec checks it).                                                                                            |
| `voltageFloorV` | 1 nV     | A node that cancels to zero, or a dead leaf with only `gmin` on it.                                                                                                                                                                                                                                                                                        |
| `currentFloorA` | 1 nA     | Not the 1e-12 A first planned: a branch current in doubles is only good to about ε · V_max · G_max, about 2e-11 A with the generator's 10 mΩ and 820 V extremes (F2.2 part 1 measured 1.4e-11 A for 1 mΩ at 120 V). A decision for `test-engineer`: keep realistic 10 mΩ source resistances and a 1 nA floor, rather than raise every resistance to 0.1 Ω. |
| `scale`         | 1e-9     | Rounding at the circuit's own magnitude, for values near zero in a circuit with large ones.                                                                                                                                                                                                                                                                |

When F2.2 part 1 lands: run the DC comparison, record the worst observed error per parameter here, and tighten or confirm each (never past the golden bound); then mark this ADR Accepted for DC, and again for AC with part 2.

### When to regenerate

`pnpm sim oracle regen` (needs ngspice; [oracle guide](../guides/oracle.md)) rewrites the decks from the generator, runs each through ngspice and rewrites both results files, only once every circuit has solved. Regenerate, and commit decks and results together, when:

- the staleness test fails: the generator, the deck emitter, the seeds, the counts or `gmin` changed;
- a new stamp kind joins the generator (every new stamp extends the corpus; the sim-engine-engineer checklist);
- the pinned ngspice version changes (record it here and in the guide).

Never edit the corpus by hand, and never regenerate to make a failing comparison pass: a disagreement is a solver bug until shown otherwise.

## Consequences

- `pnpm verify` needs no ngspice and no network; the corpus is about 3 MB of text in the repository.
- The generator and the deck emitter are frozen by the corpus: any change, even one that doesn't alter a circuit, needs a regeneration with ngspice installed.
- The comparison can't run until F2.2 provides a solver; until then the consistency check is the corpus's own test.
- `rshunt` stays unused; if sim-core ever stamps `gmin` on internal nodes, revisit.

## Alternatives considered

- **ngspice in `verify`** (a system install, or eecircuit-engine's WASM): rejected in D5 (a CI-only check with no verified Windows install; 43 MB and LGPL KLU).
- **`.options rshunt`** for `gmin`: rejected above (it shunts internal deck nodes).
- **Device currents (`@r1[i]`) instead of sense sources:** real-only in AC.
- **One file of decks per domain:** fewer files, but a single deck could no longer be run on its own; the size saving is small.
