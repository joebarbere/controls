import type { World } from '@controls/save-format';
import { ISLAND_FLAG_NON_CONVERGED, ISLAND_FLAG_SINGULAR, NOMINAL_BANDS } from '@controls/sim-protocol';
import { formatNetlist } from '../netlist/format';
import { SimEngine, type SimEngineOptions, type SimIslandDiagnostic } from './engine';

/*
 * `netlist.dump` (plan F2.6): a read-only console query, like `world.hash`. Its text is a pure
 * function of the **materialised** world (what a save writes and `world.hash` hashes): an engine
 * started from it compiles the same netlist and adopts the same solution record as the engine that
 * exported it, so headless (`sim-cli`, the scripting API) and the game (the sim worker's export,
 * materialised on the main thread) print the same bytes, in Node and in Chromium. Every number is
 * an integer or `String(n)` (ECMAScript's exact shortest round trip), every list in canonical order.
 *
 * ```text
 * netlist.dump tick 1234
 * netlist 5 nodes, 6 branches, 2 islands        ← formatNetlist, unchanged
 * …
 * solution tick 1230                            ← or `solution none` (an empty netlist)
 * solve island 0 solved flags none iterations 1 reference 1 unknowns 3 band dc12
 * solve island 1 unmodelled flags none iterations 0 reference none unknowns 0 band none (no-source) unvalued 2
 * solve island 2 mixed flags none iterations 0 reference none unknowns 0 band none (mixed) sources dc 0 ac 3
 * ```
 */

/** `ISLAND_FLAG_*` bits as names, `none` for 0. Unknown bits are written as their value. */
export function formatIslandFlags(flags: number): string {
  const names: string[] = [];
  if ((flags & ISLAND_FLAG_SINGULAR) !== 0) names.push('singular');
  if ((flags & ISLAND_FLAG_NON_CONVERGED) !== 0) names.push('nonConverged');
  const rest = flags & ~(ISLAND_FLAG_SINGULAR | ISLAND_FLAG_NON_CONVERGED);
  if (rest !== 0) names.push(String(rest));
  return names.length === 0 ? 'none' : names.join(',');
}

const list = (indices: readonly number[]) => (indices.length === 0 ? 'none' : indices.join(' '));

/** One island's diagnostics line (see the file comment). */
export function formatIslandDiagnostic(island: SimIslandDiagnostic): string {
  const name = NOMINAL_BANDS[island.band] ?? `#${island.band}`;
  const band = island.bandReason === null ? name : `${name} (${island.bandReason})`;
  const reference = island.referenceNode < 0 ? 'none' : String(island.referenceNode);
  let line =
    `solve island ${island.index} ${island.status} flags ${formatIslandFlags(island.flags)}` +
    ` iterations ${island.iterations} reference ${reference} unknowns ${island.unknowns} band ${band}`;
  if (island.status === 'unmodelled') line += ` unvalued ${list(island.unvalued)}`;
  if (island.status === 'mixed') line += ` sources dc ${list(island.dcSources)} ac ${list(island.acSources)}`;
  return line;
}

/** The `netlist.dump` text of an engine's current state, ending with a newline. */
export function formatEngineDump(engine: SimEngine): string {
  const lines = [`netlist.dump tick ${engine.tick}`, formatNetlist(engine.netlist).trimEnd()];
  const solveTick = engine.lastSolveTick;
  lines.push(solveTick < 0 ? 'solution none' : `solution tick ${solveTick}`);
  for (const island of engine.islandDiagnostics()) lines.push(formatIslandDiagnostic(island));
  return `${lines.join('\n')}\n`;
}

/**
 * `netlist.dump` of a materialised world (see the file comment): its netlist (`formatNetlist`) and
 * each island's status, flags, iterations, reference, unknowns, nominal band, and why an unsolved one
 * wasn't solved. A world with `sim: null` and a circuit (a world that was never materialised, such as
 * a level) is solved at its tick first, as the engine starting on it would. Throws `SimStartError`
 * for a world whose solution record doesn't fit its netlist.
 */
export function netlistDump(world: World, options: SimEngineOptions = {}): string {
  return formatEngineDump(SimEngine.start(world, options));
}
