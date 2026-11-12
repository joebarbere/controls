import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';

/** One slot as the bar shows it. What the slot means is the caller's (world-model's belt rules). */
export interface ToolBeltBarSlot {
  /** 1-9. */
  readonly slot: number;
  /** What it holds, as the player sees it (`Wire strippers, …`, `Crate`, `Empty`). */
  readonly title: string;
  /** `placeable`, `tool`, `spool`, `empty` or `unknown`: styling only. */
  readonly kind: string;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  placeable: 'to place',
  tool: 'tool',
  spool: 'spool',
};

/**
 * The tool belt over the viewport (F3.4 part 1): nine slot buttons in an ARIA toolbar. Presentational:
 * a click or Enter/Space emits `selectSlot`, and the app runs the `toolbelt.select` view command, the
 * same command the number keys, the palette and the console run. The toolbar is one tab stop (roving
 * `tabindex`, on the active slot, else slot 1); Left/Right/Home/End move focus between slots without
 * selecting. Each button's name starts with its number (its visible text), then what it holds;
 * `aria-pressed` marks the active slot.
 */
@Component({
  selector: 'ctl-tool-belt-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="belt" role="toolbar" aria-label="Tool belt" aria-orientation="horizontal" data-testid="tool-belt">
      @for (s of slots(); track s.slot) {
        <button
          type="button"
          class="slot"
          [attr.data-kind]="s.kind"
          [attr.aria-pressed]="active() === s.slot"
          [attr.aria-label]="name(s)"
          [attr.aria-keyshortcuts]="s.slot"
          [attr.title]="name(s)"
          [tabIndex]="s.slot === tabStop() ? 0 : -1"
          (click)="choose(s.slot)"
          (keydown)="onKey($event, s.slot)"
        >
          {{ s.slot }}
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      pointer-events: auto;
    }
    .belt {
      display: flex;
      gap: var(--ctl-space-1);
      padding: var(--ctl-space-1);
      border-radius: var(--ctl-radius);
      background: var(--ctl-hud-bg);
    }
    .slot {
      min-width: 32px;
      height: 32px;
      padding: 0 var(--ctl-space-1);
      border: 1px solid var(--ctl-border);
      border-radius: var(--ctl-radius);
      background: var(--ctl-surface);
      color: var(--ctl-fg);
      font: inherit;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: background-color var(--ctl-duration) var(--ctl-easing);
    }
    .slot[data-kind='tool'] {
      border-style: double;
      border-width: 3px;
    }
    .slot[data-kind='empty'] {
      color: var(--ctl-fg-muted);
      border-style: dashed;
    }
    .slot[aria-pressed='true'] {
      background: var(--ctl-accent);
      border-color: var(--ctl-accent);
      color: var(--ctl-accent-fg);
    }
  `,
})
export class ToolBeltBar {
  /** The nine slots, in order. */
  readonly slots = input.required<readonly ToolBeltBarSlot[]>();
  /** The active slot (1-9), or `null`. */
  readonly active = input<number | null>(null);
  /** The player chose a slot: run `toolbelt.select`. */
  readonly selectSlot = output<number>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The roving tab stop: follows the active slot, and the arrow keys move it. */
  protected readonly tabStop = linkedSignal(() => this.active() ?? 1);
  private readonly count = computed(() => this.slots().length);

  protected name(s: ToolBeltBarSlot): string {
    const kind = KIND_LABELS[s.kind];
    return `${s.slot}: ${s.title}${kind ? ` (${kind})` : ''}`;
  }

  protected choose(slot: number): void {
    this.tabStop.set(slot);
    this.selectSlot.emit(slot);
  }

  protected onKey(event: KeyboardEvent, slot: number): void {
    const count = this.count();
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = slot === count ? 1 : slot + 1;
        break;
      case 'ArrowLeft':
        next = slot === 1 ? count : slot - 1;
        break;
      case 'Home':
        next = 1;
        break;
      case 'End':
        next = count;
        break;
      default:
        return;
    }
    // Consumed here: the keybinding service ignores handled keys, so no viewport binding also runs.
    event.preventDefault();
    this.tabStop.set(next);
    this.host.nativeElement.querySelectorAll<HTMLButtonElement>('button')[next - 1]?.focus();
  }
}
