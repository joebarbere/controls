import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  cssColour,
  currentLegend,
  NO_SCALE_COLOUR,
  OVER_RANGE_COLOUR,
  UNKNOWN_COLOUR,
  VOLTAGE_SCALES,
  voltageLegend,
  type LegendScale,
  type OverlayLegendState,
} from '@controls/renderer';

/** One overlay scale: its title, the colour bar (decorative) and the tick labels as text. */
@Component({
  selector: 'ctl-legend-scale',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="title">{{ scale().title }}</p>
    <div class="bar" aria-hidden="true">
      @for (colour of scale().colours; track $index) {
        <span [style.background]="colour"></span>
      }
      <span class="over" [style.background]="overRangeColour"></span>
    </div>
    <ul class="ticks">
      @for (tick of scale().ticks; track tick.bin) {
        <li>{{ tick.label }}</li>
      }
      <li>{{ scale().overRange }} (magenta)</li>
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .title {
      margin: 0.2rem 0;
      opacity: 0.85;
    }
    .bar {
      display: flex;
      height: 0.6rem;
    }
    .bar span {
      flex: 1;
    }
    .bar .over {
      flex: 0 0 0.8rem;
      margin-left: 2px;
    }
    .ticks {
      display: flex;
      flex-wrap: wrap;
      gap: 0 0.6rem;
      margin: 0.1rem 0 0.3rem;
      padding: 0;
      list-style: none;
    }
  `,
})
export class LegendScaleBar {
  readonly scale = input.required<LegendScale>();
  protected readonly overRangeColour = cssColour(OVER_RANGE_COLOUR);
}

/**
 * The legend of the debug overlays (plan F2.6): for each overlay that is on, its scale as a bar of
 * colours with **text** tick labels, and the styles that aren't on a scale (no nominal band, no
 * reading), each named in words and drawn with a different shape or thickness in 3D, so nothing is
 * colour-only. Read-only text: nothing in it takes focus. The viewport shows it while an overlay is on.
 */
@Component({
  selector: 'ctl-overlay-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LegendScaleBar],
  template: `
    <section class="legend" aria-label="Overlay legend" data-testid="overlay-legend">
      @if (state().voltage) {
        <h2>Voltage overlay</h2>
        @for (scale of voltageScales(); track scale.title) {
          <ctl-legend-scale data-testid="legend-voltage-scale" [scale]="scale" />
        }
        @if (state().noScale || voltageScales().length === 0) {
          <p data-testid="legend-no-scale">
            <span class="swatch" [style.background]="noScaleColour" aria-hidden="true"></span>
            No nominal band: no voltage scale (light grey)
          </p>
        }
      }
      @if (state().current) {
        <h2>Current overlay</h2>
        <ctl-legend-scale data-testid="legend-current-scale" [scale]="currentScale" />
        <p data-testid="legend-current-motion">
          @if (reducedMotion()) {
            Arrows point along DC current and stand still (reduced motion); AC shows magnitude only (diamonds).
          } @else {
            Arrows travel with DC current, faster for more; AC shows magnitude only (diamonds sway in place).
          }
        </p>
      }
      @if (state().unknown) {
        <p data-testid="legend-unknown">
          <span class="swatch diamond" [style.background]="unknownColour" aria-hidden="true"></span>
          No reading: not solved, or not in the netlist yet (thin dark lead, diamond marker)
        </p>
      }
    </section>
  `,
  styles: `
    :host {
      position: absolute;
      right: 0.75rem;
      bottom: 0.75rem;
      max-width: 22rem;
      pointer-events: none;
    }
    .legend {
      padding: 0.4rem 0.6rem;
      border-radius: 4px;
      background: rgb(0 0 0 / 70%);
      color: #e8eaed;
      font:
        12px/1.4 system-ui,
        sans-serif;
    }
    h2 {
      margin: 0.2rem 0;
      font-size: 12px;
      font-weight: 600;
    }
    p {
      margin: 0.2rem 0;
    }
    .swatch {
      display: inline-block;
      width: 0.7rem;
      height: 0.7rem;
      margin-right: 0.3rem;
      vertical-align: -0.1rem;
    }
    .swatch.diamond {
      transform: rotate(45deg) scale(0.8);
    }
  `,
})
export class OverlayLegend {
  readonly state = input.required<OverlayLegendState>();
  readonly reducedMotion = input(false);

  protected readonly voltageScales = computed<LegendScale[]>(() =>
    this.state().bands.flatMap((band) =>
      Object.prototype.hasOwnProperty.call(VOLTAGE_SCALES, band) ? [voltageLegend(VOLTAGE_SCALES[band])] : [],
    ),
  );
  protected readonly currentScale = currentLegend();
  protected readonly noScaleColour = cssColour(NO_SCALE_COLOUR);
  protected readonly unknownColour = cssColour(UNKNOWN_COLOUR);
}
