import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import {
  type CommandRegistry,
  type ConsoleCommandLine,
  type ConsoleError,
  consoleArgs,
  type ExecError,
  type ExecResult,
  formatConsoleLine,
  parseConsoleCommand,
  parseConsoleLine,
  splitConsoleLines,
} from '@controls/commands';
import type { ReplayEntry } from '@controls/save-format';
import type { World } from '@controls/world-model';
import * as z from 'zod';
import type { DeepReadonly } from './game';

/*
 * Running a console-line file (ADR 0008): the data-only script format that both `sim-cli run` and
 * the in-game console's `run <file>` (F1.5) accept. The renderer can't evaluate JavaScript under its
 * CSP, so a console-line file is the one script format that runs on every surface.
 */

/**
 * What a console-line file runs against: a headless `Game` (its `hash()` and `netlistDump()` are
 * synchronous), or the game's console, whose queries are a round trip to the sim worker (ADR 0011 §9.4).
 */
export interface ConsoleTarget {
  readonly registry: CommandRegistry<World>;
  /** The live world, read by console shorthand expanders as each line runs ({@link expandConsoleArgs}). */
  world(): DeepReadonly<World>;
  /** The catalogue the registry's commands use (default the built-in one), passed to expanders. */
  readonly catalog?: Catalog;
  /** The console shorthand expanders (default {@link CONSOLE_EXPANDERS}); tests pass their own. */
  readonly expanders?: readonly ConsoleExpander[];
  exec(id: string, args?: unknown): ExecResult;
  hash(): string | Promise<string>;
  /** The `netlist.dump` text (plan F2.6), ending with a newline. */
  netlistDump(): string | Promise<string>;
}

/**
 * Read-only console queries that are not commands (they change nothing and are never logged).
 * `world.hash` prints the current `world.hash`; `netlist.dump` prints the netlist and its island
 * diagnostics (F2.6), one output line per text line. F1.5 adds `help`, `run` and `clear` in the console.
 */
export const CONSOLE_QUERIES: readonly string[] = ['world.hash', 'netlist.dump'];

/**
 * Each console query's argument schema (ADR 0015: `wire.info <id>` will take one). Mapped with the
 * same console grammar as a command's args (`consoleArgs`), positionally or by flag, and checked
 * with the schema. A query is never logged, so its args are not save format.
 */
export const CONSOLE_QUERY_ARGS: Readonly<Record<string, z.ZodObject>> = {
  'world.hash': z.strictObject({}),
  'netlist.dump': z.strictObject({}),
};

export type ConsoleQueryArgsResult =
  { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly error: ConsoleError };

/** Maps a console query line's words onto the query's args (`CONSOLE_QUERY_ARGS`), with a column on errors. */
export function consoleQueryArgs(line: ConsoleCommandLine): ConsoleQueryArgsResult {
  const schema = Object.prototype.hasOwnProperty.call(CONSOLE_QUERY_ARGS, line.id)
    ? CONSOLE_QUERY_ARGS[line.id]
    : z.strictObject({});
  const extra = line.positionals[0] ?? line.flags[0];
  if (extra && Object.keys(schema.shape).length === 0) {
    return { ok: false, error: { message: `${line.id} takes no arguments`, column: extra.column } };
  }
  const mapped = consoleArgs(schema, line);
  if (!mapped.ok) return mapped;
  const checked = schema.safeParse(mapped.args);
  if (checked.success) return { ok: true, args: checked.data as Record<string, unknown> };
  const issue = checked.error.issues[0];
  const path = issue.path.map(String).join('.');
  return {
    ok: false,
    error: { message: `${line.id}: ${path ? `${path}: ` : ''}${issue.message}`, column: line.column },
  };
}

/**
 * A console shorthand expander (ADR 0015): for one command, replaces shorthand words in its mapped
 * args (`--route auto`, `--lengthMm auto`) with explicit values computed on the live world, before
 * `exec`. Only the expanded args reach `exec` and the replay log, so a log never holds shorthand
 * and replays without the expander; a console file that uses shorthand re-pins its hashes when an
 * expander's result changes.
 */
