import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CONSOLE_AVAILABLE_KEY } from '@controls/commands';
import { Session } from '@controls/feature-session';
import { Button } from '@controls/ui';
import { TabCompleter } from './completion';
import type { ConsoleEditor } from './console-editor';
import { cheatWarning, DevConsole, type PendingCheat } from './dev-console.service';
import { HistoryCursor } from './history';

const IDLE_HINT = 'Enter runs a line. ↑ and ↓ recall history, Tab completes, Escape or ` closes. Type help to start.';

/**
 * The dev console (plan F1.5), docked in the workspace's bottom panel: an output log, a one-line
 * CodeMirror 6 input and a Run file button. Every line goes through {@link DevConsole}, which runs
 * commands with `Session.exec`; nothing here changes the world.
 *
 * - **Gating:** `available` (from `isConsoleAvailable`) is published as the `console.available`
 *   context key, which gates `console.toggle` (the backtick key). When it is off the console shows a
 *   note instead of the input.
 * - **Keys in the input:** Enter runs, ↑/↓ walk the history (settings `console.history`), Tab
 *   completes ids, flags and enum values (on an empty line Tab moves focus on), Escape cancels a
 *   pending cheat or closes the console. Backtick is a global binding, so it closes the console
 *   from inside it too.
 * - **Files:** `run`, the Run file button or dropping a file runs a console-line file (data only).
 */
@Component({
  selector: 'ctl-dev-console',
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(dragover)': 'onDragOver($event)',
    '(drop)': 'onDrop($event)',
  },
  template: `
    @if (available()) {
      <div #log class="log" role="log" aria-label="Console output" tabindex="0" data-testid="console-output">
        @for (entry of console.entries(); track entry.id) {
          <div class="entry" [attr.data-kind]="entry.kind">
            @if (entry.kind === 'input') {
              <span class="prompt" aria-hidden="true">&gt; </span>
            }
            @if (entry.source !== undefined && entry.column !== undefined) {
              <code class="source">{{ entry.source }}</code>
              <span class="caret" aria-hidden="true">{{ caret(entry.column) }}</span>
            }
            <span class="text">{{ entry.text }}</span>
          </div>
        } @empty {
          <p class="ctl-hint">No output yet.</p>
        }
      </div>
      @if (console.pendingCheat(); as pending) {
        <div class="banner" role="alert" data-testid="console-cheat-banner">
          <p>{{ warning(pending) }}</p>
          <div class="banner-actions">
            <button ctlButton type="button" (click)="confirmCheat()">Run cheat</button>
            <button ctlButton="ghost" type="button" (click)="cancelCheat()">Cancel</button>
          </div>
        </div>
      }
      <div class="input-row">
        <span class="prompt" aria-hidden="true">&gt;</span>
        <!-- The workspace focuses [data-autofocus] on console.toggle; focus moves on into CodeMirror. -->
        <div
          #editorHost
          class="editor"
          tabindex="-1"
          data-autofocus
          [attr.data-editor]="editorReady() ? 'ready' : 'loading'"
          (focus)="focus()"
        ></div>
        <button ctlButton="ghost" type="button" (click)="pickFile()">Run file…</button>
        <input
          #fileInput
          type="file"
          accept=".console,.txt,text/plain"
          hidden
          aria-label="Console-line file to run"
          data-testid="console-file"
          (change)="fileChosen($event)"
        />
      </div>
      <p id="ctl-console-hint" class="hint" [attr.data-state]="hintState()">{{ hint() }}</p>
      <p class="ctl-visually-hidden" role="status">{{ announcement() }}</p>
    } @else {
      <p class="ctl-hint">The developer console is available in Sandbox and in dev builds.</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--ctl-space-1);
      flex: 1 1 auto;
      min-height: 0;
      font-family: var(--ctl-font-mono);
      font-size: 0.875rem;
    }
    .log {
      flex: 1 1 auto;
      min-height: 2.5rem;
      overflow-y: auto;
      padding: var(--ctl-space-1) var(--ctl-space-2);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface-raised);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .entry {
      display: flex;
      flex-direction: column;
    }
    .entry[data-kind='input'] {
      flex-direction: row;
      color: var(--ctl-fg-muted);
    }
    .entry[data-kind='error'] .text {
      color: var(--ctl-danger);
    }
    .entry[data-kind='warning'] .text {
      color: var(--ctl-warning);
    }
    .caret {
      color: var(--ctl-danger);
    }
    .banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--ctl-space-2);
      padding: var(--ctl-space-2);
      border: 2px solid var(--ctl-warning);
      border-radius: var(--ctl-radius);
      font-family: var(--ctl-font);
    }
    .banner p {
      flex: 1 1 20rem;
      margin: 0;
    }
    .banner-actions {
      display: flex;
      gap: var(--ctl-space-2);
    }
    .input-row {
      display: flex;
      align-items: center;
      gap: var(--ctl-space-2);
    }
    .editor {
      flex: 1 1 auto;
      min-width: 0;
    }
    .hint {
      margin: 0;
      color: var(--ctl-fg-muted);
      font-family: var(--ctl-font);
      font-size: 0.8125rem;
    }
    .hint[data-state='error'] {
      color: var(--ctl-danger);
    }
  `,
})
export class DevConsoleComponent {
  /** Whether the console is offered (`isConsoleAvailable`); published as `console.available`. */
  readonly available = input(false);

