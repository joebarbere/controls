import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject, input, output } from '@angular/core';
import { Button } from '@controls/ui';

/**
 * The main menu: a plain list of buttons (not an ARIA `menu`, which would need roving tabindex
 * and promise menu-bar semantics). Tab and Shift+Tab work as everywhere; Up/Down, Home and End move
 * between items too. The first item takes focus when the menu appears.
 *
 * Continue and Load stay focusable but `aria-disabled` (with a reason) until saves land in F1.8b,
 * so keyboard and screen-reader users can discover them.
 */
@Component({
  selector: 'ctl-main-menu',
  host: { '(keydown)': 'onKeydown($event)' },
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="menu" aria-labelledby="ctl-main-menu-title">
      <h1 id="ctl-main-menu-title" class="title">Controls</h1>
      <p class="tagline">From electrician to controls engineer.</p>
      <ul class="items">
        @if (sessionActive()) {
          <li><button ctlButton="primary" type="button" (click)="resumeGame.emit()">Resume</button></li>
        }
        <li>
          <button [ctlButton]="sessionActive() ? 'default' : 'primary'" type="button" (click)="newSandbox.emit()">
            New sandbox
          </button>
        </li>
        <li>
          <button ctlButton type="button" aria-disabled="true" aria-describedby="ctl-main-menu-saves">Continue</button>
        </li>
        <li>
          <button ctlButton type="button" aria-disabled="true" aria-describedby="ctl-main-menu-saves">Load</button>
        </li>
        <li><button ctlButton type="button" (click)="openSettings.emit()">Settings</button></li>
        <li><button ctlButton type="button" (click)="openAbout.emit()">About</button></li>
        @if (canQuit()) {
          <li><button ctlButton type="button" (click)="quitGame.emit()">Quit</button></li>
        }
      </ul>
      <p id="ctl-main-menu-saves" class="ctl-hint">Saving and loading arrive in a later build.</p>
    </nav>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      z-index: 10;
      display: flex;
      align-items: stretch;
      background: linear-gradient(90deg, var(--ctl-overlay) 0, var(--ctl-overlay) 360px, transparent 70%);
    }
    .menu {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: var(--ctl-space-3);
      width: 300px;
      padding: var(--ctl-space-6) 32px;
    }
    .title {
      margin: 0;
      font-size: 2.25rem;
      letter-spacing: 0.04em;
    }
    .tagline {
      margin: 0 0 var(--ctl-space-4);
      color: var(--ctl-fg-muted);
    }
    .items {
      display: grid;
      gap: var(--ctl-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .items button {
      width: 100%;
      min-height: 40px;
      justify-content: flex-start;
      font-size: 1.05rem;
    }
  `,
})
export class MainMenu {
  /** A sandbox is running: offer Resume first. */
  readonly sessionActive = input(false);
  /** The platform can end the app (desktop). The web harness has no Quit. */
  readonly canQuit = input(false);
  readonly resumeGame = output<void>();
  readonly newSandbox = output<void>();
  readonly openSettings = output<void>();
  readonly openAbout = output<void>();
  readonly quitGame = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => this.items()[0]?.focus());
  }

  protected onKeydown(event: KeyboardEvent): void {
    const items = this.items();
    const current = items.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const next = nextIndex(event.key, current, items.length);
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  }

  private items(): HTMLButtonElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.items button'));
  }
}

function nextIndex(key: string, current: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
