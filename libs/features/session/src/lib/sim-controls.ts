import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SIM_SPEEDS, type SimSpeed } from '@controls/commands';
import { Session } from './session';
import { SimHost } from './sim-host';

const SPEED_LABELS: Readonly<Record<SimSpeed, string>> = { 0: 'Pause', 1: '1×', 10: '10×', 60: '60×' };

/** `1234` ticks (ms) → `0:00:01.234`. */
export function formatSimTime(ticks: number): string {
  const ms = Math.max(0, Math.floor(ticks));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

/** An achieved speed for the HUD: one decimal below 10×, whole numbers above. */
export function formatSpeed(speed: number): string {
  return `${speed < 10 ? speed.toFixed(1) : Math.round(speed)}×`;
}

/**
 * The HUD's time controls (ADR 0011 §13, plan F2.3b): the sim time the player sees (the latest
 * snapshot's tick, never the bus world's), the requested speed as one native radio group that runs
 * `sim.setSpeed` through the registry, the achieved speed while running, "Catching up" with progress,
 * and a polite live region that announces only transitions (falling behind, catching up, crashed,
 * paused, suspended), once each. The clock and the numbers are never in a live region. Keys, the
 * palette and the console reach the same commands (`P`, `Shift+1–3`, `Period`, `Shift+Period`).
 */
@Component({
  selector: 'ctl-sim-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sim" aria-label="Sim time" data-testid="sim-controls" [attr.data-status]="sim.status()">
      <p class="clock">
        <span class="label">Sim time</span>
        <span class="value" data-testid="sim-time">{{ time() }}</span>
      </p>
      <fieldset class="speeds" [attr.aria-disabled]="enabled() ? null : 'true'">
        <legend class="label">Speed</legend>
        @for (option of speeds; track option.value) {
          <label>
            <input
              type="radio"
              name="ctl-sim-speed"
              [value]="option.value"
              [checked]="sim.speed() === option.value"
              (change)="choose(option.value)"
            />
            {{ option.label }}
          </label>
        }
      </fieldset>
      <p class="effective" data-testid="sim-effective">
        @if (sim.status() === 'running') {
          <span class="label">Running at</span> {{ effective() }}
        } @else {
          <span class="state">{{ stateLabel() }}</span>
        }
      </p>
      @if (sim.behind()) {
        <p class="behind" data-testid="sim-behind">Falling behind: {{ effective() }} of {{ requested() }}</p>
      }
      @if (catchingUp()) {
        <p class="catching" data-testid="sim-catching-up">Catching up: {{ progress() }}</p>
      }
      <p class="ctl-visually-hidden" aria-live="polite" data-testid="sim-announcement">{{ announcement() }}</p>
    </section>
  `,
  styles: `
    :host {
      display: block;
      margin-top: var(--ctl-space-2);
      pointer-events: auto;
    }
    .sim {
      display: grid;
      gap: var(--ctl-space-1);
      padding: var(--ctl-space-2) var(--ctl-space-3);
      border-radius: var(--ctl-radius);
      background: var(--ctl-hud-bg);
      color: var(--ctl-hud-fg);
      font-size: 0.8rem;
    }
    p {
      margin: 0;
    }
    .label {
      color: var(--ctl-fg-muted);
    }
    .value {
      font-variant-numeric: tabular-nums;
    }
    .speeds {
      display: flex;
      gap: var(--ctl-space-2);
      margin: 0;
      padding: 0;
      border: 0;
    }
    .speeds legend {
      float: left;
      margin-inline-end: var(--ctl-space-2);
      padding: 0;
    }
    .speeds[aria-disabled='true'] {
      opacity: 0.6;
    }
    .behind,
    .catching {
      color: var(--ctl-warning);
      font-weight: 600;
    }
  `,
})
export class SimControls {
  private readonly session = inject(Session);
  protected readonly sim = inject(SimHost);
  protected readonly speeds = SIM_SPEEDS.map((value) => ({ value, label: SPEED_LABELS[value] }));

  protected readonly time = computed(() => formatSimTime(this.sim.simTick()));
  protected readonly effective = computed(() => formatSpeed(this.sim.effectiveSpeed()));
  protected readonly requested = computed(() => `${this.sim.speed()}×`);
  protected readonly enabled = computed(() => this.session.isEnabled('sim.setSpeed'));
  protected readonly catchingUp = computed(() => this.sim.catchingUp());
  protected readonly progress = computed(
    () => `${formatSimTime(this.sim.simTick())} of ${formatSimTime(this.sim.commandedTick())}`,
  );
  protected readonly stateLabel = computed(() => {
    switch (this.sim.status()) {
      case 'paused':
        return 'Paused';
      case 'suspended':
        return 'Suspended (window hidden)';
      case 'starting':
        return 'Starting…';
      case 'crashed':
        return 'Stopped: restart the simulation';
      case 'unavailable':
        return 'Simulation unavailable';
      default:
        return '';
    }
  });
  /** Transitions only (ADR 0011 §13): the text changes once per transition, so each is announced once. */
  protected readonly announcement = computed(() => {
    const status = this.sim.status();
    if (status === 'crashed') return 'The simulation stopped.';
    if (status === 'unavailable') return 'The simulation is unavailable.';
    if (status === 'suspended') return 'The simulation is suspended while the window is hidden.';
    if (this.sim.behind()) return 'The simulation is falling behind.';
    if (this.catchingUp()) return 'The simulation is catching up.';
    if (status === 'paused') return 'The simulation is paused.';
    return '';
  });

  /** A radio was chosen: `sim.setSpeed` through the registry, like every other surface. */
  protected choose(speed: SimSpeed): void {
    if (!this.enabled()) return;
    this.session.exec('sim.setSpeed', { speed });
  }
}
