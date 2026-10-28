import { EditorSelection, EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap } from '@codemirror/view';

/*
 * The console's one-line CodeMirror 6 input (ADR 0008 "CodeMirror 6 in the in-game console"). It is
 * loaded with a dynamic `import()` by `DevConsoleComponent`, so CodeMirror stays out of the initial
 * bundle; don't export it from the package index or import it statically. Only
 * `@codemirror/state` and `@codemirror/view`: no language, no default keymap. Native contenteditable
 * editing covers typing, deleting and caret movement; the keys the console owns are bound here.
 * Nothing is evaluated: CodeMirror builds its DOM and styles itself (a `<style>` element, covered
 * by the CSP's `style-src 'unsafe-inline'`), and never needs `eval`.
 */

/** What the input asks of its owner. Each key handler returns whether it consumed the key. */
export interface ConsoleEditorHandlers {
  /** Enter. */
  submit(text: string): void;
  /** ↑ / ↓: the history line to show, or `null` to leave the input alone. */
  historyUp(text: string): string | null;
  historyDown(): string | null;
  /** Tab: the completed line and cursor, or `null` when there is nothing to complete. */
  complete(text: string, cursor: number): { readonly text: string; readonly cursor: number } | null;
  /** Escape. */
  escape(): boolean;
  /** Any edit by the player (clears an error mark). */
  edited(): void;
}

export interface ConsoleEditorOptions {
  readonly label: string;
  /** Ids of elements describing the input (hint, error). */
  readonly describedBy: string;
}

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: 'cm-console-error' });

/** The range of the word at a parse error, underlined until the next edit. */
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setError)) {
        return effect.value ? Decoration.set([errorMark.range(effect.value.from, effect.value.to)]) : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : marks.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Keeps the document on one line: pasted line breaks become spaces. */
const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const text = tr.newDoc.toString().replace(/\r?\n/g, ' ');
  return [
    tr,
    {
      changes: { from: 0, to: tr.newDoc.length, insert: text },
      selection: EditorSelection.cursor(Math.min(tr.newSelection.main.head, text.length)),
      sequential: true,
    },
  ];
});

const theme = EditorView.theme({
  '&': {
    color: 'var(--ctl-fg)',
    backgroundColor: 'var(--ctl-surface)',
    border: '1px solid var(--ctl-border)',
    borderRadius: 'var(--ctl-radius)',
    fontFamily: 'var(--ctl-font-mono)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', overflowX: 'auto' },
  '.cm-content': { padding: 'var(--ctl-space-1) var(--ctl-space-2)', caretColor: 'var(--ctl-fg)' },
  // The global `:focus-visible` outline loses to CodeMirror's own `.cm-content { outline: none }`.
  '.cm-content:focus-visible': { outline: '2px solid var(--ctl-focus)', outlineOffset: '-2px' },
  '.cm-cursor': { borderLeftColor: 'var(--ctl-fg)' },
  '.cm-console-error': { textDecoration: 'underline wavy var(--ctl-danger)', textUnderlineOffset: '3px' },
});

/** A one-line console input. */
export class ConsoleEditor {
  readonly view: EditorView;

  constructor(parent: HTMLElement, handlers: ConsoleEditorHandlers, options: ConsoleEditorOptions) {
    const text = () => this.view.state.doc.toString();
    const bindings = keymap.of([
      { key: 'Enter', run: () => (handlers.submit(text()), true) },
      { key: 'ArrowUp', run: () => this.show(handlers.historyUp(text())) },
      { key: 'ArrowDown', run: () => this.show(handlers.historyDown()) },
      {
        key: 'Tab',
        // An empty line lets Tab move focus on, so the input never traps the keyboard.
        run: () => {
          if (text().trim() === '') return false;
          const step = handlers.complete(text(), this.view.state.selection.main.head);
          if (step) this.setText(step.text, step.cursor);
          return true;
        },
      },
      { key: 'Escape', run: () => handlers.escape() },
    ]);
    const extensions: Extension[] = [
      bindings,
      singleLine,
      errorField,
      theme,
      EditorView.contentAttributes.of({
        'aria-label': options.label,
        'aria-multiline': 'false',
        'aria-describedby': options.describedBy,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      EditorView.contentAttributes.compute([errorField], (state) => ({
        'aria-invalid': state.field(errorField).size > 0 ? 'true' : 'false',
      })),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))
        ) {
          handlers.edited();
        }
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the line and puts the cursor at `cursor` (default: the end). */
  setText(text: string, cursor = text.length): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(Math.min(cursor, text.length)),
      scrollIntoView: true,
    });
  }

  /** Underlines the word at 1-based `column` and moves the cursor there; `null` clears the mark. */
  markError(column: number | null): void {
    if (column === null) {
      this.view.dispatch({ effects: setError.of(null) });
      return;
    }
    const doc = this.view.state.doc.toString();
    const from = Math.max(0, Math.min(column - 1, doc.length));
    let to = from;
    while (to < doc.length && doc[to] !== ' ' && doc[to] !== '\t') to++;
    if (to === from) to = Math.min(from + 1, doc.length);
    this.view.dispatch({
      effects: setError.of(to > from ? { from, to } : null),
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
    });
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private show(line: string | null): boolean {
    if (line === null) return false;
    this.setText(line);
    return true;
  }
}
