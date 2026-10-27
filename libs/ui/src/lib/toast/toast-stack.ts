import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
} from '@angular/core';
import { restoreFocus } from '../focus/focusable';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly level: ToastLevel;
}

/**
 * Renders notifications in two live regions that exist before any toast arrives (a region added
 * together with its content is not announced): `role="status"` (polite) for info and success,
 * `role="alert"` (assertive) for warnings and errors.
 *
 * Each toast has a Dismiss button; Escape inside the stack dismisses the focused toast. Focus then
 * moves to a neighbouring toast, or back to where it was before it entered the stack.
 * `held` is true while the pointer or focus is inside, so the owner can pause auto-dismiss.
 */
@Component({
  selector: 'ctl-toast-stack',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(focusin)': 'onFocusIn($event)',
    '(focusout)': 'onFocusOut($event)',
    '(pointerenter)': 'pointerInside = true; emitHeld()',
    '(pointerleave)': 'pointerInside = false; emitHeld()',
  },
  template: `
    <section class="stack" aria-label="Notifications">
      <div class="region" role="status" aria-live="polite">
        @for (toast of polite(); track toast.id) {
          <ng-container *ngTemplateOutlet="item; context: { $implicit: toast }" />
        }
      </div>
      <div class="region" role="alert" aria-live="assertive">
        @for (toast of assertive(); track toast.id) {
          <ng-container *ngTemplateOutlet="item; context: { $implicit: toast }" />
        }
      </div>
    </section>
    <ng-template #item let-toast>
      <div class="toast" [attr.data-level]="toast.level" [attr.data-toast-id]="toast.id">
        <span class="message">{{ toast.message }}</span>
        <button
          type="button"
          class="ctl-button ctl-button--ghost dismiss"
          [attr.aria-label]="'Dismiss notification: ' + toast.message"
          (click)="dismissToast(toast.id)"
          (keydown.escape)="dismissToast(toast.id); $event.stopPropagation()"
        >
          Dismiss
        </button>
      </div>
    </ng-template>
  `,
  styles: `
    :host {
      position: fixed;
      right: var(--ctl-space-4);
      bottom: var(--ctl-space-4);
      z-index: 20;
      width: min(380px, calc(100vw - 32px));
    }
    .stack,
    .region {
      display: grid;
      gap: var(--ctl-space-2);
    }
    .toast {
      display: flex;
      align-items: center;
      gap: var(--ctl-space-3);
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border: 1px solid var(--ctl-border);
      border-left: 4px solid var(--ctl-accent);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface);
      color: var(--ctl-fg);
      box-shadow: 0 6px 18px rgb(0 0 0 / 25%);
      animation: enter var(--ctl-duration) var(--ctl-easing);
    }
    .toast[data-level='success'] {
      border-left-color: var(--ctl-success);
    }
    .toast[data-level='warning'] {
      border-left-color: var(--ctl-warning);
    }
    .toast[data-level='error'] {
      border-left-color: var(--ctl-danger);
    }
    .message {
      flex: 1;
    }
    @keyframes enter {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
    }
  `,
  imports: [NgTemplateOutlet],
})
export class ToastStack {
  readonly toasts = input<readonly Toast[]>([]);
  readonly dismiss = output<number>();
  /** True while the pointer or keyboard focus is inside the stack. */
  readonly held = output<boolean>();

  protected readonly polite = computed(() => this.toasts().filter((t) => t.level === 'info' || t.level === 'success'));
  protected readonly assertive = computed(() =>
    this.toasts().filter((t) => t.level === 'warning' || t.level === 'error'),
  );

  protected pointerInside = false;
  private focusInside = false;
  private returnFocusTo: Element | null = null;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected dismissToast(id: number): void {
    const root = this.host.nativeElement;
    const hadFocus = root.contains(root.ownerDocument.activeElement);
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('.dismiss'));
    const index = buttons.findIndex(
      (b) => b.closest<HTMLElement>('[data-toast-id]')?.dataset['toastId'] === String(id),
    );
    this.dismiss.emit(id);
    if (!hadFocus) return;
    const returnTo = this.returnFocusTo;
    afterNextRender(
      () => {
        const remaining = Array.from(root.querySelectorAll<HTMLElement>('.dismiss'));
        const neighbour = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
        if (neighbour) neighbour.focus();
        else restoreFocus(returnTo);
      },
      { injector: this.injector },
    );
  }

  protected onFocusIn(event: FocusEvent): void {
    // Remember only real outside elements: when a focused toast is removed, focus passes through
    // <body> and the next focusin has no relatedTarget, which must not erase the return target.
    const from = event.relatedTarget;
    if (from instanceof Element && !this.host.nativeElement.contains(from)) this.returnFocusTo = from;
    this.focusInside = true;
    this.emitHeld();
  }

  protected onFocusOut(event: FocusEvent): void {
    const to = event.relatedTarget;
    if (to instanceof Node && this.host.nativeElement.contains(to)) return;
    this.focusInside = false;
    this.emitHeld();
  }

  protected emitHeld(): void {
    this.held.emit(this.pointerInside || this.focusInside);
  }
}
