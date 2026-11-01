import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { Button } from '@controls/ui';

/**
 * The main menu: a plain list of buttons (not an ARIA `menu`, which would need roving tabindex
 * and promise menu-bar semantics). Tab and Shift+Tab work as everywhere; Up/Down, Home and End move
 * between items too. The first item takes focus when the menu appears.
 *
 * With a game running the menu offers Resume and Save game first. Continue resumes the game last
 * played (F1.8b); with no saves it stays focusable but `aria-disabled`, with the reason, so keyboard and
 * screen-reader users can still discover it. Load lists the saves (and can open a file), so it is
 * always available.
 *
 * After a renderer crash (`recovered`, ADR 0011 §10) the menu says so in an alert above the items and
 * focuses Continue instead, which then resumes the latest autosave.
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
      @if (recovered()) {
        <p id="ctl-main-menu-recovery" class="recovery" role="alert">
          Controls stopped unexpectedly and was restarted. Continue resumes your latest autosave.
        </p>
      }
      <ul class="items">
        @if (sessionActive()) {
          <li><button ctlButton="primary" type="button" (click)="resumeGame.emit()">Resume</button></li>
          <li>
            <button ctlButton type="button" aria-haspopup="dialog" (click)="saveGame.emit()">Save game</button>
          </li>
        }
        <li>
          <button [ctlButton]="sessionActive() ? 'default' : 'primary'" type="button" (click)="newSandbox.emit()">
            New sandbox
          </button>
        </li>
        <li>
          <!-- One element either way, so focus survives the save list arriving. -->
          <button
            ctlButton
            type="button"
            [attr.aria-disabled]="canContinue() ? null : 'true'"
            [attr.aria-describedby]="continueDescription()"
            data-item="continue"
            (click)="canContinue() && continueGame.emit()"
          >
            Continue
          </button>
        </li>
        <li>
          <button ctlButton type="button" aria-haspopup="dialog" (click)="loadGame.emit()">Load</button>
        </li>
        <li><button ctlButton type="button" (click)="openSettings.emit()">Settings</button></li>
        <li><button ctlButton type="button" (click)="openAbout.emit()">About</button></li>
        @if (canQuit()) {
          <li><button ctlButton type="button" (click)="quitGame.emit()">Quit</button></li>
        }
      </ul>
      @if (!canContinue()) {
        <p id="ctl-main-menu-saves" class="ctl-hint">No saved games yet.</p>
      }
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
    .recovery {
      margin: 0;
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border-left: 3px solid var(--ctl-danger);
      background: var(--ctl-surface);
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
  /** There is a save to continue from (F1.8b). */
  readonly canContinue = input(false);
  /** The host restarted the page after a renderer crash: show the notice and focus Continue. */
  readonly recovered = input(false);
  readonly resumeGame = output<void>();
  readonly saveGame = output<void>();
  readonly newSandbox = output<void>();
  readonly continueGame = output<void>();
  readonly loadGame = output<void>();
  readonly openSettings = output<void>();
  readonly openAbout = output<void>();
  readonly quitGame = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Continue is described by the recovery notice and, with no saves, by the reason it is unavailable. */
  protected readonly continueDescription = computed(
    () =>
      [this.recovered() ? 'ctl-main-menu-recovery' : null, this.canContinue() ? null : 'ctl-main-menu-saves']
        .filter((id) => id !== null)
        .join(' ') || null,
  );

  constructor() {
    afterNextRender(() => {
      const items = this.items();
      (this.recovered() ? items.find((b) => b.dataset['item'] === 'continue') : items[0])?.focus();
    });
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
