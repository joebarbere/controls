# ADR 0003: Licence policy

**Status:** Accepted
**Date:** 2026-10-26 (Phase 0)
**Sources:** plan §1 (decisions), §3.3, §3.6, §5; all four [research reports](../research/)

## Context

Controls is open source and distributed as installers on GitHub Releases. The most useful reference projects in this domain use a mix of licences: Falstad CircuitJS1 (GPL-2.0), OpenPLC Editor and Beremiz (GPL), Studomate (AGPL-3.0), alongside permissive ones such as the Modelica Standard Library, OpenDSS and pandapower (BSD-3), @spice-ts/core, brownout, CircuitVerse, FUXA and OpenPLC Runtime v4 (MIT). Domain data has its own problem: NFPA 70 (the NEC) text and tables are copyrighted, and real vendor names and trade dress are trademarks.

## Options

1. **GPL-3.0 for the game.** It would allow reusing GPL code, but the whole game and every derivative would have to be GPL, which the project decided against (plan §1).
2. **MIT, with GPL projects reference-only.**
3. **Proprietary.** Rejected: the project is intended to be open.

## Decision

- **The game is MIT** (`LICENSE`, © 2026 Joe Barbere).
- **Dependencies and adapted code** must be MIT, BSD, ISC, Apache-2.0 or similarly permissive, and are attributed in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) in the same PR.
- **GPL, AGPL and LGPL projects are reference-only.** Read their documentation and design write-ups; reimplement from papers, specs and first principles. Never paste, port or line-by-line translate their code. Agents implementing a feature must not open GPL source files. Algorithms aren't copyrightable; code is.
- An LGPL library may be used only as a separately loaded, replaceable module (for example `klu-js` WASM), and only with an ADR.
- **No NEC/NFPA text or tables.** Rules are paraphrased and cite the article number. Ratings and constants carry a `source` field (datasheet, physics derivation or public reference); conductor resistance is computed from resistivity.
- **Fictional vendors.** Device brands, PLC families and model numbers are invented. Industry-standard instruction mnemonics (XIC, OTE, TON, IEC names) are fine; vendor trade dress is not.
- **Dev-only dependencies** (anything in `package.json`, vendored or run by `pnpm verify`) still need a permissive licence, even though they don't ship.
- **External programs that developers run** may have any licence, if all of these hold (amended 2026-10-29, P2 kickoff):
  - they are never in `package.json`, never vendored, never shipped and never needed by `pnpm verify` or CI;
  - only their **numeric outputs** are checked in, computed from inputs we generate ourselves;
  - their own example files, model libraries, manuals and log banners are never checked in.

  The ngspice oracle is the case in point (P2 decision D5, ADR 0012). No common ngspice build is purely BSD: numparam (LGPL) is always compiled in, the distro, Homebrew and Windows builds link KLU (LGPL), and some link GNU readline (GPL-3). Using a program isn't restricted by these licences, and its output isn't covered by them unless the output contains the program's own code. The amendment was approved by the user on 2026-10-29.

## Consequences

- Contributors and agents must check a dependency's licence before adding it; `docs-keeper` and `release-engineer` keep `THIRD_PARTY_NOTICES.md` in sync.
- Some features take longer because we reimplement rather than port (the solver, ST parser, ladder editor).
- `electrical-realism-reviewer` (P2) flags missing `source` fields and copied NEC text.
