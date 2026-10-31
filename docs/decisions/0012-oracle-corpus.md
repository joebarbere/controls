# ADR 0012: Oracle tolerance and corpus

**Status:** Proposed (2026-10-30). F2.7. The tolerance is **to be confirmed by measurement when F2.2 part 1 lands** (DC) and part 2 (AC); the corpus, its format and the regeneration rules stand now.
**Date:** 2026-10-30 (Phase 2)
**Owners:** `test-engineer` and `sim-engine-engineer`.
**Review:** `test-engineer` approved (2026-10-30) with changes, applied in #47: biconnected circuits, the tolerance floor, `ngspice -n`, an atomic regeneration, and the solver-adapter decision below.
**Sources:** [phase 2 plan](../../plans/phase-2-circuit-engine.md) decision D5, kickoff step 4 (ngspice notes) and F2.7; [ADR 0003](0003-licence-policy.md) (the external-program exception); [ADR 0013](0013-world-document-v2.md) (solution order); [ADR 0007](0007-world-document-v1.md) (sfc32 streams); ngspice 47 user manual (`.options`, `noopac`, `rshunt`, `numdgt`).

## Context

`sim-core`'s solvers (F2.2) need an independent check beyond hand-calculated golden fixtures: many random circuits solved by an established simulator. D5 chose a **checked-in corpus**: seeded random decks and ngspice's results, committed, with `pnpm verify` reading files only. ngspice is a regeneration tool that developers run, never a dependency, so `verify` stays hermetic on Linux, macOS and Windows and the build's licence (numparam and usually KLU are LGPL) never enters the dependency tree (ADR 0003's external-program exception).

## Decision

### One circuit, two emitters

`@controls/sim-core/oracle` (`libs/domain/sim-core/src/oracle/`) holds an intermediate representation, `OracleCircuit`: a node count and a list of elements, each from node `a` to node `b`, current positive from `a` to `b`. Two pure functions emit it:

- `oracleDeck(circuit)`: the SPICE deck text;
- `oracleNetlist(circuit)`: the circuit in F2.1's netlist vocabulary (`NetlistBranch`-shaped branches with sorted `values`), the input the solvers are compared on. `resistor` and `vsource` are F2.1's element kinds; `isource` and `inductor`/`capacitor` are oracle kinds.

