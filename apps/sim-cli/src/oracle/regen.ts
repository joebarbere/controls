import {
  formatOracleResults,
  ORACLE_DOMAINS,
  ORACLE_GMIN_S,
  type OracleCircuit,
  oracleCorpus,
  ORACLE_CORPUS,
  oracleDeck,
  oracleDeckOptions,
  oracleDeckPath,
  type OracleDomain,
  type OracleRawResult,
  oracleResultsPath,
  OracleResultsError,
  parseNgspiceOutput,
} from '@controls/sim-core/oracle';
import { sha256Hex } from '@controls/world-model';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

/*
 * `sim oracle regen` (plan F2.7, decision D5, ADR 0012): rewrites the oracle corpus under
 * `libs/domain/sim-core/oracle/`. It regenerates every deck from the pinned seeds, runs each through
 * ngspice in batch mode, and writes ngspice's solutions as the results files. It needs ngspice
 * installed (docs/guides/oracle.md) and is **never** part of `pnpm verify`: verify only checks the
 * checked-in decks against the generator (the staleness test), so it stays hermetic on every OS and
 * ngspice never becomes a dependency (ADR 0003's external-program exception).
 */

/** What one ngspice process did. `missing` is set when the binary could not be started at all. */
export interface NgspiceRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing?: boolean;
}

/** Runs ngspice with these arguments. sim-cli's test seam: specs pass a fake. */
export type NgspiceRunner = (args: readonly string[]) => Promise<NgspiceRun>;

/** The binary `sim oracle regen` runs unless `--ngspice` names another: the console build on Windows. */
export function defaultNgspiceBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ngspice_con' : 'ngspice';
}

/** An {@link NgspiceRunner} that spawns `binary` (no shell). A binary that can't be started is `missing`. */
export function spawnNgspice(binary: string): NgspiceRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) =>
        resolve({ status: null, stdout: '', stderr: error.message, missing: error.code === 'ENOENT' }),
      );
      child.on('close', (status) =>
        resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
      );
    });
}

export class OracleRegenError extends Error {
  override readonly name = 'OracleRegenError';
}

export interface RegenOptions {
  /** The corpus directory (default `libs/domain/sim-core/oracle`). */
  readonly outDir: string;
  /** The binary's name or path, for messages. */
  readonly binary: string;
  readonly run: NgspiceRunner;
  /** Concurrent ngspice processes (default: the machine's available parallelism). */
  readonly jobs?: number;
}

export interface RegenSummary {
  readonly ngspice: string;
  readonly solver: string;
  readonly circuits: Readonly<Record<OracleDomain, number>>;
}

const INSTALL_HINT = 'see docs/guides/oracle.md for install notes (Fedora, Homebrew, Windows)';

/** The banner's version (`ngspice-47`), from `ngspice -v`. */
async function ngspiceVersion(options: RegenOptions): Promise<string> {
  const result = await options.run(['-v']);
  if (result.missing) {
    throw new OracleRegenError(
      `ngspice not found ("${options.binary}"): it is needed only to regenerate the oracle corpus; ${INSTALL_HINT}, or pass --ngspice <path>`,
    );
  }
  const version = /\bngspice-[0-9][0-9A-Za-z.+-]*/.exec(`${result.stdout}\n${result.stderr}`);
  if (result.status !== 0 || version === null) {
    throw new OracleRegenError(`"${options.binary} -v" did not report an ngspice version (exit ${result.status})`);
  }
  return version[0];
}

/** Runs `tasks` with at most `jobs` in flight; results in task order. */
async function pool<T>(jobs: number, tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, worker));
  return results;
}

async function solve(
  options: RegenOptions,
  circuit: OracleCircuit,
  deck: string,
  path: string,
): Promise<OracleRawResult & { solver: string }> {
  const result = await options.run(['-b', path]);
  if (result.missing) throw new OracleRegenError(`ngspice not found ("${options.binary}"); ${INSTALL_HINT}`);
  if (result.status !== 0) {
    throw new OracleRegenError(
      `${circuit.name}: ngspice exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  try {
    const parsed = parseNgspiceOutput(circuit, result.stdout);
    return { name: circuit.name, deckSha256: sha256Hex(deck), ...parsed };
  } catch (error) {
    if (error instanceof OracleResultsError) throw new OracleRegenError(error.message);
    throw error;
  }
}

/** Writes a domain's decks, deleting any stray `.cir` left from a larger corpus. Returns their paths. */
async function writeDecks(outDir: string, domain: OracleDomain, circuits: readonly OracleCircuit[]) {
  const dir = join(outDir, domain);
  await mkdir(dir, { recursive: true });
  const decks = circuits.map((circuit) => ({
    circuit,
    deck: oracleDeck(circuit),
    path: join(outDir, oracleDeckPath(circuit)),
  }));
  const keep = new Set(decks.map(({ path }) => path));
  for (const file of await readdir(dir)) {
    if (file.endsWith('.cir') && !keep.has(join(dir, file))) await rm(join(dir, file));
  }
  for (const { deck, path } of decks) await writeFile(path, deck);
  return decks;
}

/**
 * Regenerates the whole corpus. Throws {@link OracleRegenError} on any failure; the results files are
 * written only once every circuit of both domains has solved, so a failed run never leaves them half new.
 */
export async function regenerateOracle(options: RegenOptions): Promise<RegenSummary> {
  const ngspice = await ngspiceVersion(options);
  const jobs = options.jobs ?? availableParallelism();
  const solved: Record<OracleDomain, (OracleRawResult & { solver: string })[]> = { dc: [], ac: [] };
  for (const domain of ORACLE_DOMAINS) {
    const decks = await writeDecks(options.outDir, domain, oracleCorpus(domain));
    solved[domain] = await pool(
      jobs,
      decks.map(
        ({ circuit, deck, path }) =>
          () =>
            solve(options, circuit, deck, path),
      ),
    );
  }
  const solvers = new Set([...solved.dc, ...solved.ac].map((result) => result.solver));
  const [solver] = solvers;
  // `.options sparse` must have taken effect in every run, so results don't depend on a KLU build.
  if (solvers.size !== 1 || !solver.startsWith('SPARSE')) {
    throw new OracleRegenError(`ngspice used ${[...solvers].join(', ')}, not Sparse: is ".options sparse" honoured?`);
  }
  for (const domain of ORACLE_DOMAINS) {
    const header = {
      domain,
      ngspice,
      solver,
      options: oracleDeckOptions(),
      gminS: ORACLE_GMIN_S,
      seed: ORACLE_CORPUS[domain].seed,
      count: ORACLE_CORPUS[domain].count,
    };
    await writeFile(join(options.outDir, oracleResultsPath(domain)), formatOracleResults(header, solved[domain]));
  }
  return { ngspice, solver, circuits: { dc: solved.dc.length, ac: solved.ac.length } };
}
