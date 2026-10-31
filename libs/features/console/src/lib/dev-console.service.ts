import { computed, inject, Injectable, signal } from '@angular/core';
import { splitConsoleLines } from '@controls/commands';
import { KeybindingService, Session } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import {
  type ConsoleTarget,
  describeExecError,
  formatConsoleScriptError,
  runConsoleScript,
} from '@controls/scripting-api';
import { consoleHelp } from './help';
import { appendHistory } from './history';
import { resolveConsoleLine } from './interpret';

/** Output entries kept (the oldest are dropped). UI state only. */
export const MAX_CONSOLE_OUTPUT = 500;
/** Largest console-line file `run` reads. 10,000 lines (the script cap) of typical length fit easily. */
export const MAX_CONSOLE_FILE_BYTES = 1024 * 1024;

export type ConsoleEntryKind = 'input' | 'output' | 'error' | 'warning';

/** One line of console output. `source` and `column` mark where an error is. */
export interface ConsoleEntry {
  readonly id: number;
  readonly kind: ConsoleEntryKind;
  readonly text: string;
  readonly source?: string;
  readonly column?: number;
}

/** A cheat waiting for the player to confirm it (plan F1.5: warn before it marks the save assisted). */
export type PendingCheat =
  | { readonly kind: 'line'; readonly source: string; readonly id: string; readonly args: Record<string, unknown> }
  | { readonly kind: 'file'; readonly name: string; readonly text: string; readonly ids: readonly string[] };

/** What the input should do after a submit. */
export interface SubmitOutcome {
  /** Clear the input (the line ran, or was handled). */
  readonly clear: boolean;
  /** A parse or mapping error to mark in the input, at its 1-based column. */
  readonly error: { readonly column: number; readonly message: string } | null;
  /** `run` with no file: open the file picker. */
  readonly pickFile: boolean;
}

const done = (pickFile = false): SubmitOutcome => ({ clear: true, error: null, pickFile });

function firstColumn(source: string): number {
  return source.length - source.trimStart().length + 1;
}

/**
 * The dev console's state and interpreter (plan F1.5, ADR 0008). Lines are parsed with the shared
 * console grammar and run through `Session.exec`, so a console line, a palette form, a key and a
 * script all reach the same registry. Console words (`help`, `run`, `clear`, `world.hash`) are
 * read-only and never logged. Output and the pending cheat are UI state; history is a player
 * preference in settings (`console.history`, capped by {@link appendHistory}).
 */
@Injectable({ providedIn: 'root' })
export class DevConsole {
  private readonly session = inject(Session);
  private readonly settings = inject(SettingsStore);
  private readonly keybindings = inject(KeybindingService);
  private readonly output = signal<readonly ConsoleEntry[]>([]);
  private readonly pending = signal<PendingCheat | null>(null);
  private readonly running = signal(false);
  private nextId = 1;

  readonly entries = this.output.asReadonly();
  /** A cheat waiting for confirmation; the console shows a warning banner while set. */
  readonly pendingCheat = this.pending.asReadonly();
  /** Submitted lines, oldest first (settings `console.history`). */
  readonly history = computed(() => this.settings.settings().console.history);
  readonly registry = this.session.registry;
  /**
   * A console-line file is running (ADR 0011 §9.4): pacing is held, the console is `aria-busy` and
   * refuses input until it finishes, since a `world.hash` line waits for the sim worker.
   */
  readonly busy = this.running.asReadonly();

  /** The console target for console-line files: the same `exec` and `hash` the input uses. */
  private readonly target: ConsoleTarget = {
    registry: this.session.registry,
    exec: (id, args) => this.session.exec(id, args),
    hash: () => this.session.hashAt(),
  };

  /** Runs one typed line. */
  submit(source: string): SubmitOutcome {
    if (this.running()) return { clear: false, error: null, pickFile: false }; // busy: refused, kept in the input
    const pending = this.pending();
    if (pending?.kind === 'line' && pending.source === source) {
      this.confirmCheat();
      return done();
    }
    if (pending) this.cancelCheat();

    const action = resolveConsoleLine(this.session.registry, source);
    if (action.kind === 'blank') return { clear: true, error: null, pickFile: false };
    this.remember(source);
    this.push({ kind: 'input', text: source });
    switch (action.kind) {
      case 'error':
        this.push({ kind: 'error', text: `Column ${action.column}: ${action.message}`, source, column: action.column });
        return { clear: false, error: { column: action.column, message: action.message }, pickFile: false };
      case 'clear':
        this.output.set([]);
        return done();
      case 'help': {
        const help = consoleHelp(this.session.registry, action.id, (id) =>
          this.keybindings.chordsOf(id).map((chord) => this.keybindings.label(chord)),
        );
        if (help.ok) for (const text of help.lines) this.push({ kind: 'output', text });
        else this.push({ kind: 'error', text: help.message });
        return done();
      }
      case 'run':
        this.push({ kind: 'output', text: 'Pick a console-line file (.console), or drop one on the console.' });
        return done(true);
      case 'query': {
        // A round trip to the sim worker: a placeholder now, the hash when it arrives.
        const id = this.push({ kind: 'output', text: 'world.hash: computing…' });
        this.session.hashAt().then(
          (hash) => this.replace(id, { kind: 'output', text: hash }),
          () =>
            this.replace(id, {
              kind: 'error',
              text: 'world.hash: the simulation didn’t answer (restart it if it crashed).',
            }),
        );
        return done();
      }
      case 'command':
        if (action.cheat && !this.session.world().assisted) {
          this.hold({ kind: 'line', source, id: action.id, args: action.args });
          return { clear: false, error: null, pickFile: false };
        }
        this.exec(source, action.id, action.args);
        return done();
    }
  }