**The solver adapter (decided; written after #46 lands, `TODO(F2.2)` in `netlist.ts`).** F2.1's `ElementKind` is **not widened**. The adapter maps the oracle netlist onto F2.2's real input, a `Netlist` plus its `DcBranchValues`:

- `resistor` and `vsource` map to themselves;
- an `isource` maps to a `resistor` element carrying the `DC_STAMP_ISOURCE` stamp, so `islandReferenceNode` (which looks at `vsource` ends) can never pick a current source's end as the reference;
- `inductor` and `capacitor` follow F2.2 part 2's AC branch values.

With the adapter, the corpus spec runs the element-equation and KCL residuals on the adapted `Netlist` and `DcBranchValues` (not only on `oracleNetlist`), and asserts `islandReferenceNode(...) === 0` for every circuit, which pins the reference-node agreement below.

Every value is a decimal `mantissa × 10^exponent` (an E12 mantissa), so the deck's text and the netlist's double are the same number.

### The generator

`generateOracleCircuit(domain, seed, index)` draws from `deriveStream(seed, 'oracle:<domain>:<index>')` (sfc32, ADR 0007): no `Math.random`, integer arithmetic only.

- **Size:** 2–30 nodes, node 0 included; both ends of the range occur in the corpus.
- **DC:** resistors, voltage sources with internal resistance, and current sources. **AC (60 Hz):** resistors, inductors, capacitors and phasor voltage sources (with internal resistance) whose angles are 0°, 180° and ±120°, from exact constants (`cos 120° = −0.5`, `sin 120° = √3/2` by `Math.sqrt`, decision D6).
- **Ranges** (numerical test choices, not device data): R 0.10 Ω–82 kΩ; EMF 1.0–820 V; internal R 10 mΩ–8.2 Ω; I 1.0 mA–8.2 A; L 0.10 mH–0.82 H; C 1.0 µF–8.2 mF.
- **Ranges stop at 0.1 Ω (10 mΩ inside a source).** Smaller resistances belong to F2.2's property tests (#46), not the oracle: at 1e-4 Ω ngspice itself misses the exact answer, so it is no longer a reference.
- **Shape:** a random spanning tree first, so every node reaches the reference through finite impedances (resistive in DC), then up to `nodeCount` extra elements, which make loops and parallel elements, and at least one source.
- **Biconnected, current sources ignored.** While some node is an articulation point (Tarjan's lowpoint search), an element joins random nodes of two of the pieces it separates. In a biconnected circuit any two elements lie on a common loop, so every element shares a loop with a source and, for random values, carries real current. The first corpus used the bare tree: about 20 % of its branches (2,278 of 11,254 DC, 2,437 of 11,886 AC) were dead ends carrying only `gmin` current, which tests nothing. Now 98.7 % (DC) and 99.0 % (AC) of branches carry more than 1e-6 of their circuit's largest current, and only 10 (DC) and 21 (AC) carry `gmin`-scale current (under 1e-8 of the largest, or 1 nA). A corpus check requires at least 95 %.
- Element order and node labels are shuffled.
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
- **Checked-in size:** about 3.4 MB of text (decks 1.8 MB, results 1.6 MB; 13,147 DC and 13,442 AC branches), about 1.0 MB compressed in the repository.
- **Results format:** a header (`domain`, `ngspice`, `solver`, `options`, `gmin`, `seed`, `count`), then per circuit `circuit <name> <SHA-256 of the deck>`, a `v` row (nodes 1 … n − 1) and an `i` row (branches in order). Values are ngspice's own 17-digit text, `re,im` in AC. `parseOracleResults` returns `re, im` pairs, node 0 first, interleaved like `WorldV2.sim` (ADR 0013).
- **Recorded:** ngspice 47 (`ngspice-47` from its banner), Sparse 1.3, the `.options` line, `gmin` and the seeds.
- **Regeneration host** (this corpus): Fedora 44, Linux 7.2 x86_64, the distribution's ngspice 47 (built with KLU, which the decks don't use: Sparse 1.3), AMD Ryzen 5 5600X. Another ngspice build, compiler or OS can change the last printed digits. That is not a failure: the tolerance is far above it, and regenerating elsewhere only shows up as a diff in the results files.

### Checks in `pnpm verify` (`libs/domain/sim-core/src/oracle/corpus.spec.ts`)

- **Staleness:** regenerating every deck from the pinned seeds reproduces the checked-in decks byte for byte, with no stray files; each result's deck hash matches its checked-in deck; the header matches the pinned seeds, counts, options and `gmin`.
- **Consistency:** ngspice's solution satisfies every element's equation, with values taken from `oracleNetlist`, and KCL with `gmin` at every node. This proves the deck and the netlist describe the same circuit with the same sign conventions, and that the parser puts each value in the right slot, before any solver is compared. Residuals are normalised by the circuit's largest voltage (element equations) or current (KCL), with `gmin` taken from the netlist (`netlist.gminS`), so a wrong `gmin` in `oracleNetlist` fails. Measured worst on the first corpus: 2.9e-9 (DC), 1.2e-9 (AC), all rounding; the check allows 1e-7, while a wrong sign, slot or value is of order 1.
- **Live branches:** at least 95 % of branches carry more than 1e-6 of their circuit's largest current.
- **The comparison** (`it.todo` until the solvers exist): sim-core's DC solution of every DC circuit (F2.2 part 1) and its phasor solution of every AC circuit (part 2), within the tolerance below.

### Tolerance (Proposed: to be confirmed by measurement when F2.2 part 1 lands)

Each node voltage and branch current is a phasor `x` (DC has `im = 0`), compared with ngspice's `x_ref` by `compareOracleSolution`:

```
|x − x_ref| ≤ 1e-6 · |x_ref| + max(1e-12, 1e-7 · max over the circuit of |x_ref|)
```

for volts and amps alike (each against the maximum of the same quantity: voltages against voltages, currents against currents).

| Parameter                        | Proposed | Why                                                                                                                                                                                                                                             |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relative`                       | 1e-6     | The plan's target. **Never looser than the 0.5 % golden bound** (a spec checks it).                                                                                                                                                             |
| `scale`                          | 1e-7     | The reference is noisy. Against exact rational solutions of the same decks, ngspice's own error reached 2.95e-9 of the circuit's largest value on the first corpus, so a 1e-9 scale floor sat below ngspice's noise. 1e-7 is about 30 times it. |
| `voltageFloorV`, `currentFloorA` | 1e-12    | Only for circuits whose values are all tiny; the scale floor governs everything else.                                                                                                                                                           |

**Two floors, two roles.** This floor bounds sim-core's disagreement with a reference that carries about 3e-9 of its own noise. #46's floor policy (F2.2 part 1) bounds sim-core's _own_ residuals (KCL, power balance) in its property tests. They are different checks, and neither replaces the other.

**Values, on a well-conditioned corpus** (decided by `test-engineer`, 2026-10-30). The comparison checks sim-core's node voltages and branch currents against ngspice's **values** only, on a corpus kept well conditioned: the 0.1 Ω and 10 mΩ minimum resistances, and no near-ideal voltage-source loops. sim-core's own residual checks (KCL and the source rows) run alongside it on sim-core's solution, because a residual check against ngspice's rounded numbers isn't meaningful.

**Measured margin** (the test-engineer review's tools: exact rational solutions, and a float64 MNA solver with partial pivoting emulating sim-core, run on the regenerated corpus): the emulated solver against ngspice stays at **1.1e-3 of the allowance or less** (DC: 1.06e-3 for voltages, 4.7e-4 for currents; AC: 1.8e-5 and 5.0e-4). ngspice against the exact solution is at the same level. On the first corpus the review measured up to 0.03 of the allowance.

When F2.2 part 1 lands: run the DC comparison, record the worst observed error per parameter here, and tighten or confirm each (never past the golden bound); then mark this ADR Accepted for DC, and again for AC with part 2.

### When to regenerate

`pnpm sim oracle regen` (needs ngspice; [oracle guide](../guides/oracle.md)) regenerates the decks, runs each through `ngspice -n -b` (`-n`: no `.spiceinit` from the working directory or HOME, which silently changed results), and writes everything into a staging directory inside the corpus directory. Only once every circuit has solved are `dc/`, `ac/` and the results files renamed into place. The first failure stops new ngspice runs, each run has a timeout, and a failed regeneration leaves the corpus untouched. Regenerate, and commit decks and results together, when:

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
- **Closing only the tree's dead-end nodes** (rather than biconnecting): it leaves loops hanging from a single node, which carry no current either.
- **Widening F2.1's `ElementKind`** with `isource`, `inductor` and `capacitor`: rejected in review; the adapter maps them instead (above).
