import { migrateWorld } from '@controls/save-format';
import { createGame, formatConsoleScriptError, type Game, replayGame, runConsoleScript } from '@controls/scripting-api';
import { hashWorldDocument, newGameWorld } from '@controls/world-model';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { readDocument } from './documents';
import { loadModuleScript, MODULE_SCRIPT_EXTENSIONS } from './script-loader';

/*
 * `sim-cli`: runs the game headless in plain Node (plan §4.6, F1.6, ADR 0008).
 *
 *   sim run <script> [--world <world.json>] [--seed N] [--log <out.json>] [--expect <hash>]
 *   sim replay <replay-log.json> [--expect <hash>]
 *   sim hash <world.json> [--expect <hash>]
 *
 * stdout carries data only (hashes, a script's own output); diagnostics go to stderr. Exit codes:
 * 0 success, 1 failure (bad document, failing script, hash mismatch), 2 usage error.
 */

export interface CliIo {
  /** The directory relative paths are resolved against (the caller's shell directory). */
  readonly cwd: string;
  stdout(line: string): void;
  stderr(line: string): void;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage: sim <command> [options]

Commands:
  run <script>     Run a TypeScript/JavaScript module (.ts .mts .js .mjs) exporting
                   default (game) => …, or a console-line file (any other extension,
                   conventionally .console). Prints world.hash at the end.
      --world <file>      Start from a world document or a level, e.g.
                          content/levels/workshop.json (default: an empty world)
      --seed <n>          The seed: of the empty world (default 0), or, with --world,
                          a new game on that level with this seed (as New sandbox does)
      --log <file>        Write the session's replay log (JSON) here
  replay <file>    Replay a replay-log JSON from its initial world; print the hash
  hash <file>      Print world.hash of a world document (world.json, a level)
  help             Show this help

Common options:
      --expect <hash>     Fail (exit 1) unless the final hash equals this

.ctrl saves are read from F1.8b; until then pass the JSON documents.`;

const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  run: ['seed', 'world', 'log', 'expect'],
  replay: ['expect'],
  hash: ['expect'],
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
  if (document.kind !== 'world') throw new Failure(`${worldFile}: is a replay log, not a world document`);
  const loaded = migrateWorld(document.json);
  if (!loaded.ok) throw new Failure(`${worldFile}: ${loaded.error.message}`);
  // With --seed, a new game on that level (New sandbox's path); without, the document as it is.
  return createGame({ world: seed === undefined ? loaded.value : newGameWorld(loaded.value, { seed }) });
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
    const result = runConsoleScript(game, text);
    for (const line of result.output) io.stdout(line);
    if (!result.ok) throw new Failure(`${parsed.file}: ${formatConsoleScriptError(result.error)}`);
  }
  const logFile = parsed.options['log'];
  if (logFile !== undefined) {
    await writeFile(resolve(io.cwd, logFile), `${JSON.stringify(game.replayLog(), null, 2)}\n`);
  }
  return game.hash();
}

async function replay(path: string, label: string): Promise<string> {
  const document = await readDocument(path, label);
  if (!document.ok) throw new Failure(document.message);
  if (document.kind !== 'replay-log') {
    throw new Failure(`${label}: is a world document, not a replay log (use "sim hash")`);
  }
  const result = replayGame(document.json);
  if (!result.ok) throw new Failure(`${label}: ${result.error.message}`);
  return result.game.hash();
}

async function hashFile(path: string, label: string): Promise<string> {
  const document = await readDocument(path, label);
  if (!document.ok) throw new Failure(document.message);
  if (document.kind !== 'world') throw new Failure(`${label}: is a replay log (use "sim replay")`);
  const result = hashWorldDocument(document.json);
  if (!result.ok) throw new Failure(`${label}: ${result.error.message}`);
  return result.hash;
}
