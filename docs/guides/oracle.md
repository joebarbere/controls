# Oracle guide: the ngspice corpus

`sim-core`'s solvers are checked against **ngspice** on a corpus of random circuits: 500 DC and 500 AC decks with ngspice's results, checked in under `libs/domain/sim-core/oracle/`. `pnpm verify` only reads those files, so you don't need ngspice to build, test or verify. You need it only to **regenerate** the corpus. Design and tolerance: [ADR 0012](../decisions/0012-oracle-corpus.md). Gotchas: [simulation caveats](../caveats/simulation.md).

## When you need to regenerate

`pnpm verify` fails with "stale oracle corpus" when the decks no longer match what the generator makes. That happens when you change:

- the generator (`libs/domain/sim-core/src/oracle/generate.ts`) or the deck emitter (`deck.ts`);
- the pinned seeds or counts (`ORACLE_CORPUS` in `corpus.ts`), or `gmin`;
- the element kinds, for example when a new stamp joins the corpus.

Also regenerate when the project moves to a new ngspice version. Never edit the corpus by hand, and never regenerate to make a failing solver comparison pass.

```bash
pnpm sim oracle regen                       # rewrites libs/domain/sim-core/oracle/ (decks and results)
pnpm sim oracle regen --ngspice /path/to/ngspice
pnpm sim oracle regen --out /tmp/oracle     # somewhere else, to inspect
pnpm nx test sim-core                       # the staleness and consistency checks
git add libs/domain/sim-core/oracle         # commit decks and results together
```

It writes every deck into a staging directory (`.regen/`) inside the corpus directory, runs each with `ngspice -n -b` in parallel (`--jobs <n>` to limit it; `-n` stops a `.spiceinit` from changing the results), and only once every circuit has solved renames `dc/`, `ac/`, `dc.results.txt` and `ac.results.txt` into place. A failed run leaves the corpus as it was. It fails, naming the circuit, if ngspice exits with an error, times out, prints too few values, or didn't use the Sparse solver; the first failure stops new runs. If ngspice isn't installed it says so and points here. A full run takes a few seconds.

The last printed digits can differ between ngspice builds and operating systems. That is expected and not a failure: the tolerance is far above it. The current corpus was regenerated on Fedora 44 (x86_64) with its ngspice 47 package.

To look at one circuit: `ngspice -n -b libs/domain/sim-core/oracle/dc/dc-0042.cir`. Each deck stands alone.

## Installing ngspice

The corpus is pinned to **ngspice 47** (`ngspice -v` prints `ngspice-47`); the version is recorded in each results file. Any build works: the decks set `.options sparse`, so it doesn't matter whether yours links KLU.

| OS               | Install                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fedora           | `sudo dnf install ngspice` (Fedora's package is 47)                                                                                                                                                                  |
| macOS            | `brew install ngspice` (Homebrew's formula is 47)                                                                                                                                                                    |
| Windows (Scoop)  | `scoop bucket add extras` then `scoop install extras/ngspice`                                                                                                                                                        |
| Windows (manual) | Download the official `ngspice-47_64.7z` from the ngspice site and extract it to `C:\Spice64`; add `C:\Spice64\bin` to `PATH`. `regen` runs `ngspice_con` (the console build) on Windows; pass `--ngspice` otherwise |
| Ubuntu / Debian  | Not apt on Ubuntu 24.04, which has ngspice 42. Build 47 from the release tarball, or use Homebrew on Linux                                                                                                           |

**Licence.** ngspice's core is Modified BSD, but every common build includes LGPL code (numparam, usually KLU) and some GPL (readline). That's fine for a tool you run: only its numeric output is checked in, from decks we generate, and ngspice is never a dependency, never vendored and never run by `pnpm verify` ([ADR 0003](../decisions/0003-licence-policy.md), external programs). Don't check in ngspice's own examples, manuals or log banners, and don't read its source while working on the solvers.

## What is in a deck

```
controls oracle dc-0007
* Generated (plan F2.7, ADR 0012): do not edit; …
.options sparse gmin=1e-12 noopac
RG1 1 0 1000000000000         gmin from each circuit node to ground (node 0, sim-core's reference)
VS0 0 s0 0                    a 0 V sense source in front of each element: i(vs0) is its current, a → b
V0 e0 s0 DC 12e0              a voltage source: EMF …
RI0 e0 1 23e-3                … behind its internal resistance
.control
set numdgt=17                 17 significant digits: every double round-trips
op                            (AC decks: ac lin 1 60 60)
print v(1) v(2)
print i(vs0) i(vs1)
.endc
.end
```
