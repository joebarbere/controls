import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastStack } from '@controls/ui';
import { NotificationService } from './notification.service';

/** Binds {@link NotificationService} to the presentational toast stack. Place once, at the app root. */
@Component({
  selector: 'ctl-notifications',
  imports: [ToastStack],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ctl-toast-stack
    [toasts]="notifications.toasts()"
    (dismiss)="notifications.dismiss($event)"
    (held)="notifications.setHeld($event)"
  />`,
})
export class Notifications {
  protected readonly notifications = inject(NotificationService);
}
