import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  InjectionToken,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Button, Dialog } from '@controls/ui';

/** Largest world seed (ADR 0007: an unsigned 32-bit integer). */
export const MAX_SEED = 0xffff_ffff;

/**
 * Where a fresh seed comes from. Domain code can't draw one (no `Math.random` or `crypto` there, for
 * determinism), so the UI does: `crypto.getRandomValues` by default. Tests provide a fixed source.
 */
export const SEED_SOURCE = new InjectionToken<() => number>('controls.seedSource', {
  providedIn: 'root',
  factory: () => () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0],
});

/** A typed seed: decimal digits only (surrounding spaces allowed), 0…4294967295. `null` if invalid. */
export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_SEED ? n : null;
}

/**
 * The new-game dialog (F1.9): New sandbox opens it with a fresh seed, which the player can keep,
 * re-roll or replace with one they type (the same seed and the same commands give the same world
 * hash, so a typed seed reproduces a session). The seed field is the dialog's first control, so it
 * has focus when the dialog opens. Enter in the seed field (the form's only text field,
 * so the browser submits it) or Start starts; Escape or Cancel cancels.
 * `start` is emitted after the dialog has closed and returned focus, so the shell can move focus on.
 */
@Component({
  selector: 'ctl-new-game-dialog',
  imports: [Dialog, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-dialog heading="New sandbox" [(open)]="open" (closed)="onClosed()">
      <form class="form" novalidate (submit)="submit($event)">
        <p class="level">
          Level: <strong>{{ levelName() }}</strong>
        </p>
        <div class="ctl-field">
          <label for="ctl-new-game-seed">Seed</label>
          <span class="row">
            <input
              id="ctl-new-game-seed"
              class="ctl-input"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              data-testid="new-game-seed"
              [value]="seedText()"
              [attr.aria-invalid]="error() ? 'true' : null"
              aria-describedby="ctl-new-game-seed-hint ctl-new-game-seed-error"
              (input)="edit($event)"
            />
            <button ctlButton type="button" (click)="reroll()">New seed</button>
          </span>
        </div>
        <p id="ctl-new-game-seed-hint" class="ctl-hint">
          A whole number from 0 to {{ maxSeed }}. The same seed starts the same world.
        </p>
        <p id="ctl-new-game-seed-error" class="error" role="alert">{{ error() ?? '' }}</p>
      </form>
      <button ctlButton type="button" ctlDialogActions (click)="open.set(false)">Cancel</button>
      <button ctlButton="primary" type="button" ctlDialogActions (click)="submit()">Start</button>
    </ctl-dialog>
  `,
  styles: `
    .form {
      display: grid;
      gap: var(--ctl-space-2);
      min-width: min(360px, calc(100vw - 96px));
    }
    .level {
      margin: 0 0 var(--ctl-space-2);
    }
    .row {
      display: flex;
      gap: var(--ctl-space-2);
    }
    .row input {
      flex: 1;
      font-variant-numeric: tabular-nums;
    }
    .ctl-hint,
    .error {
      margin: 0;
    }
    .error {
      min-height: 1.4em;
      color: var(--ctl-danger);
    }
  `,
})
export class NewGameDialog {
  readonly open = model(false);
  /** Display name of the level a new sandbox loads. */
  readonly levelName = input('Workshop');
  /** The validated seed, emitted once the dialog has closed. */
  readonly start = output<number>();

  protected readonly maxSeed = MAX_SEED;
  protected readonly seedText = signal('');
  private readonly submitted = signal(false);
  protected readonly error = computed(() =>
    this.submitted() && parseSeed(this.seedText()) === null ? `Enter a whole number from 0 to ${MAX_SEED}.` : null,
  );
  private readonly seedSource = inject(SEED_SOURCE);
  private pending: number | null = null;

  constructor() {
    // Each opening offers a fresh seed.
    effect(() => {
      if (this.open()) untracked(() => this.reroll());
    });
  }

  protected reroll(): void {
    this.seedText.set(String(this.seedSource() >>> 0));
    this.submitted.set(false);
  }

  protected edit(event: Event): void {
    this.seedText.set((event.target as HTMLInputElement).value);
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.submitted.set(true);
    const seed = parseSeed(this.seedText());
    if (seed === null) return;
    this.pending = seed;
    this.open.set(false);
  }

  protected onClosed(): void {
    const seed = this.pending;
    this.pending = null;
    this.submitted.set(false);
    if (seed !== null) this.start.emit(seed);
  }
}
