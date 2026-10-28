import { ChangeDetectionStrategy, Component, ElementRef, inject, model } from '@angular/core';
import type { SaveEntry } from '@controls/platform-api';
import { Button, Dialog } from '@controls/ui';
import { SaveGames } from './save-games';

const KIND_LABEL: Record<SaveEntry['kind'], string> = {
  manual: 'Saved game',
  autosave: 'Autosave',
  external: 'File',
};

/** `1234` → `1.2 KB` (decimal units, as file managers show them). */
export function formatSaveSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The Load game dialog (F1.8b): the saves in the save directory, newest first, as a list of buttons
 * (name, kind, time and size), plus Open file… for a save elsewhere (the native Open dialog, or an
 * upload in the web harness). Up/Down, Home and End move between saves; Tab reaches the actions.
 * Escape or Cancel closes it and focus returns to the opener.
 *
 * A save chosen from the list loads after the dialog has closed and returned focus (like the
 * palette), so the shell can move focus on. Open file… opens the picker inside the click (browsers
 * need the gesture) and keeps the dialog open if the player cancels it. Thumbnails aren't shown
 * yet: reading one means reading and unzipping the whole save.
 */
@Component({
  selector: 'ctl-load-game-dialog',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKeydown($event)' },
  template: `
    <ctl-dialog heading="Load game" [(open)]="open" (closed)="onClosed()">
      @if (saves.saves().length > 0) {
        <ul class="list" aria-label="Saved games">
          @for (entry of saves.saves(); track entry.handle; let i = $index) {
            <li>
              <button
                type="button"
                class="entry"
                data-testid="load-entry"
                [attr.aria-labelledby]="'ctl-load-name-' + i"
                [attr.aria-describedby]="'ctl-load-meta-' + i"
                (click)="choose(entry)"
              >
                <span class="name" [id]="'ctl-load-name-' + i">{{ entry.name }}</span>
                <span class="meta" [id]="'ctl-load-meta-' + i"
                  >{{ kindLabel(entry) }} · {{ time(entry) }} · {{ size(entry) }}</span
                >
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="empty">No saved games yet. Save a game from the menu, or open a save file.</p>
      }
      <button ctlButton type="button" ctlDialogActions (click)="openFile()">Open file…</button>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
    </ctl-dialog>
  `,
  styles: `
    .list {
      display: grid;
      gap: var(--ctl-space-1);
      min-width: min(420px, calc(100vw - 96px));
      max-height: min(420px, calc(100vh - 240px));
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .entry {
      display: grid;
      width: 100%;
      gap: 2px;
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface);
      color: var(--ctl-fg);
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .entry:hover {
      background: var(--ctl-surface-raised);
      border-color: var(--ctl-accent);
    }
    .name {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta {
      color: var(--ctl-fg-muted);
      font-size: 0.875rem;
      font-variant-numeric: tabular-nums;
    }
    .empty {
      margin: 0;
      color: var(--ctl-fg-muted);
    }
  `,
})
export class LoadGameDialog {
  readonly open = model(false);
  protected readonly saves = inject(SaveGames);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  private pending: SaveEntry | null = null;

  protected kindLabel(entry: SaveEntry): string {
    return KIND_LABEL[entry.kind];
  }

  protected time(entry: SaveEntry): string {
    return this.dateFormat.format(entry.modifiedMs);
  }

  protected size(entry: SaveEntry): string {
    return formatSaveSize(entry.sizeBytes);
  }

  protected choose(entry: SaveEntry): void {
    this.pending = entry;
    this.open.set(false);
  }

  protected async openFile(): Promise<void> {
    const picked = await this.saves.pickFile(); // opens the picker now, inside the click
    if (picked) this.choose(picked);
  }

  protected onClosed(): void {
    const entry = this.pending;
    this.pending = null;
    if (entry) void this.saves.load(entry);
  }

  /** Up/Down (wrapping), Home and End between the saves, like the main menu. */
  protected onKeydown(event: KeyboardEvent): void {
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.entry'));
    const current = items.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : event.key === 'ArrowUp'
          ? (current - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    items[next].focus();
  }
}
