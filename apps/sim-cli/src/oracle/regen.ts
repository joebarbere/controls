import {
  formatOracleResults,
  generateOracleCircuit,
  ORACLE_DOMAINS,
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
import { GMIN_S } from '@controls/sim-core';
import { sha256Hex } from '@controls/world-model';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
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
  /** Set when the run was killed for taking longer than its timeout. */
  readonly timedOut?: boolean;
}

/** Runs ngspice with these arguments. sim-cli's test seam: specs pass a fake. */
export type NgspiceRunner = (args: readonly string[]) => Promise<NgspiceRun>;

/** The binary `sim oracle regen` runs unless `--ngspice` names another: the console build on Windows. */
export function defaultNgspiceBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ngspice_con' : 'ngspice';
}

/** The longest one ngspice run may take before it is killed (a deck solves in about 20 ms). */
export const NGSPICE_TIMEOUT_MS = 60_000;

/**
 * An {@link NgspiceRunner} that spawns `binary` (no shell). A binary that can't be started is
 * `missing`; a run still going after `timeoutMs` is killed and reported `timedOut`.
 */
export function spawnNgspice(binary: string, timeoutMs: number = NGSPICE_TIMEOUT_MS): NgspiceRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: timeoutMs });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) =>
        resolve({ status: null, stdout: '', stderr: error.message, missing: error.code === 'ENOENT' }),
      );
      child.on('close', (status, signal) =>
        resolve({
          status,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          ...(status === null && signal !== null && child.killed ? { timedOut: true } : {}),
        }),
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
  /** Test seam: circuits per domain (default `ORACLE_CORPUS`'s counts), so specs write a small corpus. */
  readonly counts?: Readonly<Record<OracleDomain, number>>;
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

/**
 * Runs `tasks` with at most `jobs` in flight; results in task order. A failure stops every worker
 * from starting another task; the pool waits for the runs already going, then rejects with the
 * failure of the *lowest-numbered* task. Tasks start in order, so every task below a failed one has
 * already run: the reported failure is the first in task order, whichever run happened to finish first.
 */
async function pool<T>(jobs: number, tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  let failedAt = -1;
  let failure: unknown = null;
  const worker = async () => {
    while (failedAt < 0 && next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (error) {
        if (failedAt < 0 || i < failedAt) {
          failedAt = i;
          failure = error;
        }
      }
    }
  };
  // Wait for the runs already going before rejecting, so none still holds a staging file open.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, worker));
  if (failedAt >= 0) throw failure;
  return results;
}

async function solve(
  options: RegenOptions,
  circuit: OracleCircuit,
  deck: string,
  path: string,
): Promise<OracleRawResult & { solver: string }> {
  // -n: no .spiceinit (from the working directory or HOME), which could silently change the results.
  const result = await options.run(['-n', '-b', path]);
  if (result.missing) throw new OracleRegenError(`ngspice not found ("${options.binary}"); ${INSTALL_HINT}`);
  if (result.timedOut) throw new OracleRegenError(`${circuit.name}: ngspice timed out`);
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

/** The domain's circuits: `count` of them from the pinned seed (the corpus itself unless a spec shrinks it). */
function circuitsOf(domain: OracleDomain, count: number): OracleCircuit[] {
  return count === ORACLE_CORPUS[domain].count
    ? oracleCorpus(domain)
    : Array.from({ length: count }, (_, index) => generateOracleCircuit(domain, ORACLE_CORPUS[domain].seed, index));
}

/** Writes a domain's decks into `dir` (the staging directory). Returns each with its path. */
async function writeDecks(dir: string, domain: OracleDomain, circuits: readonly OracleCircuit[]) {
  await mkdir(join(dir, domain), { recursive: true });
  const decks = circuits.map((circuit) => ({
    circuit,
    deck: oracleDeck(circuit),
    path: join(dir, oracleDeckPath(circuit)),
  }));
  for (const { deck, path } of decks) await writeFile(path, deck);
  return decks;
}

/** The staging directory inside the output directory, so the final renames stay on one file system. */
export const REGEN_STAGING_DIR = '.regen';

/**
 * Regenerates the whole corpus. Throws {@link OracleRegenError} on any failure. Everything is written
 * into a staging directory inside `outDir` first; only once every circuit of both domains has solved
 * are `dc/`, `ac/` and both results files renamed into place (the old ones moved aside, then deleted).
 * A failed run leaves the existing corpus untouched, and the first failure stops new ngspice runs.
 */
export async function regenerateOracle(options: RegenOptions): Promise<RegenSummary> {
  const ngspice = await ngspiceVersion(options);
  const jobs = options.jobs ?? availableParallelism();
  const counts = options.counts ?? { dc: ORACLE_CORPUS.dc.count, ac: ORACLE_CORPUS.ac.count };
  const staging = join(options.outDir, REGEN_STAGING_DIR);
  await rm(staging, { recursive: true, force: true });
  try {
    const solved: Record<OracleDomain, (OracleRawResult & { solver: string })[]> = { dc: [], ac: [] };
    for (const domain of ORACLE_DOMAINS) {
      const decks = await writeDecks(staging, domain, circuitsOf(domain, counts[domain]));
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
        gminS: GMIN_S.value,
        seed: ORACLE_CORPUS[domain].seed,
        count: counts[domain],
      };
      await writeFile(join(staging, oracleResultsPath(domain)), formatOracleResults(header, solved[domain]));
    }
    const entries = [...ORACLE_DOMAINS, ...ORACLE_DOMAINS.map(oracleResultsPath)];
    await mkdir(join(staging, 'old'));
    for (const entry of entries) {
      await rename(join(options.outDir, entry), join(staging, 'old', entry)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(join(staging, entry), join(options.outDir, entry));
    }
    return { ngspice, solver, circuits: { dc: solved.dc.length, ac: solved.ac.length } };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
