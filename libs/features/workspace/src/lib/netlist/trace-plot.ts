import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SimTrace } from '@controls/feature-session';
import { formatQuantity } from './netlist-model';
import { describeTrace, layoutTrace, PLOT, seconds } from './trace-model';

/**
 * A live trace plot (plan F2.6): one watched quantity against sim time, as an SVG line with a time
 * axis and a value axis, redrawn when the trace's `version` changes (the panel rate, or slower under
 * `prefers-reduced-motion`: the inspector asks for it). Nothing animates between redraws. The plot
 * is an image with a text alternative (peak and latest value), also shown as its caption.
 */
@Component({
  selector: 'ctl-trace-plot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'trace-plot' },
  template: `
    <figure class="figure">
      <svg
        role="img"
        [attr.aria-label]="label() + ': ' + summary()"
        [attr.viewBox]="'-44 -6 ' + (plot.width + 52) + ' ' + (plot.height + 24)"
        class="plot"
      >
        <line class="axis" x1="0" y1="0" x2="0" [attr.y2]="plot.height" />
        <line class="axis" x1="0" [attr.y1]="plot.height" [attr.x2]="plot.width" [attr.y2]="plot.height" />
        <text class="tick" x="-4" y="4" text-anchor="end">{{ maxLabel() }}</text>
        <text class="tick" x="-4" [attr.y]="plot.height" text-anchor="end">0</text>
        <text class="tick" x="0" [attr.y]="plot.height + 14">{{ t0Label() }}</text>
        <text class="tick" [attr.x]="plot.width" [attr.y]="plot.height + 14" text-anchor="end">{{ t1Label() }}</text>
        @for (points of layout().lines; track $index) {
          <polyline class="line" [attr.points]="points" />
        }
      </svg>
      <figcaption class="caption" data-testid="trace-summary">{{ summary() }}</figcaption>
    </figure>
  `,
  styles: `
    :host {
      display: block;
    }
    .figure {
      margin: 0;
    }
    .plot {
      width: 100%;
      height: auto;
      display: block;
    }
    .axis {
      stroke: var(--ctl-fg-muted);
      stroke-width: 1;
    }
    .line {
      fill: none;
      stroke: var(--ctl-accent);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .tick {
      fill: var(--ctl-fg-muted);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .caption {
      color: var(--ctl-fg-muted);
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class TracePlot {
  readonly trace = input.required<SimTrace>();
  /** What is traced (`Branch 2 e3.filament current`), for the text alternative. */
  readonly label = input('Trace');
  /** The value's unit symbol. */
  readonly unit = input('A');
  protected readonly plot = PLOT;
  protected readonly layout = computed(() => {
    const trace = this.trace();
    trace.version(); // redraw on each (throttled) change
    return layoutTrace(trace.samples());
  });
  protected readonly summary = computed(() => describeTrace(this.layout(), this.unit()));
  protected readonly maxLabel = computed(() =>
    this.layout().peak === null ? '' : formatQuantity(this.layout().max, this.unit()),
  );
  protected readonly t0Label = computed(() => seconds(this.layout().t0));
  protected readonly t1Label = computed(() => seconds(this.layout().t1));
}
