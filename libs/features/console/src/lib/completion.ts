import { type CommandRegistry, consoleFields } from '@controls/commands';
import { CONSOLE_QUERIES } from '@controls/scripting-api';
import { CONSOLE_VERBS, isConsoleWord } from './interpret';

/*
 * Tab completion for the dev console (plan F1.5): command ids, flag names and enum values, all read
 * from the registry (ids and `args` schemas through `consoleFields`), so a new command completes
 * without any console change. Purely lexical on the text before the cursor, so it also works on a
 * line that doesn't parse yet.
 */

/** Candidates for the word at the cursor, which spans `[from, to)` of the line. */
export interface ConsoleCompletion {
  readonly from: number;
  readonly to: number;
  /** The text of the word being completed, before the cursor. */
  readonly prefix: string;
  /** Sorted, unique. */
  readonly candidates: readonly string[];
}

interface Word {
  readonly start: number;
  readonly text: string;
}

/** Words before the cursor, plus the (possibly empty) word the cursor is in; `null` inside a quote or comment. */
function scan(before: string): { words: Word[]; current: Word } | null {
  const words: Word[] = [];
  let i = 0;
  while (i < before.length) {
    const ch = before[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '#') return null;
    const start = i;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < before.length && before[i] !== ch) i += before[i] === '\\' ? 2 : 1;
      if (i >= before.length) return null; // the cursor is inside the quote
      i++;
    } else {
      while (i < before.length && before[i] !== ' ' && before[i] !== '\t') i++;
    }
    words.push({ start, text: before.slice(start, i) });
  }
  const last = words[words.length - 1];
  const endsInWord = last !== undefined && last.start + last.text.length === before.length;
  if (endsInWord) {
    words.pop();
    if (last.text.startsWith('"') || last.text.startsWith("'")) return null;
    return { words, current: last };
  }
  return { words, current: { start: before.length, text: '' } };
}

const uniqueSorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();

/** Every id the console accepts as a first word: commands, verbs and queries. */
export function consoleIds<S>(registry: CommandRegistry<S>): string[] {
  return uniqueSorted([...registry.list().map((def) => def.id), ...CONSOLE_VERBS, ...CONSOLE_QUERIES]);
}

/**
 * The completion candidates for the word at `cursor` in `text`, or `null` when there is nothing
 * to complete (inside a quote or a comment, an unknown command, a free-text value).
 */
export function completeConsoleInput<S>(
  registry: CommandRegistry<S>,
  text: string,
  cursor: number,
): ConsoleCompletion | null {
  const scanned = scan(text.slice(0, cursor));
  if (!scanned) return null;
  const { words, current } = scanned;
  let to = cursor;
  while (to < text.length && text[to] !== ' ' && text[to] !== '\t') to++;
  const result = (pool: Iterable<string>): ConsoleCompletion | null => {
    const candidates = uniqueSorted([...pool].filter((c) => c.startsWith(current.text) && c !== ''));
    return candidates.length > 0 ? { from: current.start, to, prefix: current.text, candidates } : null;
  };

  if (words.length === 0) return result(consoleIds(registry));
  const head = words[0].text;
  if (head === 'help') return words.length === 1 ? result(consoleIds(registry)) : null;
  if (isConsoleWord(registry, head)) return null;
  const def = registry.get(head);
  if (!def) return null;
  const fields = consoleFields(def.args);
  const rest = words.slice(1);

  if (current.text.startsWith('-')) {
    const given = new Set(rest.filter((w) => w.text.startsWith('--')).map((w) => w.text.slice(2)));
    return result(fields.filter((f) => !given.has(f.path)).map((f) => `--${f.path}`));
  }

  const previous = rest[rest.length - 1];
  let field;
  if (previous?.text.startsWith('--')) {
    field = fields.find((f) => f.path === previous.text.slice(2));
  } else if (!rest.some((w) => w.text.startsWith('--'))) {
    field = fields.find((f) => f.position === rest.length); // positional words fill keys in order
  }
  if (!field || (field.kind !== 'enum' && field.kind !== 'boolean')) return null;
  return result(field.values.map(String));
}

/** Longest common prefix of `items` (non-empty). */
export function commonPrefix(items: readonly string[]): string {
  let prefix = items[0] ?? '';
  for (const item of items) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/** What one Tab press does to the line. */
export interface CompletionStep {
  readonly text: string;
  readonly cursor: number;
  /** The candidates to show (empty after a unique completion). */
  readonly candidates: readonly string[];
  /** Index of the inserted candidate while cycling, else -1. */
  readonly selected: number;
}

/**
 * Shell-style Tab completion. One candidate: insert it and a space. Several: extend to their
 * common prefix; if that adds nothing, insert the first and cycle through them on each further Tab
 * (any other edit ends the cycle). Returns `null` when there is nothing to complete.
 */
export class TabCompleter<S> {
  private cycle: {
    from: number;
    candidates: readonly string[];
    selected: number;
    text: string;
    cursor: number;
  } | null = null;

  constructor(private readonly registry: CommandRegistry<S>) {}

  tab(text: string, cursor: number): CompletionStep | null {
    const cycle = this.cycle;
    if (cycle && cycle.text === text && cycle.cursor === cursor) {
      const selected = (cycle.selected + 1) % cycle.candidates.length;
      const current = cycle.candidates[cycle.selected];
      const next = cycle.candidates[selected];
      return this.cycling(
        text.slice(0, cycle.from) + next + text.slice(cycle.from + current.length),
        cycle.from,
        cycle.candidates,
        selected,
      );
    }
    this.cycle = null;
    const completion = completeConsoleInput(this.registry, text, cursor);
    if (!completion) return null;
    const { from, to, prefix, candidates } = completion;
    const replace = (insert: string) => text.slice(0, from) + insert + text.slice(to);
    if (candidates.length === 1) {
      const needsSpace = text[to] !== ' ';
      const inserted = candidates[0] + (needsSpace ? ' ' : '');
      return {
        text: replace(inserted),
        cursor: from + inserted.length + (needsSpace ? 0 : 1),
        candidates: [],
        selected: -1,
      };
    }
    const common = commonPrefix(candidates);
    if (common.length > prefix.length) {
      return { text: replace(common), cursor: from + common.length, candidates, selected: -1 };
    }
    return this.cycling(replace(candidates[0]), from, candidates, 0);
  }

  /** Forgets any cycle in progress (after the line is submitted or replaced). */
  reset(): void {
    this.cycle = null;
  }

  private cycling(text: string, from: number, candidates: readonly string[], selected: number): CompletionStep {
    const cursor = from + candidates[selected].length;
    this.cycle = { from, candidates, selected, text, cursor };
    return { text, cursor, candidates, selected };
  }
}