export interface ConsoleExpander {
  /** The command whose args it expands. */
  readonly id: string;
  /**
   * Dotted arg paths whose bare (unquoted, non-JSON) words are shorthand: the console mapping keeps
   * such a word's lexical type there instead of typing it by the schema, so it reaches `expand`.
   */
  readonly paths: readonly string[];
  /** The args with every shorthand replaced, or an error the console shows for the line. */
  expand(world: DeepReadonly<World>, catalog: Catalog, args: Readonly<Record<string, unknown>>): ConsoleExpansion;
}

export type ConsoleExpansion =
  { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly message: string };

/**
 * The console shorthand every console surface (the in-game console, `runConsoleScript`, `sim-cli`)
 * applies. Empty until routing exists: the wire commands PR adds `--route auto` and `--length auto`
 * (ADR 0015).
 */
export const CONSOLE_EXPANDERS: readonly ConsoleExpander[] = [];

/** Whether `path` of command `id` takes shorthand under `expanders` (for `parseConsoleCommand`). */
export function consoleShorthand(
  expanders: readonly ConsoleExpander[] = CONSOLE_EXPANDERS,
): (id: string, path: string) => boolean {
  return (id, path) => expanders.some((e) => e.id === id && e.paths.includes(path));
}

/**
 * Expands console shorthand in one command's args on the live `world`, before `exec`: runs every
 * expander registered for `id`, in order. Called once per line, at the moment the line runs, by
 * every console surface, so a shorthand sees the world the lines before it made. With no expander
 * for `id` the args come back unchanged.
 */
export function expandConsoleArgs(
  world: DeepReadonly<World>,
  catalog: Catalog,
  id: string,
  args: Record<string, unknown>,
  expanders: readonly ConsoleExpander[] = CONSOLE_EXPANDERS,
): ConsoleExpansion {
  let current = args;
  for (const expander of expanders) {
    if (expander.id !== id) continue;
    const result = expander.expand(world, catalog, current);
    if (!result.ok) return result;
    current = result.args;
  }
  return { ok: true, args: current };
}

/** The output lines of a console query's text: one per line, without the final newline. */
export function queryLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Runs one console query against `target` and returns its output lines. `args` come from
 * {@link consoleQueryArgs}; no query reads any yet (`wire.info <id>` will, ADR 0015).
 */
