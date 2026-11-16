import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  type Signal,
  untracked,
} from '@angular/core';
import { CONSOLE_AVAILABLE_KEY } from '@controls/commands';
import { Session, SimHost } from '@controls/feature-session';
import type { ViewportState, WireRef } from '@controls/renderer';
import { sameWireReadout, WireReadoutSampler, type WireReadoutView, wireTitle } from './wire-readout-model';

/** Where the panel sits: the top-right corner, or the bottom-left while the pointer is under the top right. */
export type WireReadoutCorner = 'top-right' | 'bottom-left';

/** What the viewport template needs from the wire readout. */
export interface WireReadout {
  /** The readout to show, or `null` (no wire hovered or selected, not work mode, or no console). */
  readonly view: Signal<WireReadoutView | null>;
  /** The polite live region's text: set when a wire is selected, never on hover or as values change. */
  readonly announcement: Signal<string>;
  /** The panel's corner, away from the pointer. */
  readonly corner: Signal<WireReadoutCorner>;
}

const sameWire = (a: WireRef | null, b: WireRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

/** Room kept between the pointer and the panel (CSS px, game-design). */
const POINTER_CLEARANCE_PX = 24;
/** The bottom-left corner's offset from the bottom (CSS px, the panel's `bottom: 2.5rem`): above the dev frame-time HUD. */
const BOTTOM_LEFT_OFFSET_PX = 40;

/**
 * Connects the wire readout (F3.6 part 3) in the viewport's injection context. Shown in work mode
 * while the console is available (`console.available`, plan D16: a debug aid until P5), for the
 * hovered wire, else the selected one. The sampler reads each sim snapshot allocation-free and the
 * readout signal changes only when what it shows changes at display resolution. Selecting a wire (a
 * click, or N / Shift+N) announces it once through the polite live region. The panel never takes
 * the pointer (`pointer-events: none`) and moves to the other corner when the pointer is under it.
 */
export function connectWireReadout(state: Signal<ViewportState | undefined>): WireReadout {
  const session = inject(Session);
  const sim = inject(SimHost);
  const destroyRef = inject(DestroyRef);
  const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  const sampler = new WireReadoutSampler();

  const enabled = computed(() => session.contextKeys()[CONSOLE_AVAILABLE_KEY] === true && state()?.mode === 'work');
  const hovered = computed(() => state()?.hoveredWire ?? null, { equal: sameWire });
  const selected = computed(() => state()?.selectedWire ?? null, { equal: sameWire });
  const target = computed(() => (enabled() ? (hovered() ?? selected()) : null), { equal: sameWire });
  const source = computed(() => (hovered() !== null ? 'hover' : 'selection'));
  /** Bumped when the target's values change at display resolution. */
  const revision = signal(0);
  destroyRef.onDestroy(
    sim.subscribe((snapshot) => {
      if (sampler.update(snapshot, target())) revision.update((n) => n + 1);
    }),
  );
  const view = computed(
    () => {
      revision();
      const t = target();
      return t === null ? null : sampler.format(t, session.world(), source());
    },
    { equal: sameWireReadout },
  );
  // Only a new selection is announced (never a hover, a value change or a mode switch); without the
  // readout (walk mode, no console) it is still named, so a keyboard player hears what N selected.
  const announcement = computed(() => {
    const t = selected();
    if (t === null) return '';
    return untracked(() =>
      enabled() ? sampler.summary(t, session.world()) : `${wireTitle(t, session.world())} selected.`,
    );
  });

  const corner = signal<WireReadoutCorner>('top-right');
  // The pointer's last position over the viewport (client px), kept in plain fields: a native listener
  // (not a template binding), so pointer moves never run change detection; the corner signal changes
  // only when the pointer is under the panel's corner.
  let pointerX = 0;
  let pointerY = 0;
  let pointerIn = false;
  const place = () => {
    const panel = host.querySelector<HTMLElement>('ctl-wire-readout');
    if (panel === null || !pointerIn) return;
    const rect = host.getBoundingClientRect();
    const x = pointerX - rect.left;
    const y = pointerY - rect.top;
    const w = panel.offsetWidth + POINTER_CLEARANCE_PX;
    const h = panel.offsetHeight + POINTER_CLEARANCE_PX;
    if (corner() === 'top-right' && x >= host.clientWidth - w && y <= h) corner.set('bottom-left');
    else if (corner() === 'bottom-left' && x <= w && y >= host.clientHeight - h - BOTTOM_LEFT_OFFSET_PX) {
      corner.set('top-right');
    }
  };
  const onMove = (e: PointerEvent) => {
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerIn = true;
    place();
  };
  const onLeave = () => {
    pointerIn = false;
  };
  host.addEventListener('pointermove', onMove, { passive: true });
  host.addEventListener('pointerleave', onLeave, { passive: true });
  destroyRef.onDestroy(() => {
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerleave', onLeave);
  });
  // The panel appears a frame after the pointer stops on a wire (hover is picked on the next frame), so
  // the pointer may already be under it: place it once it is rendered and has a size.
  const shown = computed(() => view() !== null);
  afterRenderEffect(() => {
    if (shown()) untracked(place);
  });

  return { view, announcement, corner: corner.asReadonly() };
}

/**
 * The wire readout panel (F3.6 part 3): one wire's current, its conductor's and each end's drop and
 * temperature, and its state, as text. Presentational and read-only: nothing in it takes focus or the
 * pointer. Not a live region (its values change as the sim runs); the viewport announces a selection.
 */
@Component({
  selector: 'ctl-wire-readout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="readout"
      [attr.aria-label]="'Wire readout: ' + readout().title"
      data-testid="wire-readout"
      [attr.data-source]="readout().source"
    >
      <h2>{{ readout().title }}</h2>
      @if (readout().parts.length > 0) {
        <p data-testid="wire-readout-current">Current {{ readout().current }}</p>
        <table>
          <thead>
            <tr>
              <th scope="col"><span class="ctl-visually-hidden">Part</span></th>
              <th scope="col">Drop</th>
              <th scope="col">Temperature</th>
            </tr>
          </thead>
          <tbody>
            @for (part of readout().parts; track part.key) {
              <tr [attr.data-testid]="'wire-readout-' + part.key">
                <th scope="row">{{ part.name }}</th>
                @if (part.terminated) {
                  <td>{{ part.drop }}</td>
                  <td>{{ part.temperature }}</td>
                } @else {
                  <td colspan="2">no termination</td>
                }
              </tr>
            }
          </tbody>
        </table>
      }
      <p data-testid="wire-readout-state">State: {{ readout().state }}</p>
    </section>
  `,
  styles: `
    :host {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      max-width: min(18rem, 45%);
      pointer-events: none;
    }
    :host([data-corner='bottom-left']) {
      top: auto;
      right: auto;
      bottom: 2.5rem;
      left: 0.75rem;
    }
    .readout {
      padding: 0.4rem 0.6rem;
      border-radius: 4px;
      background: rgb(0 0 0 / 75%);
      color: #e8eaed;
      font:
        12px/1.4 system-ui,
        sans-serif;
    }
    h2 {
      margin: 0 0 0.2rem;
      font-size: 13px;
    }
    p {
      margin: 0.1rem 0;
    }
    table {
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      padding: 0.05rem 0.5rem 0.05rem 0;
      text-align: left;
      font-weight: normal;
      white-space: nowrap;
    }
    thead th {
      opacity: 0.8;
    }
    tbody th {
      opacity: 0.85;
    }
  `,
  host: { '[attr.data-corner]': 'corner()' },
})
export class WireReadoutPanel {
  readonly readout = input.required<WireReadoutView>();
  readonly corner = input<WireReadoutCorner>('top-right');
}