  protected readonly console = inject(DevConsole);
  private readonly session = inject(Session);
  private readonly editorHost = viewChild<ElementRef<HTMLElement>>('editorHost');
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly completer = new TabCompleter(this.session.registry);
  private readonly historyCursor = new HistoryCursor();
  private editor: ConsoleEditor | null = null;
  /** CodeMirror has loaded and the input exists (`data-editor="ready"` on its host). */
  protected readonly editorReady = signal(false);

  protected readonly hint = signal(IDLE_HINT);
  protected readonly hintState = signal<'idle' | 'error' | 'completions'>('idle');
  /** Tab completion results for screen readers (errors are announced by the output log). */
  protected readonly announcement = signal('');

  constructor() {
    // Session context is set imperatively (like the viewport's focus key); this mirrors the input.
    effect(() => this.session.setContext(CONSOLE_AVAILABLE_KEY, this.available() ? true : null));
    inject(DestroyRef).onDestroy(() => this.session.setContext(CONSOLE_AVAILABLE_KEY, null));

    // The CodeMirror view lives exactly as long as its host element. CodeMirror is loaded on first
    // use, so it stays out of the initial bundle.
    effect((onCleanup) => {
      const host = this.editorHost()?.nativeElement;
      if (!host) return;
      let editor: ConsoleEditor | null = null;
      let cancelled = false;
      void import('./console-editor').then(({ ConsoleEditor }) => {
        if (cancelled) return;
        editor = new ConsoleEditor(
          host,
          {
            submit: (text) => this.submit(text),
            historyUp: (text) => this.historyCursor.up(this.console.history(), text),
            historyDown: () => this.historyCursor.down(this.console.history()),
            complete: (text, cursor) => this.complete(text, cursor),
            escape: () => this.escape(),
            edited: () => this.edited(),
          },
          { label: 'Console input', describedBy: 'ctl-console-hint' },
        );
        this.editor = editor;
        this.editorReady.set(true);
        // Focus asked for while CodeMirror was loading lands on the host; move it into the input.
        if (host.ownerDocument.activeElement === host) editor.focus();
      });
      onCleanup(() => {
        cancelled = true;
        editor?.destroy();
        if (this.editor === editor) this.editor = null;
        this.editorReady.set(false);
      });
    });

    // Keep the newest output in view.
    effect(() => {
      this.console.entries();
      const log = this.log()?.nativeElement;
      if (log) queueMicrotask(() => (log.scrollTop = log.scrollHeight));
    });
  }

  /** Focuses the input (the workspace does this on `console.toggle`, through `data-autofocus`). */
  focus(): void {
    this.editor?.focus();
  }

  protected caret(column: number): string {
    return `${' '.repeat(Math.max(0, column - 1))}^`;
  }

  protected warning(pending: PendingCheat): string {
    return cheatWarning(pending);
  }

  protected confirmCheat(): void {
    this.console.confirmCheat();
    this.editor?.setText('');
    this.editor?.focus();
  }

  protected cancelCheat(): void {
    this.console.cancelCheat();
    this.editor?.focus();
  }

  protected pickFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  protected fileChosen(event: Event): void {
    const field = event.target as HTMLInputElement;
    const file = field.files?.[0];
    field.value = ''; // picking the same file again still fires `change`
    if (file) void this.console.runFile(file);
    this.editor?.focus();
  }

  protected onDragOver(event: DragEvent): void {
    if (!this.available() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  protected onDrop(event: DragEvent): void {
    const file = event.dataTransfer?.files[0];
    if (!this.available() || !file) return;
    event.preventDefault();
    void this.console.runFile(file);
  }

  private submit(text: string): void {
    this.completer.reset();
    this.historyCursor.reset();
    const outcome = this.console.submit(text);
    if (outcome.error) {
      this.editor?.markError(outcome.error.column);
      this.setHint(`Column ${outcome.error.column}: ${outcome.error.message}`, 'error');
    } else {
      this.setHint(IDLE_HINT, 'idle');
    }
    if (outcome.clear) this.editor?.setText('');
    // Chromium ignores a file input's click() inside the editor's Enter keydown; a task later it
    // opens (the key press's user activation is still live).
    if (outcome.pickFile) setTimeout(() => this.pickFile());
  }

  private complete(text: string, cursor: number): { text: string; cursor: number } | null {
    const step = this.completer.tab(text, cursor);
    if (!step) {
      this.setHint('Nothing to complete here.', 'completions');
      this.announcement.set('Nothing to complete.');
      return null;
    }
    if (step.candidates.length > 1) {
      const list = step.candidates.map((c, i) => (i === step.selected ? `[${c}]` : c)).join('  ');
      this.setHint(`${step.candidates.length} matches: ${list}`, 'completions');
      const selected = step.selected >= 0 ? `, ${step.candidates[step.selected]} inserted` : '';
      this.announcement.set(`${step.candidates.length} matches${selected}.`);
    } else {
      this.setHint(IDLE_HINT, 'idle');
      this.announcement.set(`Completed: ${step.text.trim()}`);
    }
    return step;
  }

  private escape(): boolean {
    if (this.console.pendingCheat()) {
      this.console.cancelCheat();
      return true;
    }
    if (this.hintState() !== 'idle') {
      this.editor?.markError(null);
      this.setHint(IDLE_HINT, 'idle');
      return true;
    }
    this.session.exec('console.toggle');
    return true;
  }

  private edited(): void {
    if (this.hintState() !== 'idle') {
      if (this.hintState() === 'error') this.editor?.markError(null);
      this.setHint(IDLE_HINT, 'idle');
    }
  }

  private setHint(text: string, state: 'idle' | 'error' | 'completions'): void {
    this.hint.set(text);
    this.hintState.set(state);
  }
}
