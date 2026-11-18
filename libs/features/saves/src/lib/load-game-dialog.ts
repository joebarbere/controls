import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  model,
  signal,
  untracked,
} from '@angular/core';
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

/** A thumbnail belongs to one version of a save: a rewrite under the same handle changes its time. */
const thumbnailKey = (entry: SaveEntry) => `${entry.handle}:${entry.modifiedMs}`;

/**
 * The Load game dialog (F1.8b, P4 Saves): the saves in the save directory, newest first, each a
 * button (thumbnail, name, kind, time and size) with a Delete button beside it, plus Open file… for a
 * save elsewhere (the native Open dialog, or an upload in the web harness). Up/Down, Home and End
 * move between saves; Tab reaches each save's Delete and then the actions. Escape or Cancel closes it
 * and focus returns to the opener.
 *
 * A save chosen from the list loads after the dialog has closed and returned focus (like the
 * palette), so the shell can move focus on. Open file… opens the picker inside the click (browsers
 * need the gesture) and keeps the dialog open if the player cancels it.
 *
 * **Delete** (or the Delete key on a save) turns that row into a confirmation, focused on Keep:
 * Delete removes the save, Keep or Escape goes back to the row's Delete button (Escape there never
 * closes the dialog). After a delete, focus moves to the save that took its place, else the one
 * before, else Open file…, so it never falls to the page.
 *
 * **Thumbnails** load one by one while the dialog is open (`SaveGames.thumbnail` reads only the
 * thumbnail entry of each save); a save without one shows an empty frame. They are `blob:` URLs
 * (CSP `img-src 'self' data: blob:`), revoked when the dialog closes.
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
            <li class="row" data-testid="load-row">
              @if (confirming() === entry.handle) {
                <div class="confirm" role="group" [attr.aria-labelledby]="'ctl-load-confirm-' + i">
                  <span class="question" [id]="'ctl-load-confirm-' + i"
                    >Delete “{{ entry.name }}”? This can’t be undone.</span
                  >
                  <span class="choices">
                    <button
                      ctlButton
                      type="button"
                      class="danger"
                      data-testid="load-delete-confirm"
                      [attr.aria-disabled]="deleting() ? 'true' : null"
                      (click)="confirmDelete(entry, i)"
                      (keydown.escape)="cancelDelete($event, i)"
                    >
                      Delete
                    </button>
                    <button
                      ctlButton="primary"
                      type="button"
                      class="keep"
                      data-testid="load-delete-cancel"
                      [attr.aria-disabled]="deleting() ? 'true' : null"
                      (click)="cancelDelete($event, i)"
                      (keydown.escape)="cancelDelete($event, i)"
                    >
                      Keep
                    </button>
                  </span>
                </div>
              } @else {
                <button
                  type="button"
                  class="entry"
                  data-testid="load-entry"
                  [attr.aria-labelledby]="'ctl-load-name-' + i"
                  [attr.aria-describedby]="'ctl-load-meta-' + i"
                  (click)="choose(entry)"
                >
                  <span class="thumb">
                    @if (thumbnailUrl(entry); as url) {
                      <img [src]="url" alt="" width="96" height="54" data-testid="load-thumbnail" />
                    }
                  </span>
                  <span class="text">
                    <span class="name" [id]="'ctl-load-name-' + i">{{ entry.name }}</span>
                    <span class="meta" [id]="'ctl-load-meta-' + i"
                      >{{ kindLabel(entry) }} · {{ time(entry) }} · {{ size(entry) }}</span
                    >
                  </span>
                </button>
                <button
                  ctlButton="ghost"
                  type="button"
                  class="delete"
                  data-testid="load-delete"
                  [attr.aria-label]="'Delete ' + entry.name"
                  (click)="askDelete(entry)"
                >
                  Delete
                </button>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty">No saved games yet. Save a game from the menu, or open a save file.</p>
      }
      <button ctlButton type="button" ctlDialogActions class="open-file" (click)="openFile()">Open file…</button>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
    </ctl-dialog>
  `,
  styles: `
    .list {
      display: grid;
      gap: var(--ctl-space-1);
      min-width: min(480px, calc(100vw - 96px));
      max-height: min(420px, calc(100vh - 240px));
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: stretch;
      gap: var(--ctl-space-1);
    }
    .entry {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      width: 100%;
      gap: var(--ctl-space-3);
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
    .thumb {
      display: block;
      width: 96px;
      height: 54px;
      overflow: hidden;
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface-raised);
    }
    .thumb img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .text {
      display: grid;
      gap: 2px;
      min-width: 0;
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
    .confirm {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--ctl-space-2);
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border: 1px solid var(--ctl-danger);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface);
    }
    .question {
      overflow-wrap: anywhere;
    }
    .choices {
      display: flex;
      gap: var(--ctl-space-2);
    }
    .danger {
      color: var(--ctl-danger);
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
  private readonly injector = inject(Injector);
  private readonly dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  private pending: SaveEntry | null = null;

  /** The handle of the save whose row asks "Delete …?", if any. */
  protected readonly confirming = signal<string | null>(null);
  /** A confirmed delete is running: its buttons are inert until it is done. */
  protected readonly deleting = signal(false);
  /** `blob:` URLs of loaded thumbnails (`null`: the save has none), by {@link thumbnailKey}. */
  private readonly thumbnails = signal<ReadonlyMap<string, string | null>>(new Map());

  constructor() {
    // Loads thumbnails for the listed saves while the dialog is open; a new listing restarts the walk
    // (already loaded ones are kept), closing stops it.
    effect((onCleanup) => {
      if (!this.open()) return;
      const entries = this.saves.saves();
      let stopped = false;
      onCleanup(() => (stopped = true));
      void untracked(() => this.loadThumbnails(entries, () => stopped));
    });
    inject(DestroyRef).onDestroy(() => this.releaseThumbnails());
  }

  protected kindLabel(entry: SaveEntry): string {
    return KIND_LABEL[entry.kind];
  }

  protected time(entry: SaveEntry): string {
    return this.dateFormat.format(entry.modifiedMs);
  }

  protected size(entry: SaveEntry): string {
    return formatSaveSize(entry.sizeBytes);
  }

  protected thumbnailUrl(entry: SaveEntry): string | null {
    return this.thumbnails().get(thumbnailKey(entry)) ?? null;
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
    this.confirming.set(null);
    this.releaseThumbnails();
    const entry = this.pending;
    this.pending = null;
    if (entry) void this.saves.load(entry);
  }

  /** Turns `entry`'s row into the confirmation, focused on Keep (the safe choice). */
  protected askDelete(entry: SaveEntry): void {
    if (this.deleting()) return;
    const index = this.saves.saves().indexOf(entry);
    this.confirming.set(entry.handle);
    this.focusAfterRender(() => this.row(index)?.querySelector<HTMLElement>('.keep') ?? null);
  }

  /** Keep or Escape: back to the row, focus on its Delete button. Escape never reaches the dialog. */
  protected cancelDelete(event: Event, index: number): void {
    if (event.type === 'keydown') {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.deleting()) return;
    this.confirming.set(null);
    this.focusAfterRender(() => this.row(index)?.querySelector<HTMLElement>('.delete') ?? null);
  }

  /** Deletes the save, then focuses the save that took its place, else the one before, else Open file…. */
  protected async confirmDelete(entry: SaveEntry, index: number): Promise<void> {
    if (this.deleting()) return;
    this.deleting.set(true);
    let deleted = false;
    try {
      deleted = await this.saves.delete(entry); // lists again before it resolves
    } finally {
      this.deleting.set(false);
      this.confirming.set(null);
    }
    if (!this.open()) return;
    this.focusAfterRender(() => {
      if (!deleted) return this.row(index)?.querySelector<HTMLElement>('.delete') ?? null;
      const entries = this.entryButtons();
      return entries[Math.min(index, entries.length - 1)] ?? this.host.nativeElement.querySelector('.open-file');
    });
  }

  /** Up/Down (wrapping), Home and End between the saves, like the main menu; Delete asks to delete one. */
  protected onKeydown(event: KeyboardEvent): void {
    const items = this.entryButtons();
    const current = items.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    if (event.key === 'Delete') {
      const rows = Array.from(this.host.nativeElement.querySelectorAll('.row'));
      const entry = this.saves.saves()[rows.indexOf((event.target as HTMLElement).closest('.row') as Element)];
      if (entry) {
        event.preventDefault();
        this.askDelete(entry);
      }
      return;
    }
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

  private entryButtons(): HTMLButtonElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.entry'));
  }

  private row(index: number): HTMLElement | null {
    return this.host.nativeElement.querySelectorAll<HTMLElement>('.row')[index] ?? null;
  }

  /** Focuses what `find` returns once the change just made has rendered (the old target is gone by then). */
  private focusAfterRender(find: () => HTMLElement | null): void {
    afterNextRender({ write: () => find()?.focus() }, { injector: this.injector });
  }

  private async loadThumbnails(entries: readonly SaveEntry[], stopped: () => boolean): Promise<void> {
    for (const entry of entries) {
      const key = thumbnailKey(entry);
      if (stopped()) return;
      if (this.thumbnails().has(key)) continue;
      const png = await this.saves.thumbnail(entry);
      if (stopped()) return;
      const url =
        png === null ? null : URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
      this.thumbnails.update((map) => new Map(map).set(key, url));
    }
  }

  private releaseThumbnails(): void {
    for (const url of this.thumbnails().values()) if (url !== null) URL.revokeObjectURL(url);
    this.thumbnails.set(new Map());
  }
}
