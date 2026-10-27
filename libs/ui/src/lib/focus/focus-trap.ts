import { Directive, ElementRef, inject, input } from '@angular/core';
import { focusableElements } from './focusable';

/**
 * Keeps Tab and Shift+Tab inside the host while `ctlFocusTrap` is true, wrapping at either end.
 * A modal `<dialog>` already makes the page behind it inert; the trap also covers non-dialog
 * overlays and keeps Tab from escaping into browser chrome in the web harness.
 */
@Directive({
  selector: '[ctlFocusTrap]',
  host: { '(keydown.tab)': 'onTab($event, false)', '(keydown.shift.tab)': 'onTab($event, true)' },
})
export class FocusTrap {
  readonly enabled = input(true, { alias: 'ctlFocusTrap' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected onTab(event: Event, backwards: boolean): void {
    if (!this.enabled()) return;
    const items = focusableElements(this.host.nativeElement);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.host.nativeElement.ownerDocument.activeElement;
    const outside = !this.host.nativeElement.contains(active);
    if (backwards && (active === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!backwards && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  }
}
