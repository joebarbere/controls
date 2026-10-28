import {
  MAX_CONSOLE_HISTORY,
  MAX_CONSOLE_LINE_LENGTH as MAX_HISTORY_LINE_LENGTH,
  SafeString,
} from '@controls/save-format';

/** A history line the settings schema accepts (`console.history` items). */
const HistoryLine = SafeString.min(1).max(MAX_HISTORY_LINE_LENGTH);

/**
 * `history` (oldest first) with `line` appended, as settings `console.history` stores it. The
 * writer trims (ui caveats: one over-cap field makes the whole settings file fall back):
 *
 * - blank lines and a repeat of the newest line are skipped;
 * - lines longer than the schema's 2000 characters, or that aren't well-formed UTF-16, are not
 *   kept (they still ran);
 * - beyond 200 lines the oldest are dropped.
 */
export function appendHistory(history: readonly string[], line: string): readonly string[] {
  if (line.trim() === '' || history[history.length - 1] === line) return history;
  if (!HistoryLine.safeParse(line).success) return history;
  const next = [...history, line];
  return next.length > MAX_CONSOLE_HISTORY ? next.slice(next.length - MAX_CONSOLE_HISTORY) : next;
}

/**
 * ↑/↓ through the history, like a shell. Leaving the newest entry with ↓ gives back the line that
 * was being typed before ↑ was first pressed.
 */
export class HistoryCursor {
  /** Index into the history; `null` when not navigating (at the draft). */
  private index: number | null = null;
  private draft = '';

  /** The older line for ↑, or `null` at the oldest (or with no history). */
  up(history: readonly string[], current: string): string | null {
    if (history.length === 0) return null;
    if (this.index === null) {
      this.draft = current;
      this.index = history.length;
    }
    if (this.index === 0) return null;
    this.index = Math.min(this.index, history.length) - 1;
    return history[this.index];
  }

  /** The newer line for ↓, the draft past the newest, or `null` when not navigating. */
  down(history: readonly string[]): string | null {
    if (this.index === null) return null;
    this.index++;
    if (this.index >= history.length) {
      this.index = null;
      return this.draft;
    }
    return history[this.index];
  }

  /** Back to the draft position (after a line is submitted). */
  reset(): void {
    this.index = null;
    this.draft = '';
  }
}
