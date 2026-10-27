import { ChangeDetectionStrategy, Component, input, model, output, signal } from '@angular/core';

/** Clamps `value` to `[min, max]` and rounds to whole pixels (sizes are persisted as integers). */
export function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * A focusable window splitter (WAI-ARIA APG "Window Splitter" pattern) that resizes one pane.
 *
 * - `orientation` is the ARIA orientation of the bar: `vertical` sits between left and right panes
 *   and moves with Left/Right; `horizontal` sits between top and bottom panes and moves with Up/Down.
 * - `value` is the size in px of the pane it controls. Set `reverse` when that pane is after the
 *   splitter (right of or below it), so moving the bar towards the pane shrinks it.
 * - Arrows move by `step` (Shift: `largeStep`), Home/End jump to `min`/`max`, Enter emits `collapseToggle`
 *   (collapse/restore). Pointer drags use pointer capture, so no document listeners are needed.
 */
@Component({
  selector: 'ctl-splitter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    role: 'separator',
    tabindex: '0',
    '[attr.aria-orientation]': 'orientation()',
    '[attr.aria-label]': 'label()',
    '[attr.aria-controls]': 'controls() ?? null',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'collapsed() ? min() : value()',
    '[attr.aria-valuetext]': "collapsed() ? 'collapsed' : value() + ' pixels'",
    '[class.dragging]': 'dragging()',
    '(keydown)': 'onKeydown($event)',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerEnd($event)',
    '(pointercancel)': 'onPointerEnd($event)',
  },
  styles: `
    :host {
      display: block;
      background: var(--ctl-border);
      touch-action: none;
      transition: background-color var(--ctl-duration) var(--ctl-easing);
    }
    :host([aria-orientation='vertical']) {
      width: var(--ctl-splitter-size);
      cursor: col-resize;
    }
    :host([aria-orientation='horizontal']) {
      height: var(--ctl-splitter-size);
      cursor: row-resize;
    }
    :host(:hover),
    :host(.dragging),
    :host(:focus-visible) {
      background: var(--ctl-accent);
    }
    :host(:focus-visible) {
      outline-offset: -2px;
    }
  `,
})
export class Splitter {
  readonly orientation = input.required<'vertical' | 'horizontal'>();
  readonly label = input.required<string>();
  /** Id of the controlled pane. */
  readonly controls = input<string>();
  readonly value = model.required<number>();
  readonly min = input(0);
  readonly max = input(10_000);
  readonly step = input(16);
  readonly largeStep = input(64);
  readonly reverse = input(false);
  readonly collapsed = input(false);
  /** Enter (or a resize key while collapsed): collapse or restore the pane. */
  readonly collapseToggle = output<void>();

  protected readonly dragging = signal(false);
  private dragStart = 0;
  private dragStartValue = 0;

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.collapseToggle.emit();
      return;
    }
    const delta = this.keyDelta(event);
    if (delta === undefined) return;
    event.preventDefault();
    if (this.collapsed()) {
      this.collapseToggle.emit();
      return;
    }
    if (delta === 'min' || delta === 'max') this.value.set(delta === 'min' ? this.min() : this.max());
    else this.setSize(this.value() + delta);
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.collapsed()) return;
    event.preventDefault();
    const host = event.currentTarget as HTMLElement;
    host.setPointerCapture?.(event.pointerId);
    host.focus();
    this.dragging.set(true);
    this.dragStart = this.coordinate(event);
    this.dragStartValue = this.value();
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const moved = this.coordinate(event) - this.dragStart;
    this.setSize(this.dragStartValue + (this.reverse() ? -moved : moved));
  }

  protected onPointerEnd(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  private coordinate(event: PointerEvent): number {
    return this.orientation() === 'vertical' ? event.clientX : event.clientY;
  }

  private setSize(size: number): void {
    this.value.set(clampSize(size, this.min(), this.max()));
  }

  /** Signed change in pane size for a key, or a jump to an end. */
  private keyDelta(event: KeyboardEvent): number | 'min' | 'max' | undefined {
    if (event.key === 'Home') return 'min';
    if (event.key === 'End') return 'max';
    const [towardsStart, towardsEnd] =
      this.orientation() === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (event.key !== towardsStart && event.key !== towardsEnd) return undefined;
    const amount = event.shiftKey ? this.largeStep() : this.step();
    // Moving the bar towards the end grows a pane before it and shrinks a pane after it.
    const grows = (event.key === towardsEnd) !== this.reverse();
    return grows ? amount : -amount;
  }
}
