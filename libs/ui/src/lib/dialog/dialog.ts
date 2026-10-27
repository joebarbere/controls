import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  model,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { FocusTrap } from '../focus/focus-trap';
import { focusableElements, restoreFocus } from '../focus/focusable';

let nextId = 0;

/**
 * Modal dialog on the native `<dialog>` element. `showModal()` puts it in the top layer and makes
 * the rest of the page inert; on top of that the dialog:
 * - moves focus to the first `[autofocus]` or focusable element when it opens;
 * - closes on Escape (keeping `open` in sync, unlike a bare native cancel);
 * - returns focus to whatever was focused before it opened.
 *
 * Content stays in the DOM while closed (hidden by the browser), so projected content keeps its
 * state and test ids between openings.
 */
@Component({
  selector: 'ctl-dialog',
  host: { '(keydown.escape)': 'onEscape($event)' },
  imports: [FocusTrap],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="dialog"
      [attr.aria-labelledby]="titleId"
      [attr.aria-describedby]="description() ? descriptionId : null"
      [ctlFocusTrap]="open()"
      (cancel)="onCancel($event)"
    >
      <h2 class="title" [id]="titleId">{{ heading() }}</h2>
      @if (description()) {
        <p class="description" [id]="descriptionId">{{ description() }}</p>
      }
      <div class="body"><ng-content /></div>
      <div class="actions"><ng-content select="[ctlDialogActions]" /></div>
    </dialog>
  `,
  styles: `
    .dialog {
      max-width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: var(--ctl-space-6);
      border: 1px solid var(--ctl-border);
      border-radius: calc(var(--ctl-radius) * 2);
      background: var(--ctl-surface);
      color: var(--ctl-fg);
      box-shadow: 0 16px 48px rgb(0 0 0 / 35%);
    }
    .dialog::backdrop {
      background: var(--ctl-backdrop);
    }
    .title {
      margin: 0 0 var(--ctl-space-3);
      font-size: 1.25rem;
    }
    .description {
      margin: 0 0 var(--ctl-space-4);
      color: var(--ctl-fg-muted);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--ctl-space-2);
      margin-top: var(--ctl-space-6);
    }
    .actions:empty {
      display: none;
    }
  `,
})
export class Dialog {
  /** Visible title; also the dialog's accessible name. */
  readonly heading = input.required<string>();
  readonly description = input<string>();
  /** Two-way: `[(open)]`. Closing from inside (Escape) writes `false` back. */
  readonly open = model(false);
  /** Emitted after the dialog closes and focus has been restored. */
  readonly closed = output<void>();

  protected readonly titleId = `ctl-dialog-title-${nextId}`;
  protected readonly descriptionId = `ctl-dialog-desc-${nextId++}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private returnFocusTo: Element | null = null;
  private shown = false;

  constructor() {
    // Syncing a signal to an imperative DOM API is what render effects are for.
    afterRenderEffect({
      write: () => {
        const open = this.open();
        untracked(() => (open ? this.show() : this.hide()));
      },
    });
  }

  /** Closes the dialog (same as Escape). */
  close(): void {
    this.open.set(false);
  }

  protected onEscape(event: Event): void {
    event.preventDefault(); // handled here, so the document-level Escape (e.g. open the menu) doesn't also fire
    event.stopPropagation();
    this.close();
  }

  protected onCancel(event: Event): void {
    event.preventDefault(); // keep `open` the single source of truth
    this.close();
  }

  private show(): void {
    if (this.shown) return;
    const el = this.dialog().nativeElement;
    this.returnFocusTo = el.ownerDocument.activeElement;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', ''); // jsdom has no showModal
    this.shown = true;
    const target = el.querySelector<HTMLElement>('[autofocus]') ?? focusableElements(el)[0];
    target?.focus();
  }

  private hide(): void {
    if (!this.shown) return;
    const el = this.dialog().nativeElement;
    if (typeof el.close === 'function') el.close();
    else el.removeAttribute('open');
    this.shown = false;
    restoreFocus(this.returnFocusTo);
    this.returnFocusTo = null;
    this.closed.emit();
  }
}