export async function runConsoleQuery(
  target: ConsoleTarget,
  id: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<string[]> {
  void args;
  if (id === 'netlist.dump') return queryLines(await target.netlistDump());
  return [await target.hash()];
}

/** Longest console-line file accepted, in lines. */
export const MAX_CONSOLE_SCRIPT_LINES = 10_000;

export type ConsoleScriptError =
  | {
      readonly kind: 'parse';
      readonly lineNumber: number;
      readonly column: number;
      readonly message: string;
    }
  | {
      /** A console shorthand couldn't be expanded on the world as it was when the line ran. */
      readonly kind: 'expand';
      readonly lineNumber: number;
      readonly column: number;
      readonly message: string;
    }
  | {
      readonly kind: 'exec';
      readonly lineNumber: number;
      readonly column: number;
      readonly message: string;
      readonly error: ExecError;
    };

export interface ConsoleScriptRun {
  /** Commands executed (successfully) before the script ended or failed. */
  readonly executed: number;
  /** Lines printed by queries such as `world.hash`, in order. */
  readonly output: readonly string[];
}

export type ConsoleScriptResult =
  | ({ readonly ok: true } & ConsoleScriptRun)
  | ({ readonly ok: false; readonly error: ConsoleScriptError } & ConsoleScriptRun);

type Step =
  | {
      readonly kind: 'command';
      readonly lineNumber: number;
      readonly column: number;
      readonly id: string;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly kind: 'query';
      readonly lineNumber: number;
      readonly id: string;
      readonly args: Record<string, unknown>;
    };

/** Formats a script error as `line L, column C: message`. */
export function formatConsoleScriptError(error: ConsoleScriptError): string {
  return `line ${error.lineNumber}, column ${error.column}: ${error.message}`;
}

function parseStep(target: ConsoleTarget, lineNumber: number, source: string): Step | ConsoleScriptError | null {
  const lexed = parseConsoleLine(source);
  if (lexed.ok && lexed.line && CONSOLE_QUERIES.includes(lexed.line.id) && !target.registry.has(lexed.line.id)) {
    const query = consoleQueryArgs(lexed.line);
    if (!query.ok) return { kind: 'parse', lineNumber, ...query.error };
    return { kind: 'query', lineNumber, id: lexed.line.id, args: query.args };
  }
  const parsed = parseConsoleCommand(target.registry, source, consoleShorthand(target.expanders));
  if (!parsed.ok) return { kind: 'parse', lineNumber, ...parsed.error };
  if (!parsed.command) return null;
  return { kind: 'command', lineNumber, column: firstColumn(source), ...parsed.command };
}

function firstColumn(source: string): number {
  return source.length - source.trimStart().length + 1;
}

/**
 * Runs a console-line file against `target`. Every line is parsed and mapped onto its command's
 * args **before** anything runs (console shorthand is expanded later, per line, on the live world), so a typo on line 40 doesn't leave lines 1–39 applied. Execution
 * then stops at the first command that fails; commands before it stay applied (and logged), like
 * typing the same lines into the console. Asynchronous everywhere (ADR 0011 §9.4): a `world.hash` or
 * `netlist.dump` line waits for the target's answer before the next line runs, so it covers exactly
 * the lines before it.
 */
export async function runConsoleScript(target: ConsoleTarget, text: string): Promise<ConsoleScriptResult> {
  const lines = splitConsoleLines(text);
  if (lines.length > MAX_CONSOLE_SCRIPT_LINES) {
    const error: ConsoleScriptError = {
      kind: 'parse',
      lineNumber: MAX_CONSOLE_SCRIPT_LINES + 1,
      column: 1,
      message: `Script is longer than ${MAX_CONSOLE_SCRIPT_LINES} lines`,
    };
    return { ok: false, error, executed: 0, output: [] };
  }
  const steps: Step[] = [];
  for (const { lineNumber, source } of lines) {
    const step = parseStep(target, lineNumber, source);
    if (step === null) continue;
    if (step.kind !== 'command' && step.kind !== 'query') return { ok: false, error: step, executed: 0, output: [] };
    steps.push(step);
  }

  const output: string[] = [];
  let executed = 0;
  const catalog = target.catalog ?? BUILTIN_CATALOG;
  for (const step of steps) {
    if (step.kind === 'query') {
      output.push(...(await runConsoleQuery(target, step.id, step.args)));
      continue;
    }
    // Shorthand is expanded on the live world as the line runs (ADR 0015); only the result is logged.
    const expanded = expandConsoleArgs(target.world(), catalog, step.id, step.args, target.expanders);
    if (!expanded.ok) {
      const error: ConsoleScriptError = {
        kind: 'expand',
        lineNumber: step.lineNumber,
        column: step.column,
        message: expanded.message,
      };
      return { ok: false, error, executed, output };
    }
    const result = target.exec(step.id, expanded.args);
    if (!result.ok) {
      const error: ConsoleScriptError = {
        kind: 'exec',
        lineNumber: step.lineNumber,
        column: step.column,
        message: describeExecError(result.error),
        error: result.error,
      };
      return { ok: false, error, executed, output };
    }
    executed++;
  }
  return { ok: true, executed, output };
}

/** A one-line description of an exec error, including the first argument issues. */
export function describeExecError(error: ExecError): string {
  if (error.kind !== 'invalid-args' || error.issues.length === 0) return error.message;
  const details = error.issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  return `${error.message}: ${details}`;
}

/**
 * Writes replay entries as a console-line file (one `formatConsoleLine` per entry), so a session
 * recorded on any surface can be re-run as console lines. Throws `ConsoleFormatError` for args the
 * grammar can't express.
 */
export function toConsoleScript(entries: readonly ReplayEntry[]): string {
  return entries.map((entry) => `${formatConsoleLine(entry.id, entry.args)}\n`).join('');
}
