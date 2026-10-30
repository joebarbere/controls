import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import { KeybindingsEditor } from './keybindings-editor';

/**
 * The rebinding screen as a modal dialog, opened from Settings → Key bindings…. It is a sibling of
 * the settings dialog, not nested inside it, so its Escape and focus trap never reach the settings
 * dialog; closing it returns focus to the Key bindings… button.
 *
 * The rebinding table is rendered only while the dialog is open. It is ~100 buttons, and the dialog
 * sits in the shell from start-up: kept mounted, it was recomputed on every keymap change and made
 * every accessibility-tree walk over the page (the menu, screen readers, `getByRole` in tests)
 * several times slower — see docs/caveats/ui.md. Reopening rebuilds it from the keymap; a pending
 * capture never survives closing anyway (it stops on blur).
 */
@Component({
  selector: 'ctl-keybindings-dialog',
  imports: [Dialog, Button, KeybindingsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog
      heading="Key bindings"
      description="Changes apply immediately. Choose Change, then press the new keys; Escape cancels."
      [(open)]="open"
    >
      @if (open()) {
        <ctl-keybindings-editor />
      }
      <button ctlButton="primary" type="button" ctlDialogActions (click)="open.set(false)">Back</button>
    </ctl-dialog>
  `,
})
export class KeybindingsDialog {
  readonly open = model(false);
}
