import {
  type CommandRegistry,
  type ExecError,
  type ExecResult,
  formatConsoleLine,
  parseConsoleCommand,
  parseConsoleLine,
  splitConsoleLines,
} from '@controls/commands';
import type { ReplayEntry } from '@controls/save-format';
import type { World } from '@controls/world-model';

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

/** The output lines of a console query's text: one per line, without the final newline. */
export function queryLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Runs one console query against `target` and returns its output lines. */
export async function runConsoleQuery(target: ConsoleTarget, id: string): Promise<string[]> {
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
  | { readonly kind: 'query'; readonly lineNumber: number; readonly id: string };

/** Formats a script error as `line L, column C: message`. */
export function formatConsoleScriptError(error: ConsoleScriptError): string {
  return `line ${error.lineNumber}, column ${error.column}: ${error.message}`;
}

function parseStep(target: ConsoleTarget, lineNumber: number, source: string): Step | ConsoleScriptError | null {
  const lexed = parseConsoleLine(source);
  if (lexed.ok && lexed.line && CONSOLE_QUERIES.includes(lexed.line.id) && !target.registry.has(lexed.line.id)) {
    const extra = lexed.line.positionals[0] ?? lexed.line.flags[0];
    if (extra) {
      return { kind: 'parse', lineNumber, column: extra.column, message: `${lexed.line.id} takes no arguments` };
    }
    return { kind: 'query', lineNumber, id: lexed.line.id };
  }
  const parsed = parseConsoleCommand(target.registry, source);
  if (!parsed.ok) return { kind: 'parse', lineNumber, ...parsed.error };
  if (!parsed.command) return null;
  return { kind: 'command', lineNumber, column: firstColumn(source), ...parsed.command };
}

function firstColumn(source: string): number {
  return source.length - source.trimStart().length + 1;
}

/**
 * Runs a console-line file against `target`. Every line is parsed and mapped onto its command's
 * args **before** anything runs, so a typo on line 40 doesn't leave lines 1–39 applied. Execution
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
  for (const step of steps) {
    if (step.kind === 'query') {
      output.push(...(await runConsoleQuery(target, step.id)));
      continue;
    }
    const result = target.exec(step.id, step.args);
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
