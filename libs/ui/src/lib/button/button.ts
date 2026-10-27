import { Directive, input } from '@angular/core';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

/** Styles a native `<button>` with the design tokens. Keep using the native element: it brings keyboard and ARIA for free. */
@Directive({
  selector: 'button[ctlButton], a[ctlButton]',
  host: {
    class: 'ctl-button',
    '[class.ctl-button--primary]': "variant() === 'primary'",
    '[class.ctl-button--ghost]': "variant() === 'ghost'",
  },
})
export class Button {
  /** `<button ctlButton>` (empty) is the default variant. */
  readonly variant = input<ButtonVariant | ''>('default', { alias: 'ctlButton' });
}
