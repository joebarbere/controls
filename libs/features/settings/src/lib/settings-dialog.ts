import { ChangeDetectionStrategy, Component, linkedSignal, model, output } from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import { KeybindingsDialog } from './keybindings-dialog';
import { SettingsForm } from './settings-form';

/**
 * The settings screen as a modal dialog. Back (or Escape) closes it and returns focus to the opener.
 * Key bindings… opens the rebinding dialog on top (a sibling dialog, so Escape there closes only it).
 * The form is rendered only while the dialog is open (it keeps no state: `SettingsStore` does);
 * closed, its controls were candidates in every role query of the shell (ui caveats).
 */
@Component({
  selector: 'ctl-settings-dialog',
  imports: [Dialog, Button, SettingsForm, KeybindingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog heading="Settings" description="Changes apply immediately." [(open)]="open" (closed)="closed.emit()">
      @if (open()) {
        <ctl-settings-form (openKeybindings)="keybindingsOpen.set(true)" />
      }
      <button ctlButton="primary" type="button" ctlDialogActions (click)="open.set(false)">Back</button>
    </ctl-dialog>
    <ctl-keybindings-dialog [(open)]="keybindingsOpen" />
  `,
})
export class SettingsDialog {
  readonly open = model(false);
  readonly closed = output<void>();
  /** Resets whenever settings opens or closes, so closing settings also closes the dialog on top. */
  protected readonly keybindingsOpen = linkedSignal({ source: this.open, computation: () => false });
}
