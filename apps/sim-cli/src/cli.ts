import { CtrlWriteError, migrateWorld, readCtrl, type World } from '@controls/save-format';
import {
  BUILD_ENGINE_VERSIONS,
  createGame,
  ENGINE_CHANGED_MESSAGE,
  engineCompatible,
  formatConsoleScriptError,
  type Game,
  gameFromSave,
  replayGame,
  replayLogGame,
  runConsoleScript,
} from '@controls/scripting-api';
import { hashWorldDocument, newGameWorld, worldHash } from '@controls/world-model';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { type BenchCase, runBench } from './bench/bench';
import { BENCH_CASES, PENDING_BENCH_CASES } from './bench/cases';
import { wallClockMs } from './bench/clock';
import { readDocument } from './documents';
import {
  defaultNgspiceBinary,
  type NgspiceRunner,
  OracleRegenError,
  regenerateOracle,
  spawnNgspice,
} from './oracle/regen';
import { loadModuleScript, MODULE_SCRIPT_EXTENSIONS, WORKSPACE_ROOT } from './script-loader';

/*
 * `sim-cli`: runs the game headless in plain Node (plan §4.6, F1.6, ADR 0008).
 *
 *   sim run <script> [--world <file>] [--seed N] [--log <out.json>] [--save <out.ctrl>] [--expect <hash>]
 *   sim replay <save.ctrl | replay-log.json> [--expect <hash>]
 *   sim hash <save.ctrl | world.json> [--expect <hash>]
 *   sim bench
 *   sim oracle regen [--ngspice <path>] [--out <dir>]
 *
 * stdout carries data only (hashes, a script's own output); diagnostics go to stderr. Exit codes:
 * 0 success, 1 failure (bad document, failing script, hash mismatch, bench over budget), 2 usage error.
 */

