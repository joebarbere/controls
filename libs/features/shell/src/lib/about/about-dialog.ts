import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import type { AppInfo } from '@controls/ipc-contract';
import { Button, Dialog } from '@controls/ui';

/**
 * About Controls. The `about-*` test ids are a contract with apps/game-e2e and apps/desktop-e2e;
 * the dialog keeps its content in the DOM while closed, so those suites can read them at boot.
 */
@Component({
  selector: 'ctl-about-dialog',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog heading="About Controls" [(open)]="open">
      <dl class="about" data-testid="about">
        <dt>Version</dt>
        <dd data-testid="about-version">{{ info()?.appVersion ?? '…' }}</dd>
        <dt>Platform</dt>
        <dd data-testid="about-platform">{{ platformLabel() }}</dd>
        <dt>Renderer</dt>
        <dd data-testid="about-backend">{{ backend() }}</dd>
        <dt>Isolated</dt>
        <dd data-testid="about-isolated">{{ isolated() ? 'yes' : 'no' }}</dd>
      </dl>
      <p class="ctl-hint">
        A realistic electrician to controls-engineer simulation. MIT licence; third-party notices ship with the app.
      </p>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Close</button>
    </ctl-dialog>
  `,
  styles: `
    .about {
      display: grid;
      grid-template-columns: auto auto;
      gap: var(--ctl-space-1) var(--ctl-space-4);
      margin: 0 0 var(--ctl-space-4);
    }
    dt {
      color: var(--ctl-fg-muted);
    }
    dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class AboutDialog {
  readonly open = model(false);
  readonly info = input<AppInfo>();
  /** Active render backend (`webgpu`/`webgl2`), or a status while starting. */
  readonly backend = input('starting…');
  /** Cross-origin isolated (SharedArrayBuffer available): see docs/caveats/electron.md. */
  readonly isolated = input(false);

  protected readonly platformLabel = computed(() => {
    const info = this.info();
    if (!info) return '…';
    return info.platform === 'web' ? 'web harness' : `${info.platform} · Electron ${info.versions.electron ?? '?'}`;
  });
}
