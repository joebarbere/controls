# ADR 0021: Service, grounding and protection physics

**Status:** Part 1 proposed (2026-11-18), P4 PR 9 (engine 8 part 1). Part 2 (breakers v2, the GFCI and AFCI models, the dimmer and the LED driver; the new kinds' persisted keys, finalising [ADR 0019](0019-world-document-v4.md)'s provisional key table) is written in P4 PR 10 and the F4.1 PRs. Drafted by `sim-engine-engineer`; `electrical-realism-reviewer` signs off every value under [Values for the realism review](#values-for-the-realism-review) before the PR merges.
**Date:** 2026-11-18 (Phase 4)
**Implements:** [ADR 0019](0019-world-document-v4.md) "What the netlist compiler reads" (relation contacts, remote earth, the T-equivalent's terminal behaviour, element refs and order, the `CNT` encoding) and its protocol 8 descriptor items; [ADR 0020](0020-catalogue-format-v3.md)'s engine 8 follow-ups (contact branches from fits, host mounts, bus patterns and outlet pins; the `ElementRef.part` length question).
**Sources:** [phase 4 plan](../../plans/phase-4-residential.md) decisions D3, D4, D5, D13, the "Engine 8 part 1" section, the [pre-audit outcome](../../plans/phase-4-residential.md#pre-audit-outcome-2026-11-17) (its vetted values and must-avoid list); [ADR 0011](0011-sim-worker-contract.md) (§7 the descriptor, §12 the version rule); [ADR 0012](0012-oracle-corpus.md) (the oracle corpus); ADR 0014 (reserved: D6, no transcendental maths in sim code); the [simulation caveats](../caveats/simulation.md) (the P2 note that "P4's service entrance must adopt" a T-equivalent).

## Context

P2's split-phase services split the full winding's impedance equally between the two lines, so a bolted line-to-neutral fault at the terminals drew exactly what a line-to-line one does. A real 120/240 V centre-tapped distribution transformer's half winding has less than half the full winding's impedance, so its line-to-neutral fault current is the higher one (about 1.5× in short-circuit guides). That was acceptable while the services were headless with no protective devices; P4's house has breakers whose magnetic pickup depends on it (the bolted-short acceptance), so the simulation caveats made adopting a T-equivalent a P4 obligation.

P4 also makes bonding physical. ADR 0019 decided that the compiler reads three world relations, `mountedOn` (a breaker on a bus stab, a jumper on a load centre, a yoke on a metal box), `pluggedInto` (an appliance's plug in an outlet) and, in a later design, `inEntry`, and that it adds an implicit remote-earth node reached by sourced earth resistances. It left the representation of the T-equivalent and the physics notes to this ADR.

## Decision (part 1)

### 1. The split-phase T-equivalent, as a coupled 2 × 2 source impedance

For a 120/240 V split-phase source of rating S, %Z and X/R, on its own base (V_LL = 2 V_LN, Z_base = V_LL² / S, never a table):

- the full winding Z_full = R + jX, |Z_full| = (%Z / 100) Z_base, R = |Z_full| / √(1 + (X/R)²);
- each line's T arm Z_h = Z_full / 2;
- the half winding's own impedance Z_LN = 1.5 R_pu + j 1.2 X_pu on the 120 V base, which is **0.375 R + j0.3 X of the full winding in ohms** (the base is (V_LN / V_LL)² = 1/4 of the 240 V one, exactly);
- the neutral arm Z_n = Z_LN − Z_h = −0.125 R − j0.2 X, **negative**.

Z_n is never a branch. An internal centre-tap node with a negative neutral element would break the AC solver's singularity argument and the stamps' R > 0, L > 0 validation (ADR 0019 §7). The neutral arm is instead **eliminated into the two windings' source rows**: each winding is a `vsource` from the transformer neutral to its line behind its own Z_h + Z_n = Z_LN, and its row also carries Z_n times the other winding's current:

```text
V_l1 − V_x0 + Z_LN · I_1 + Z_n · I_2 = E_1          (E_1 = 120∠0°)
V_l2 − V_x0 + Z_n · I_1 + Z_LN · I_2 = E_2          (E_2 = 120∠180°)
```

which is exactly the T with its centre node eliminated (the current into the neutral terminal is I_1 + I_2, and it flows through Z_n). Its terminal behaviour is ADR 0019's: a lone line-to-neutral fault sees Z_LN, a line-to-line fault (I_2 = −I_1) sees 2 (Z_LN − Z_n) = Z_full.

- **The solver.** `AcBranchValues.couple(branch, partner, R_m, L_m)` gives a `vsource` row a mutual impedance R_m + jωL_m on its partner's current (either sign). The phasor solver stamps it as one more matrix entry in the source row (value code `VALUE_ZM`), on the dense and the sparse path alike. Every coupled pair is checked at each solve (cold, a few comparisons): the partner is a `vsource` of the same island coupled back with the same values, and the pair's real block [[R_a, R_m], [R_m, R_b]] is **positive definite** (R_a, R_b > 0 and R_a R_b > R_m²). A pairing that fails is a device-model error and throws.
- **The singularity argument holds.** The source block Z is complex symmetric, Z = R + jX with R and X real symmetric, so Re(Iᴴ Z I) = Iᴴ R I > 0 for I ≠ 0 when R is positive definite. For the split-phase block R = [[R_h + R_n, R_n], [R_n, R_h + R_n]], whose eigenvalues are R_h and R_h + 2 R_n = 0.25 R (positive). A coupled pair has R > 0, so it is never part of a loop of ideal sources, and "singular ⇔ a loop of ideal sources" is unchanged (`mna/ac.ts`).
- **The factorisation cache.** A coupled source's row has one more entry, so it has its own pattern class (`CLASS_SOURCE_COUPLED`) in the cache signature: a cached symbolic factorisation is never reused across a coupling change.
- **Every split-phase source** takes it: the P3 stand-in `utility.splitPhase` (the workshop and old saves), the new `service.splitPhase`, and the generator stub (`generator.portable`). The factors are for the 25–100 kVA class of centre-tapped distribution transformers; **on the generator stub they are a labelled abstraction** (its alternator has no centre-tapped winding of that construction).
- **No `topologyHash` moves.** The netlist's elements, kinds and ends are unchanged: the coupling is a value. The constants are `SPLIT_PHASE_HALF_WINDING_R_FACTOR` (1.5) and `SPLIT_PHASE_HALF_WINDING_X_FACTOR` (1.2) in `sim-core` (no catalogue change: ADR 0019 D4).

**Golden** (the pre-audit's, recomputed with complex phasors in `ac-source.spec.ts`): the 25 kVA, 2 %, X/R 2 unit has Z_h = 10.304 + j20.608 mΩ, Z_n = −2.576 − j8.243 mΩ, Z_LN = 7.728 + j12.365 mΩ (|Z_LN| = 14.581 mΩ), so **I_LN = 120 / 0.014581 = 8229.96 A** and **I_LL = 240 / 0.04608 = 5208.33 A**, ratio **1.580**. The engine reproduces both within 1e-5 at a 17 nΩ busbar.

### 2. The service (`service.splitPhase`)

A new model kind: the pole transformer, the service drop and the meter base as one entity (D4). Terminals `l1`, `l2`, `n` (the meter base's load-side lugs) and `x0` (the transformer's neutral bushing at the pole, which an entry declares `access: 'none'`). No state.

- **The transformer** is §1's T-equivalent, its windings from `x0`.
- **The drop** is three conductors of `dropLengthMm`, each R = ρ₀ · L / A · (1 + α (T − T₀)) at the game's 20 °C ambient (`serviceDropOhm`; resistivity × length ÷ area, never a table). Each line conductor's resistance is added to its winding's own R (the same as a series resistor, with no node between); the neutral's is a resistor element `dropN` from `x0` to `n`. **Abstractions:** the drop's reactance is left out (a twisted triplex drop's reactance is small against its resistance at service-drop sizes, so the bolted fault at the meter is slightly overstated; `electrical-realism-reviewer` to confirm the bound, and the house acceptance states the drop it uses), and the drop has no thermal node in P4.
- **The utility's neutral grounding** is an earth link from `x0` (§3) of `utilityGroundingOhm`.
- Its island takes the 120/240 V nominal band, as the stand-in's does.

The content entry (25 kVA, a sourced drop, meter-base lugs) is P4 PR 14's; this PR tests the kind on a test entry.

### 3. Remote earth and ground rods (D5)

- **The earth node** is an implicit one-terminal pseudo-fragment at **entity 0, terminal `earth`**, never in the world, present only when an earth link compiles. Plant terminal 0 is reserved for it, so when it is present it is **node 0** and every other node's index is one higher; with no link the netlist is exactly engine 7's. Readers never look entity 0 up (the netlist panel names it "remote earth"); the engine leaves it out of an island's entity list.
- **Earth links** are declared by a netlist model (`DeviceTopology.earth`: a contact id, the device's terminal, `resistanceOhm`) and compiled as relation contacts of relation `earth` (§4) from that terminal to earth. P4 has two: the service's `grounding` link from `x0` (`utilityGroundingOhm`) and a ground rod's `electrode` link from its acorn clamp.
- **`electrode.groundRod`** is a new model kind: one terminal `clamp`, parameter `earthResistanceOhm`, no state. The rod's resistance is **computed offline** by Dwight's single-rod formula with the radius (IEEE Std 142, cited by number), R = ρ / (2π L) · (ln(4L / a) − 1): an 8 ft × 5/8 in rod at ρ = 100 Ω·m is **39.90 Ω** (with the diameter, the must-avoid, it would be 35.38 Ω). A spec recomputes it with `Math.log`; sim code never evaluates a logarithm (D6). The entry (PR 15) carries the value and the calculation in its source.
- **The utility's grounding resistance is 5 Ω**, game-design inside a sourced 1–25 Ω range (pre-audit), a parameter of the service entry.
- **Earth is not an effective fault path, and the model shows it rather than assuming it.** A line faulted into a separate rod returns through remote earth to the transformer neutral by the utility's grounding in parallel with the service's own rod (through its GEC, the main bonding jumper and the neutral): I = V / (R_rod + R_utility ∥ R_service-rod), **2.704 A** at 39.9 Ω, 5 Ω and 39.9 Ω (the plan's ≈ 2.70 A, Art. 250.4(A)(5) by number), which trips nothing. A fault into the service's own rod returns through the GEC and the bond instead (about 1.6 kA on the test service). Both are goldens in `service.spec.ts`.
- **Caveat (fix before P6, ADR 0019):** an earth or EGC path that joins a DC circuit to an AC island makes the island `mixed` (unsolved). P4 has no such circuit.

### 4. Relation contacts

ADR 0019's rules, as implemented:

- **Mount contacts** (`mountedOn`): for each contact of the device's fit for the host mount's type, by contact id. On a bus mount (`bus` non-null) only `host: 'stab'` contacts count, and the stab is **`busStabIndex(host, mount, position, fit)` plus the contact's `positionOffset`**, its leg **`busStabLeg(mount, stab)`** (world-model's functions, called, never recomputed). On any other mount the host contact must be one the mount offers (`EnclosureMount.contacts`), mapped to its terminal. A side that declares nothing adds nothing and reports nothing (every P3 entry, a DIN rail, a yoke on a nonmetallic box); contact-less fits exit early.
- **Plug contacts** (`pluggedInto`): one per pin of the appliance's plug, by pin id, from the plug pin's terminal to the outlet's slot terminal for that pin, each of the outlet's `contactOhm`. A two-blade 1-15P makes two.
- **Each contact is one resistor branch** of model `contact`, from the dependent device's terminal (end `a`) to the host's (end `b`), valued by its `resistanceOhm` (DC and AC defaults, the resistor-default fast path), **never an ideal join**, so bus, bond and plug currents are in the solution. No thermal node on a contact in P4 (an abstraction; ADR 0019 §9).
- **Absent contacts.** When both sides declare a contact but an end's terminal isn't netlisted (its entity has no netlist model, or lacks the terminal), or a bus contact has no stab, the contact is absent with the diagnostic `absent-contact` (`entity`, `relation`, `contact`), after the connection diagnostics.
- **What moves `topologyHash`:** a contact appearing or leaving (mounting, unmounting, deleting, plugging, unplugging), the earth node's first and last link, and **sliding a breaker to a stab of the other leg** (to a stab of the same leg, the netlist and the hash are unchanged, though the compiler's structure list records the slide). Contact resistances, earth and grounding resistances never do.

### 5. Element refs, order and encoding

- `ElementRef` gains `{ kind: 'contact', entity, relation: 'mount' | 'entry' | 'plug' | 'earth', contact }` (`entity` the dependent entity). This settles ADR 0020's follow-up: the contact id is never squeezed into an entity element's 32-character `part`, so `ContactId` keeps its grammar.
- Branches are entity elements, then connections, then contacts by (entity, relation code, contact id); each entity's contacts are mount, then plug, then earth.
- `topologyHash`: the branch tag **2** (varint entity, **u8 relation code**, str contact id), appended like an element-kind code; relation codes are hashed and append-only, **mount 0, entry 1, plug 2, earth 3**; the earth member encodes as entity 0. **`CNT` stays at version 1**: no world without contacts or an earth node encodes differently. `hash.spec.ts` and `contacts.spec.ts` pin a golden per new kind, per relation and for the earth node, and the byte layout of a contact branch.
- `netlist.dump` names a contact `e<entity>:<relation>.<contact>` (`e7:mount.line1`) and the earth member `0:earth`.

### 6. `wiringGraph`

`wiringGraph(world, catalog)` (exported from `sim-core`, for the inspector, PR 20) compiles the world's **wiring view** with the compiler itself (`NetlistCompilerOptions.view: 'wiring'`): each model's `wiring` topology (a switch closed; a fuse or breaker intact whatever its handle or trip), no sim state, every landed connection present whatever its ends' state, and every relation contact. Two terminals are `joined` when they are in one node or in nodes linked by connections, contacts and the elements of kinds marked `wiringPath` (a protective device's line → load), never through a load or a source. A property ties it to `compileNetlist`: every pair of terminals in one electrical node, and both ends of every connection and contact branch, are joined. Derived, never stored or hashed.

### 7. The oracle corpus

The AC corpus gains coupled pairs (ADR 0012's rule: a new stamp kind extends the corpus). In about half the AC circuits with two or more sources, the first two are coupled with a mutual resistance of either sign one decade below the smaller internal resistance (so the real block is positive definite) and a mutual inductance of either sign in the source-inductance range, drawn from a stream of their own (`oracle:ac:<i>:coupled`), so no other circuit's deck changed. The deck chains each coupled source through a **current-controlled voltage source** (`H`, R_m times the partner's sense current) and a **voltage-controlled source** (`ED`, L_m times the voltage of a 1 H inductor that an `F` source drives with the partner's current, i.e. jω I_p). Regenerated with `pnpm sim oracle regen` (ngspice 47, Sparse 1.3), decks and results together; every circuit agrees within ADR 0012's tolerance with the 10× margin.

### 8. Versions

- **`SIM_ENGINE_VERSION` 8**, provisional until v0.5.0: every split-phase line-to-neutral load moves (the T-equivalent), so every scenario with one is re-pinned once, listed old → new in the CHANGELOG; three-phase services and line-to-line loads don't move numerically. Later P4 PRs that change engine-8 behaviour re-pin in place.
- **`SIM_PROTOCOL_VERSION` 8**, provisional until v0.5.0: this PR brings only the descriptor's part (the `contact` element ref with its relation enum and a 255-character camelCase contact id, entity 0 allowed only as `earth`, and a contact ref as a trace's `branch` target), because a world with a contact can't otherwise cross the worker boundary. The records, the connection degradation fields and the events stay PR 11's, which re-pins the fingerprint in place and writes the ADR 0011 amendment with `renderer-engineer` and `angular-ui-engineer`. Nothing hashed in a snapshot changed with the version.

## Values for the realism review

| Value                                                                                    | Where                                                                          | Source                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Half-winding factors 1.5 (R) and 1.2 (X) per unit on the 120 V base, 25–100 kVA class    | `SPLIT_PHASE_HALF_WINDING_R_FACTOR`, `_X_FACTOR` (`sim-core` constants)        | real-world: published short-circuit calculation guides' point-to-point line-to-neutral multipliers for centre-tapped single-phase transformers (pre-audit 2026-11-17); see the reference notes |
| Applying them to every split-phase source, the generator stub included                   | `ac-source.ts`                                                                 | labelled abstraction (the stub's alternator)                                                                                                                                                   |
| I_LN 8229.96 A, I_LL 5208.33 A, ratio 1.580 at the 25 kVA, 2 %, X/R 2 unit               | `ac-source.spec.ts`, `ac-coupled.spec.ts`                                      | physics derivation (complex phasors) from the stand-in's sourced nameplate                                                                                                                     |
| Utility neutral grounding 5 Ω                                                            | service entry parameter `utilityGroundingOhm` (test entry here; content PR 14) | game-design inside a sourced 1–25 Ω range (pre-audit)                                                                                                                                          |
| Ground rod 39.90 Ω (8 ft × 5/8 in, 100 Ω·m, Dwight with the radius)                      | rod entry parameter `earthResistanceOhm` (test entry here; content PR 15)      | IEEE Std 142 by number, computed offline (`service.spec.ts`)                                                                                                                                   |
| Service drop resistance ρL/A(1 + αΔT) at 20 °C, no reactance, no thermal node            | `serviceDropOhm`                                                               | physics derivation; the reactance omission and the missing thermal node are labelled abstractions                                                                                              |
| Test entries' drop: 30 m, 33.62 / 21.15 mm² aluminium at 2.8264e-8 Ω·m, α 0.00403 /K     | `testing/engine.ts` (test only)                                                | NBS Handbook 100's AWG areas (2 and 4 AWG); 61 % IACS for 1350 alloy; test data, not a product                                                                                                 |
| Contact branches: one resistor per contact, `contactOhm` from the entry, no thermal node | compiler                                                                       | ADR 0019 D3; the values themselves land with the content PRs' entries (a bus stab from makers' watts-loss data, ADR 0019 D3; the test entries use 2–5 mΩ, test data)                           |

## Deviations from the plan and ADR 0019

1. **Protocol 8 starts in this PR** (ADR 0019's version table put it at PR 11). The descriptor must carry contact refs and the earth member as soon as the compiler makes them, or a world holding one fails the worker's descriptor parse. Only the descriptor's agreed shape lands here (ADR 0019 "Protocol 8": `ElementRef` gains `contact`, `TerminalRefSchema` allows entity 0 only with `earth`, a probe or trace target accepts a contact ref); PR 11 completes it in place. **For review by `renderer-engineer` and `angular-ui-engineer`** with the ADR 0011 amendment in PR 11.
2. **The service has a fourth terminal, `x0`** (the transformer's neutral bushing), so the utility's grounding sits where it does physically, before the drop neutral. Without it, the earth link would have to sit on the meter base's `n` and skip the drop neutral. `x0` is `access: 'none'` in content.
3. **The oracle deck uses controlled sources** (`H`, `ED` over an `F`-driven inductor), not "the T with negative R and L … else K-coupled inductors" (ADR 0019 §7): the corpus couples any two sources, not only two sharing a neutral, and a `K` coupling needs |L_m| ≤ √(L_a L_b). The controlled sources state R_m + jωL_m exactly, of either sign.
4. **The plan's "`inEntry` bonds" bullet** stays out (ADR 0019 deviation 7: conduit bonding is deferred past P4); the `entry` relation code is reserved.
5. **The lamp's `burnedOut` and `overvoltageSinceTick`** are still carried through unchanged (ADR 0019 PR 7 note 6 said engine 8 sets them). Setting them needs the `lampBurnout` and `overvoltage` events (protocol 8's events, PR 11) and the overvoltage dwell constant (F4.4); they move to the lamp work in F4.1 part 1 or F4.4 with those events. Engine 8 keeps the `overvoltageSinceTick` exemption in `scripting-api`'s `save.spec.ts` deliberately.
6. **The non-allocating numeric structure code** for topology keys (ADR 0019 "Sim and commanded state keys") is not in this PR: no engine-8 part 1 kind has a sim topology key, so it changes nothing measurable yet; it lands with the first P4 kinds that have them (PR 10's breakers and GFCIs), measured against `intermittent-toggle-wired` there.

## Consequences

- `sim-core`: `netlist/` (contact refs, the earth node, `wiringGraph`, the encoding's tag 2, `absent-contact`), `mna/ac.ts` and `ac-values.ts` (coupled sources), `devices/sources/` (the T-equivalent, `service.splitPhase`, `electrode.groundRod`), the oracle (coupled pairs), `testing/residential.ts` (test-only residential kinds and entries), `SIM_ENGINE_VERSION` 8.
- `catalog`: two model kinds (`service.splitPhase`, `electrode.groundRod`) with their parameter schemas and `device-state.*.schema.json`; no catalogue format change.
- `sim-protocol`: the descriptor's contact refs and earth member, the watch target, `SIM_PROTOCOL_VERSION` 8 (provisional).
- `features/workspace`: the netlist panel names contacts and remote earth.
- Saves: every `-engine-7-catalog-3` fixture is replaced by an `-engine-8-catalog-3` one; the frozen `-engine-7-catalog-2` and `-engine-6-catalog-2` saves load as `engine-changed`.

## Reference notes

Kept out of content `source` strings, which never name makers. The half-winding multipliers (1.5 R, 1.2 X) are the point-to-point short-circuit method's line-to-neutral factors for centre-tapped single-phase transformers, as published in makers' short-circuit calculation guides and vetted by the pre-audit (2026-11-17), which holds the specific references; this ADR adds none of its own. Dwight's formula is the one IEEE Std 142 gives for a single driven rod (cited by number). The 1–25 Ω range for the utility's neutral grounding is the pre-audit's; 5 Ω inside it is a game-design choice.
