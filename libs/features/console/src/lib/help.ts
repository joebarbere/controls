import { type CommandRegistry, type ConsoleField, consoleFields } from '@controls/commands';
import { consoleIds } from './completion';
import { CONSOLE_WORDS } from './interpret';

/*
 * `help [id]` (plan F1.5), generated from the registry: ids, titles, categories, keybindings, `when`
 * and the args schema through `consoleFields`. Nothing here is a hand-written command list.
 */

/** The player-facing keys of a binding id (`Ctrl+Z`), from the keybinding service. */
export type ChordLabels = (id: string) => readonly string[];

export type HelpResult =
  { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };

function valueLabel(field: ConsoleField): string {
  const base = (() => {
    switch (field.kind) {
      case 'number':
        if (field.min !== null && field.max !== null) return `${field.min}..${field.max}`;
        if (field.min !== null) return `number >= ${field.min}`;
        if (field.max !== null) return `number <= ${field.max}`;
        return 'number';
      case 'boolean':
        return 'true|false';
      case 'enum':
        return field.values.map(String).join('|');
      case 'string':
        return 'text';
      default:
        return 'value';
    }
  })();
  return field.nullable ? `${base}|null` : base;
}

function usage(id: string, fields: readonly ConsoleField[]): string {
  const parts = fields.map((field) => {
    const word = field.position !== null ? `<${field.path}>` : `--${field.path} <${valueLabel(field)}>`;
    return field.optional ? `[${word}]` : word;
  });
  return [id, ...parts].join(' ');
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(1, width - text.length));

/** `help` with no id: every command (id, title, keys) and the console's own words. */
function overview<S>(registry: CommandRegistry<S>, chords: ChordLabels): string[] {
  const defs = registry.list();
  const width = Math.max(...consoleIds(registry).map((id) => id.length)) + 2;
  const lines = ['Commands (Tab completes ids, flags and values; help <id> shows one):'];
  for (const def of defs) {
    const keys = chords(def.id);
    const flags = [def.cheat ? 'cheat' : '', keys.length ? keys.join(', ') : ''].filter(Boolean);
    lines.push(`  ${pad(def.id, width)}${def.title}${flags.length ? `  [${flags.join('; ')}]` : ''}`);
  }
  lines.push('Console words (not logged):');
  for (const [word, { summary }] of Object.entries(CONSOLE_WORDS)) {
    if (registry.has(word)) continue;
    lines.push(`  ${pad(word, width)}${summary}`);
  }
  return lines;
}

/** One command or console word in detail. */
function detail<S>(registry: CommandRegistry<S>, id: string, chords: ChordLabels): HelpResult {
  const def = registry.get(id);
  if (!def) {
    const word = Object.prototype.hasOwnProperty.call(CONSOLE_WORDS, id) ? CONSOLE_WORDS[id] : undefined;
    if (!word) return { ok: false, message: `Unknown command "${id}" (help lists them all)` };
    return { ok: true, lines: [`${id}: ${word.summary}.`, `Usage: ${word.usage}`] };
  }
  const fields = consoleFields(def.args);
  const keys = chords(def.id);
  const lines = [`${def.id}: ${def.title} (${def.category})`, `Usage: ${usage(def.id, fields)}`];
  if (fields.length > 0) {
    lines.push('Arguments:');
    const width = Math.max(...fields.map((f) => f.path.length)) + 4;
    for (const field of fields) {
      const notes = [
        valueLabel(field),
        field.optional ? 'optional' : 'required',
        field.position !== null ? `or positional #${field.position + 1}` : '',
        field.description ?? '',
      ].filter(Boolean);
      lines.push(`  ${pad(`--${field.path}`, width)}${notes.join('; ')}`);
    }
  } else {
    lines.push('Arguments: none');
  }
  lines.push(`Keys: ${keys.length ? keys.join(', ') : 'none'}`);
  if (def.when) lines.push(`When: ${def.when}`);
  lines.push(`Undoable: ${def.undoable ? 'yes' : 'no'}`);
  if (def.cheat) lines.push('Cheat: running it marks the save as assisted, permanently.');
  return { ok: true, lines };
}

/** The text of `help` (no id) or `help <id>`. */
export function consoleHelp<S>(
  registry: CommandRegistry<S>,
  id: string | null,
  chords: ChordLabels = () => [],
): HelpResult {
  return id === null ? { ok: true, lines: overview(registry, chords) } : detail(registry, id, chords);
}
