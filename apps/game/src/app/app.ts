import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import { PLATFORM } from './platform.token';
import { Viewport } from './viewport/viewport';

@Component({
  selector: 'ctl-root',
  imports: [Viewport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-viewport class="viewport" (backendChange)="backend.set($event)" />
    <header class="hud">
      <h1>Controls</h1>
      <dl class="about" data-testid="about">
        <dt>Version</dt>
        <dd data-testid="about-version">{{ info.value()?.appVersion ?? '…' }}</dd>
        <dt>Platform</dt>
        <dd data-testid="about-platform">{{ platformLabel() }}</dd>
        <dt>Renderer</dt>
        <dd data-testid="about-backend">{{ backend() }}</dd>
        <dt>Isolated</dt>
        <dd data-testid="about-isolated">{{ isolated ? 'yes' : 'no' }}</dd>
      </dl>
    </header>
  `,
  styleUrl: './app.scss',
})
export class App {
  private readonly platform = inject(PLATFORM);
  protected readonly info = resource({ loader: () => this.platform.getAppInfo() });
  protected readonly backend = signal<string>('starting…');
  /** SharedArrayBuffer (sim worker snapshots) needs cross-origin isolation — see docs/caveats/electron.md. */
  protected readonly isolated = globalThis.crossOriginIsolated === true;

  protected platformLabel(): string {
    const info = this.info.value();
    if (!info) return '…';
    return info.platform === 'web' ? 'web harness' : `${info.platform} · Electron ${info.versions.electron ?? '?'}`;
  }
}
