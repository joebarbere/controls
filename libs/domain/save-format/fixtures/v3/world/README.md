# World v3 fixtures

Loaded by `fixtures.spec.ts` (every `*.json` here must migrate and validate, and load unchanged) and by `world-model`'s `devices.spec.ts` (each passes the load check against the built-in catalogue). `schemaVersion` 3 is provisional until v0.4.0: these may change with it, in the same PR; after that they are frozen.

- `empty.json`: `createWorld({ seed: 0 })`.
- `leads-only.json`: v2's `devices-sim-null.json` as v3 holds it (a battery, a switch and a lamp, three test leads with the lead kind's initial sim bag).
- `routed-wire-hot-terminations.json`: one conductor from the split-phase stand-in's L1 screw to a breaker's line screw, through a duct and stapled to the workshop's stud wall, 125 s into a run: end a under-torqued, nicked, part-way through degrading and intermittent; end b made by `'auto'`; 17-digit temperatures.
- `cable-one-unlanded.json`: a 14/2-with-ground cable from a free end into a box's open knockout, black on L1 and white on N, the bare EGC unlanded at both ends.
- `mounted-devices.json`: a breaker and the DIN supply mounted on a panel's rail, labelled; a second breaker stands free (`mountedOn: null`).
- `float-edges.json`: numbers JSON must carry exactly (17 significant digits, a subnormal, the largest double, a 2⁴⁰ tick) in the solution record, the bags and a termination; a spring-cage termination with a ferrule; a conductor cut to the 1 km maximum with a free end.

**The conductor, cable, box, panel, duct, ferrule and terminal-block refs are fixture-only** (`*.fixture-*`): no such catalogue entries exist yet, so the load check leaves them alone (unknown refs round-trip untouched). The real ones arrive with F3.1, F3.3 and F3.5. Device refs (the utility stand-in, the breaker, the DIN supply, the battery, the lamp, the switch, the test lead) are real catalogue 2 entries, so their bags, terminals and termination methods are checked.

`../refused/world/` holds one document per schema invariant that the loader must refuse, each listed with its message in `fixtures.spec.ts` (`REFUSED_V3`). `../ctrl/` holds this build's engine-6/catalogue-2 scenario saves (rebuilt from their scenarios by `apps/sim-cli/src/sources.spec.ts`), `checkpoint-engine-6-catalog-2.ctrl` (a log rebased onto the checkpoint at 20 000 ticks) and `wired-world-only.ctrl` (`cable-one-unlanded.json` with no log).
