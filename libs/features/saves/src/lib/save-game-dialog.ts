import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  model,
  signal,
  untracked,
} from '@angular/core';
import { SaveNameSchema } from '@controls/ipc-contract';
import { Session } from '@controls/feature-session';
import { Button, Dialog } from '@controls/ui';
import { SaveGames, suggestedSaveName } from './save-games';

/** Why a typed save name can't be used, or `null` if it can. */
export function saveNameError(name: string): string | null {
  if (name.length === 0) return 'Enter a name for the save.';
  const parsed = SaveNameSchema.safeParse(name);
  if (parsed.success) return null;
  if (parsed.error.issues.some((issue) => issue.message === 'reserved name'))
    return 'That name is reserved by Windows. Choose another.';
  if (name.length > 64) return 'Use at most 64 characters.';
  return 'Start with a letter or digit, and use only letters, digits, spaces and . , ( ) ’ & + ! # [ ] _ -';
}

/**
 * The Save game dialog (F1.8b): names a manual save. It opens on the game's save name (or a
 * suggestion), selected so typing replaces it. Enter or Save saves; saving over another save asks
 * first (the button becomes Replace); saving over this game's own save doesn't. Escape or Cancel
 * closes it without saving and focus returns to the opener. The save runs after the dialog has
 * closed; its result is a notification.
 */
@Component({
  selector: 'ctl-save-game-dialog',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog heading="Save game" [(open)]="open" (closed)="onClosed()">
      <form class="form" novalidate (submit)="submit($event)">
        <div class="ctl-field">
          <label for="ctl-save-name">Save name</label>
          <input
            id="ctl-save-name"
            class="ctl-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            maxlength="64"
            [value]="name()"
            [attr.aria-invalid]="error() ? 'true' : null"
            aria-describedby="ctl-save-name-hint ctl-save-name-message"
            (input)="edit($event)"
            (focus)="select($event)"
          />
        </div>
        <p id="ctl-save-name-hint" class="ctl-hint">Saved games are listed under Load in the main menu.</p>
        <p id="ctl-save-name-message" class="message" [class.error]="error()" role="alert">{{ message() }}</p>
      </form>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
      <button ctlButton="primary" type="button" ctlDialogActions (click)="submit()">
        {{ replacing() ? 'Replace' : 'Save' }}
      </button>
    </ctl-dialog>
  `,
  styles: `
    .form {
      display: grid;
      gap: var(--ctl-space-2);
      min-width: min(360px, calc(100vw - 96px));
    }
    .ctl-hint,
    .message {
      margin: 0;
    }
    .message {
      min-height: 1.4em;
    }
    .message.error {
      color: var(--ctl-danger);
    }
  `,
})
export class SaveGameDialog {
  readonly open = model(false);
  private readonly saves = inject(SaveGames);
  private readonly session = inject(Session);

  /** The typed name; reset to the game's save name (or a suggestion) each time the dialog opens. */
  protected readonly name = linkedSignal({
    source: this.open,
    // Untracked: only opening resets it, not a command changing the world while the dialog is up.
    computation: () => untracked(() => this.saves.saveName() ?? suggestedSaveName(this.session.world().seed)),
  });
  private readonly submitted = linkedSignal({ source: this.open, computation: () => false });
  /** The name the player has been asked about once: submitting it again replaces that save. */
  private readonly confirmed = linkedSignal<boolean, string | null>({ source: this.open, computation: () => null });
  private readonly trimmed = computed(() => this.name().trim());
  protected readonly error = computed(() => (this.submitted() ? saveNameError(this.trimmed()) : null));
  /** Another save already has this name (compared without case: Windows and macOS file names ignore it). */
  private readonly clashes = computed(() => {
    const name = this.trimmed().toLowerCase();
    const own = this.saves.saveName()?.toLowerCase();
    return name !== own && this.saves.saves().some((e) => e.kind === 'manual' && e.name.toLowerCase() === name);
  });
  protected readonly replacing = computed(() => this.clashes() && this.confirmed() === this.trimmed());
  protected readonly message = computed(() => {
    const error = this.error();
    if (error) return error;
    return this.replacing() ? `A save named “${this.trimmed()}” exists. Replace it?` : '';
  });
  private readonly pending = signal<{ name: string; overwrite: boolean } | null>(null);

  protected edit(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected select(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    const name = this.trimmed();
    if (saveNameError(name) !== null) return;
    if (this.clashes() && this.confirmed() !== name) {
      this.confirmed.set(name); // ask first; the next Save or Enter replaces it
      return;
    }
    // Overwrite this game's own save, or one the player agreed to replace; otherwise main refuses an existing name.
    this.pending.set({
      name,
      overwrite: this.clashes() || name.toLowerCase() === this.saves.saveName()?.toLowerCase(),
    });
    this.open.set(false);
  }

  protected onClosed(): void {
    const pending = this.pending();
    this.pending.set(null);
    if (pending) void this.saves.saveNamed(pending.name, pending.overwrite);
  }
}