export interface CliIo {
  /** The directory relative paths are resolved against (the caller's shell directory). */
  readonly cwd: string;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Test seam for `sim bench`: the cases to run (default {@link BENCH_CASES}). */
  readonly benchCases?: readonly BenchCase[];
  /** Test seam for `sim bench`: the clock, in ms (default the wall clock). */
  readonly now?: () => number;
  /** Test seam for `sim oracle regen`: runs ngspice (default: spawn the `--ngspice` binary). */
  readonly ngspice?: NgspiceRunner;
  /** Test seam for `sim oracle regen`: circuits per domain (default the pinned corpus's counts). */
  readonly oracleCounts?: Readonly<Record<'dc' | 'ac', number>>;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: sim <command> [options]

Commands:
  run <script>     Run a TypeScript/JavaScript module (.ts .mts .js .mjs) exporting
                   default (game) => …, or a console-line file (any other extension,
                   conventionally .console). Prints world.hash at the end.
      --world <file>      Start from a .ctrl save (loaded as the game loads it: undo
                          cleared, its replay log continued), a world document or a
                          level, e.g. content/levels/workshop.json (default: an empty world)
      --seed <n>          The seed: of the empty world (default 0), or, with --world,
                          a new game on that world with this seed (as New sandbox does)
      --log <file>        Write the session's replay log (JSON) here
      --save <file>       Write the session as a .ctrl save here
  replay <file>    Replay a .ctrl save's replay.log (or a replay-log JSON) from its
                   initial world and print the hash; for a .ctrl, fail unless it
                   equals the hash of the save's world.json
  hash <file>      Print world.hash of a .ctrl save's world.json, or of a world
                   document (world.json, a level)
  bench            Run the performance cases (warm-up, then the median of N runs)
      --report <file>     Also write the JSON report to this file (the Nx bench target does, for CI's log)
                   and print a JSON report; fail if a case is over its budget or
                   not deterministic
  oracle regen     Regenerate the ngspice oracle corpus (libs/domain/sim-core/oracle):
                   rewrite every deck from the pinned seeds, run each through ngspice
                   and write its results. Needs ngspice installed (docs/guides/oracle.md);
                   never part of pnpm verify
      --ngspice <path>    The ngspice binary (default ngspice; ngspice_con on Windows)
      --out <dir>         The corpus directory (default libs/domain/sim-core/oracle)
      --jobs <n>          Concurrent ngspice runs (default: the number of CPUs)
  help             Show this help

Common options:
      --expect <hash>     Fail (exit 1) unless the final hash equals this`;

const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  run: ['seed', 'world', 'log', 'save', 'expect'],
  replay: ['expect'],
  hash: ['expect'],
  bench: ['report'],
  oracle: ['ngspice', 'out', 'jobs'],
};

class UsageError extends Error {}
class Failure extends Error {}

interface Parsed {
  readonly command: string;
  readonly file: string;
  readonly options: Readonly<Record<string, string>>;
}

function parseArgv(argv: readonly string[]): Parsed | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return 'help';
  const allowed = OPTIONS[command];
  if (!allowed) throw new UsageError(`Unknown command "${command}"`);
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`Unknown option ${arg} for "${command}"`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new UsageError(`${arg} is given twice`);
    options[name] = value;
  }
  if (command === 'bench') {
    if (positionals.length !== 0) throw new UsageError('"bench" takes no arguments');
    return { command, file: '', options };
  }
  if (command === 'oracle' && positionals.length !== 1) throw new UsageError('"oracle" takes one subcommand: regen');
  if (positionals.length !== 1) throw new UsageError(`"${command}" takes exactly one file`);
  return { command, file: positionals[0], options };
}

function parseSeed(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) > 0xffff_ffff) {
    throw new UsageError('--seed must be an unsigned 32-bit integer');
  }
  return Number(text);
}

/** Runs the CLI. Never throws; returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if (parsed === 'help') {
      io.stdout(USAGE);
      return EXIT_OK;
    }
    if (parsed.command === 'bench') return await bench(parsed, io);
    if (parsed.command === 'oracle') return await oracle(parsed, io);
    const path = resolve(io.cwd, parsed.file);
    const hash =
      parsed.command === 'run'
        ? await run(path, parsed, io)
        : parsed.command === 'replay'
          ? await replay(path, parsed.file)
          : await hashFile(path, parsed.file);
    io.stdout(hash);
    const expected = parsed.options['expect'];
    if (expected !== undefined && expected !== hash) {
      io.stderr(`sim: hash mismatch: expected ${expected}`);
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`sim: ${error.message}`);
      io.stderr('Run "sim help" for usage.');
      return EXIT_USAGE;
    }
    io.stderr(`sim: ${error instanceof Failure ? error.message : describe(error)}`);
    return EXIT_FAILURE;
  }
}

/**
 * `sim bench`: prints the report as JSON (stdout stays data only), and with `--report <file>` also
 * writes it there (Nx hides a passing task's output, so CI prints the file in a step of its own);
 * exit 1 unless every case passed.
 */
async function bench(parsed: Parsed, io: CliIo): Promise<number> {
  const report = io.benchCases
    ? runBench(io.benchCases, io.now ?? wallClockMs)
    : runBench(BENCH_CASES, io.now ?? wallClockMs, PENDING_BENCH_CASES);
  const json = JSON.stringify(report, null, 2);
  io.stdout(json);
  const reportFile = parsed.options['report'];
  if (reportFile !== undefined) await writeFile(resolve(io.cwd, reportFile), `${json}\n`);
  for (const result of report.cases) {
    if (!result.deterministic) io.stderr(`sim: bench case "${result.name}" returned different checksums across runs`);
    else if (result.invariant?.failure)
      io.stderr(`sim: bench case "${result.name}" failed: ${result.invariant.failure}`);
    else if (!result.ok && result.calibration !== null) {
      const { calibration } = result;
      io.stderr(
        `sim: bench case "${result.name}" over budget: ${result.gatedMs} ms on the reference machine > ${result.budgetMs} ms ` +
          `(median ${result.medianMs} ms here, beside the ${calibration.name} at ${calibration.medianMs} ms ` +
          `against its reference ${calibration.referenceMs} ms)`,
      );
    } else if (!result.ok) {
      io.stderr(`sim: bench case "${result.name}" over budget: median ${result.medianMs} ms > ${result.budgetMs} ms`);
    }
  }
  return report.ok ? EXIT_OK : EXIT_FAILURE;
}

/** The default corpus directory, in the workspace. */
export const ORACLE_CORPUS_DIR = join(WORKSPACE_ROOT, 'libs/domain/sim-core/oracle');

/** `sim oracle regen`: the only subcommand. Prints a one-line summary per domain on stdout. */
async function oracle(parsed: Parsed, io: CliIo): Promise<number> {
  if (parsed.file !== 'regen') throw new UsageError(`Unknown oracle subcommand "${parsed.file}" (expected "regen")`);
  const binary = parsed.options['ngspice'] ?? defaultNgspiceBinary();
  const out = parsed.options['out'];
  const jobsText = parsed.options['jobs'];
  if (jobsText !== undefined && !/^[1-9][0-9]{0,3}$/.test(jobsText)) {
    throw new UsageError('--jobs must be a whole number from 1 to 9999');
  }
  try {
    const summary = await regenerateOracle({
      outDir: out === undefined ? ORACLE_CORPUS_DIR : resolve(io.cwd, out),
      binary,
      run: io.ngspice ?? spawnNgspice(binary),
      ...(io.oracleCounts ? { counts: io.oracleCounts } : {}),
      ...(jobsText === undefined ? {} : { jobs: Number(jobsText) }),
    });
    for (const [domain, count] of Object.entries(summary.circuits)) {
      io.stdout(`${domain} ${count} circuits, ${summary.ngspice}, ${summary.solver}`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof OracleRegenError) throw new Failure(`oracle regen: ${error.message}`);
    throw error;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function startGame(parsed: Parsed, io: CliIo): Promise<Game> {
  const worldFile = parsed.options['world'];
  const seedText = parsed.options['seed'];
  const seed = seedText === undefined ? undefined : parseSeed(seedText);
  if (worldFile === undefined) return createGame({ seed: seed ?? 0 });
  const document = await readDocument(resolve(io.cwd, worldFile), worldFile);
  if (!document.ok) throw new Failure(document.message);
  let world: World;
  if (document.kind === 'ctrl') {
    const read = readCtrl(document.bytes);
    if (!read.ok) throw new Failure(`${worldFile}: ${read.error.message}`);
    if (seed === undefined) {
      // The game's Load: the saved world, undo cleared, the replay log continued (or restarted).
      const loaded = gameFromSave(read.value);
      if (!loaded.ok) throw new Failure(`${worldFile}: ${loaded.error.message}`);
      if (loaded.replay.status === 'restarted') io.stderr(`sim: ${worldFile}: ${loaded.replay.message}`);
      return loaded.game;
    }
    world = read.value.world;
  } else {
    if (document.kind !== 'world') throw new Failure(`${worldFile}: is a replay log, not a world document`);
    const loaded = migrateWorld(document.json);
    if (!loaded.ok) throw new Failure(`${worldFile}: ${loaded.error.message}`);
    world = loaded.value;
  }
  // With --seed, a new game on that world (New sandbox's path); without, the document as it is.
  return createGame({ world: seed === undefined ? world : newGameWorld(world, { seed }) });
}

async function run(path: string, parsed: Parsed, io: CliIo): Promise<string> {
  const game = await startGame(parsed, io);
  if (MODULE_SCRIPT_EXTENSIONS.includes(extname(path).toLowerCase())) {
    const loaded = await loadModuleScript(path, parsed.file);
    if (!loaded.ok) throw new Failure(loaded.message);
    try {
      await loaded.run(game);
    } catch (error) {
      throw new Failure(`${parsed.file}: script failed: ${describe(error)}`);
    }
  } else {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new Failure(`${parsed.file}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`);
    }
    const result = await runConsoleScript(game, text);
    for (const line of result.output) io.stdout(line);
    if (!result.ok) throw new Failure(`${parsed.file}: ${formatConsoleScriptError(result.error)}`);
  }
  const logFile = parsed.options['log'];
  if (logFile !== undefined) {
    await writeFile(resolve(io.cwd, logFile), `${JSON.stringify(game.replayLog(), null, 2)}\n`);
  }
  const saveFile = parsed.options['save'];
  if (saveFile !== undefined) {
    let bytes: Uint8Array;
    try {
      bytes = game.save();
    } catch (error) {
      if (error instanceof CtrlWriteError) throw new Failure(`${saveFile}: ${error.message}`);
      throw error;
    }
    await writeFile(resolve(io.cwd, saveFile), bytes);
  }
  return game.hash();
}

async function replay(path: string, label: string): Promise<string> {
  const document = await readDocument(path, label);
  if (!document.ok) throw new Failure(document.message);
  if (document.kind === 'ctrl') return replaySave(document.bytes, label);
  if (document.kind !== 'replay-log') {
    throw new Failure(`${label}: is a world document, not a replay log (use "sim hash")`);
  }
  const result = replayGame(document.json);
  if (!result.ok) throw new Failure(`${label}: ${result.error.message}`);
  return result.game.hash();
}

/**
 * Replay for a `.ctrl`: run its `replay.log` entries from the log's initial world (which carries
 * the seed), and require the result to hash like the save's `world.json`. Prints the replayed hash.
 */
function replaySave(bytes: Uint8Array, label: string): string {
  const read = readCtrl(bytes);
  if (!read.ok) throw new Failure(`${label}: ${read.error.message}`);
  // A save from another sim engine or catalogue isn't expected to reproduce its world (D8): every
  // failure below says so, and how to load or hash it instead.
  const { manifest } = read.value;
  const note =
    engineCompatible(manifest, BUILD_ENGINE_VERSIONS) === 'engine-changed'
      ? ` (written by sim engine ${manifest.simEngineVersion}, catalogue ${manifest.catalogVersion}; this build is engine ${BUILD_ENGINE_VERSIONS.simEngineVersion}, catalogue ${BUILD_ENGINE_VERSIONS.catalogVersion}: ${ENGINE_CHANGED_MESSAGE} Load it as the game does with "sim run <empty.console> --world ${label}", or hash its saved world with "sim hash ${label}")`
      : '';
  if (read.value.replayLog === null) throw new Failure(`${label}: has no replay.log (use "sim hash")${note}`);
  const result = replayLogGame(read.value.replayLog);
  if (!result.ok) throw new Failure(`${label}: replay.log: ${result.error.message}${note}`);
  const replayed = result.game.hash();
  const saved = worldHash(read.value.world);
  if (replayed !== saved) {
    throw new Failure(`${label}: replay.log replays to ${replayed}, but world.json hashes to ${saved}${note}`);
  }
  return replayed;
}

async function hashFile(path: string, label: string): Promise<string> {
  const document = await readDocument(path, label);
  if (!document.ok) throw new Failure(document.message);
  if (document.kind === 'ctrl') {
    const read = readCtrl(document.bytes);
    if (!read.ok) throw new Failure(`${label}: ${read.error.message}`);
    return worldHash(read.value.world);
  }
  if (document.kind !== 'world') throw new Failure(`${label}: is a replay log (use "sim replay")`);
  const result = hashWorldDocument(document.json);
  if (!result.ok) throw new Failure(`${label}: ${result.error.message}`);
  return result.hash;
}
