import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import { KeybindingsEditor } from './keybindings-editor';

/**
 * The rebinding screen as a modal dialog, opened from Settings → Key bindings…. It is a sibling of
 * the settings dialog, not nested inside it, so its Escape and focus trap never reach the settings
 * dialog; closing it returns focus to the Key bindings… button.
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
      <ctl-keybindings-editor />
      <button ctlButton="primary" type="button" ctlDialogActions (click)="open.set(false)">Back</button>
    </ctl-dialog>
  `,
})
export class KeybindingsDialog {
  readonly open = model(false);
}
