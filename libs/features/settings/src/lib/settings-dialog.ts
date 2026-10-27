import { ChangeDetectionStrategy, Component, model, output } from '@angular/core';
import { Button, Dialog } from '@controls/ui';
import { SettingsForm } from './settings-form';

/** The settings screen as a modal dialog. Back (or Escape) closes it and returns focus to the opener. */
@Component({
  selector: 'ctl-settings-dialog',
  imports: [Dialog, Button, SettingsForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog heading="Settings" description="Changes apply immediately." [(open)]="open" (closed)="closed.emit()">
      <ctl-settings-form />
      <button ctlButton="primary" type="button" ctlDialogActions (click)="open.set(false)">Back</button>
    </ctl-dialog>
  `,
})
export class SettingsDialog {
  readonly open = model(false);
  readonly closed = output<void>();
}
