import { type CommandRegistry, parseConsoleCommand, parseConsoleLine } from '@controls/commands';
import { CONSOLE_QUERIES } from '@controls/scripting-api';

/*
 * What one console line asks for (ADR 0008). The grammar, the mapping onto a command's args and the
 * queries are the shared ones from `@controls/commands` and `@controls/scripting-api`; this adds the
 * in-game console verbs, which are handled before the registry and never logged.
 */

/** Console verbs (single-segment ids), handled before the registry. */
export const CONSOLE_VERBS = ['clear', 'help', 'run'] as const;
export type ConsoleVerb = (typeof CONSOLE_VERBS)[number];

/** One-line descriptions of the console's own words, for `help`. */
export const CONSOLE_WORDS: Readonly<Record<string, { readonly usage: string; readonly summary: string }>> = {
  help: { usage: 'help [id]', summary: "List the commands, or show one command's arguments" },
  run: { usage: 'run', summary: 'Run a file of console lines: pick one, or drop it on the console' },
  clear: { usage: 'clear', summary: 'Clear the console output' },
  'world.hash': { usage: 'world.hash', summary: 'Print the current world hash (read-only, not logged)' },
};

export type ConsoleAction =
  | { readonly kind: 'blank' }
  | { readonly kind: 'error'; readonly message: string; readonly column: number }
  | { readonly kind: 'help'; readonly id: string | null }
  | { readonly kind: 'run' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'query'; readonly id: string }
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly args: Record<string, unknown>;
      /** The command is a cheat: running it marks the world assisted (ADR 0006). */
      readonly cheat: boolean;
    };

function isVerb(id: string): id is ConsoleVerb {
  return (CONSOLE_VERBS as readonly string[]).includes(id);
}

/** Whether `id` is a console word rather than a registered command (verbs win; commands win over queries). */
export function isConsoleWord<S>(registry: CommandRegistry<S>, id: string): boolean {
  return isVerb(id) || (CONSOLE_QUERIES.includes(id) && !registry.has(id));
}

/**
 * Resolves one console line against `registry` without running anything. Parse and mapping errors
 * carry the 1-based column of the offending word.
 */
export function resolveConsoleLine<S>(registry: CommandRegistry<S>, source: string): ConsoleAction {
  const lexed = parseConsoleLine(source);
  if (!lexed.ok) return { kind: 'error', ...lexed.error };
  const line = lexed.line;
  if (line === null) return { kind: 'blank' };

  if (isConsoleWord(registry, line.id)) {
    const [first, second] = line.positionals;
    const flag = line.flags[0];
    if (flag) return { kind: 'error', message: `${line.id} takes no flags`, column: flag.column };
    if (line.id === 'help') {
      if (second) return { kind: 'error', message: 'help takes at most one command id', column: second.column };
      return { kind: 'help', id: first?.text ?? null };
    }
    if (first) {
      if (line.id === 'run') {
        return {
          kind: 'error',
          message:
            "The game can't open file paths yet (save I/O arrives with F1.8b). Type run on its own to pick a file, or drop one on the console",
          column: first.column,
        };
      }
      return { kind: 'error', message: `${line.id} takes no arguments`, column: first.column };
    }
    if (line.id === 'run') return { kind: 'run' };
    if (line.id === 'clear') return { kind: 'clear' };
    return { kind: 'query', id: line.id };
  }

  const parsed = parseConsoleCommand(registry, source);
  if (!parsed.ok) return { kind: 'error', ...parsed.error };
  // A line that lexed as a command always maps to one (or to an error above).
  const command = parsed.command as { readonly id: string; readonly args: Record<string, unknown> };
  return { kind: 'command', ...command, cheat: registry.get(command.id)?.cheat === true };
}