  /** Runs a console-line file the player picked or dropped (data only: never evaluated as code). */
  async runFile(file: Pick<File, 'name' | 'size' | 'text'>): Promise<void> {
    if (this.running()) return;
    this.cancelCheat();
    this.push({ kind: 'input', text: `run ${file.name}` });
    if (file.size > MAX_CONSOLE_FILE_BYTES) {
      this.push({ kind: 'error', text: `${file.name} is larger than ${MAX_CONSOLE_FILE_BYTES / 1024} KiB` });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.push({ kind: 'error', text: `${file.name} could not be read` });
      return;
    }
    const ids = cheatIds(this.session.registry, text);
    if (ids.length > 0 && !this.session.world().assisted) {
      this.hold({ kind: 'file', name: file.name, text, ids });
      return;
    }
    await this.runText(file.name, text);
  }

  /** Runs the pending cheat (the banner's Run button, or Enter on the same line). */
  confirmCheat(): void {
    const pending = this.pending();
    if (!pending) return;
    this.pending.set(null);
    if (pending.kind === 'line') this.exec(pending.source, pending.id, pending.args);
    else void this.runText(pending.name, pending.text);
  }

  /** Drops the pending cheat without running it. */
  cancelCheat(): void {
    if (!this.pending()) return;
    this.pending.set(null);
    this.push({ kind: 'output', text: 'Cheat cancelled; nothing ran.' });
  }

  private hold(pending: PendingCheat): void {
    this.pending.set(pending);
    this.push({ kind: 'warning', text: cheatWarning(pending) });
  }

  private exec(source: string, id: string, args: Record<string, unknown>): void {
    const result = this.session.exec(id, args);
    if (result.ok) {
      this.push({
        kind: 'output',
        text: result.logged ? `${id}: ok (log #${result.entry.seq})` : `${id}: ok (not logged)`,
      });
    } else {
      const column = firstColumn(source);
      this.push({ kind: 'error', text: describeExecError(result.error), source, column });
    }
  }

  private async runText(name: string, text: string): Promise<void> {
    this.running.set(true);
    const release = this.session.sim.hold(); // no pacing while a script runs (ADR 0011 §9.4)
    let result: Awaited<ReturnType<typeof runConsoleScript>>;
    try {
      result = await runConsoleScript(this.target, text);
    } catch {
      this.push({
        kind: 'error',
        text: `${name}: the simulation didn’t answer a world.hash line (restart it if it crashed).`,
      });
      return;
    } finally {
      release();
      this.running.set(false);
    }
    for (const line of result.output) this.push({ kind: 'output', text: line });
    const ran = `${result.executed} command${result.executed === 1 ? '' : 's'}`;
    if (result.ok) {
      this.push({ kind: 'output', text: `Ran ${ran} from ${name}.` });
    } else {
      this.push({ kind: 'error', text: `${name}, ${formatConsoleScriptError(result.error)} (${ran} ran before it)` });
    }
  }

  private remember(source: string): void {
    const history = this.history();
    const next = appendHistory(history, source);
    if (next !== history) this.settings.update('console', { history: [...next] });
  }

  private push(entry: Omit<ConsoleEntry, 'id'>): number {
    const id = this.nextId++;
    this.output.update((entries) => {
      const next = [...entries, { ...entry, id }];
      return next.length > MAX_CONSOLE_OUTPUT ? next.slice(next.length - MAX_CONSOLE_OUTPUT) : next;
    });
    return id;
  }

  /** Fills in an entry pushed earlier (a placeholder), if it is still shown. */
  private replace(id: number, entry: Omit<ConsoleEntry, 'id'>): void {
    this.output.update((entries) => entries.map((e) => (e.id === id ? { ...entry, id } : e)));
  }
}

/** The banner text. Exported for the component, which shows it while a cheat is pending. */
export function cheatWarning(pending: PendingCheat): string {
  const what =
    pending.kind === 'line'
      ? `${pending.id} is a cheat`
      : `${pending.name} runs ${pending.ids.length === 1 ? 'a cheat' : 'cheats'} (${pending.ids.join(', ')})`;
  const how =
    pending.kind === 'line'
      ? 'Press Enter again or choose Run cheat to go ahead; Escape or Cancel stops it.'
      : 'Choose Run cheat to go ahead; Escape or Cancel stops it.';
  return `${what}: running it marks this save as assisted, permanently. ${how}`;
}

/** Ids of cheat commands a console-line file would run (lines that don't resolve are left to the runner). */
function cheatIds(registry: Session['registry'], text: string): string[] {
  const ids = new Set<string>();
  for (const { source } of splitConsoleLines(text)) {
    const action = resolveConsoleLine(registry, source);
    if (action.kind === 'command' && action.cheat) ids.add(action.id);
  }
  return [...ids].sort();
}
