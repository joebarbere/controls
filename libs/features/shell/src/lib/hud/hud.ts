import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { InteractionMode } from '../shell-state';

const MODE_LABELS: Record<InteractionMode, string> = { walk: 'Walk', work: 'Work', editor: 'Editor' };

/**
 * Heads-up display over the viewport: interaction mode, a selection summary and the **Assisted**
 * badge (shown once a cheat command has run; the world's `assisted` flag arrives with F1.2/F1.3).
 * The selection and the badge sit in polite live regions, so changes are announced.
 */
@Component({
  selector: 'ctl-hud',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="hud" aria-label="Status" data-testid="viewport-status">
      <dl>
        <dt>Mode</dt>
        <dd data-testid="hud-mode">{{ modeLabel() }}</dd>
        <dt>Selection</dt>
        <dd data-testid="hud-selection" aria-live="polite">{{ selection() ?? 'Nothing selected' }}</dd>
      </dl>
      <div aria-live="polite">
        @if (assisted()) {
          <span class="badge" data-testid="hud-assisted">Assisted</span>
          <span class="ctl-visually-hidden">: a cheat command has run in this world.</span>
        }
      </div>
    </section>
  `,
  styles: `
    .hud {
      display: grid;
      gap: var(--ctl-space-1);
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border-radius: var(--ctl-radius);
      background: var(--ctl-hud-bg);
      color: var(--ctl-hud-fg);
      font-size: 0.8rem;
    }
    dl {
      display: grid;
      grid-template-columns: auto auto;
      gap: 2px var(--ctl-space-3);
      margin: 0;
    }
    dt {
      color: var(--ctl-fg-muted);
    }
    dd {
      margin: 0;
    }
    .badge {
      display: inline-block;
      padding: 1px var(--ctl-space-2);
      border: 1px solid var(--ctl-warning);
      border-radius: 999px;
      color: var(--ctl-warning);
      font-weight: 600;
    }
  `,
})
export class Hud {
  readonly mode = input.required<InteractionMode>();
  /** One-line summary of the selection (the renderer's selection label), or null when nothing is selected. */
  readonly selection = input<string | null>(null);
  /** The current world is assisted. TODO(F1.2): from the world's `assisted` flag. */
  readonly assisted = input(false);

  protected readonly modeLabel = computed(() => MODE_LABELS[this.mode()]);
}
