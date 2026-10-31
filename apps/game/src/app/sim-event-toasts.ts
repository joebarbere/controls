import { DestroyRef, inject, Injectable } from '@angular/core';
import { SIM_CLOCK, SimHost } from '@controls/feature-session';
import { NotificationService } from '@controls/feature-shell';
import { EVENT_TOAST_COALESCE_MS, type SimEvent } from '@controls/sim-protocol';

/**
 * Sim event toasts (ADR 0011 §4): a `tripped` or `blown` device gets one warning toast per
 * `EVENT_TOAST_COALESCE_MS` of **wall** time (through `SIM_CLOCK`), so a burst at 60× is one toast.
 * Other kinds go to the HUD and inspector only. The window is forgotten on every source reset (a new
 * game, a load, a restart): device ids are per game.
 */
@Injectable({ providedIn: 'root' })
export class SimEventToasts {
  private readonly clock = inject(SIM_CLOCK);
  private readonly notifications = inject(NotificationService);
  private readonly last = new Map<string, number>();

  constructor() {
    const sim = inject(SimHost);
    const offEvents = sim.onEvents((events) => this.events(events));
    const offReset = sim.subscribe((view) => {
      if (view === null) this.last.clear();
    });
    inject(DestroyRef).onDestroy(() => {
      offEvents();
      offReset();
    });
  }

  /** Shows the toasts a batch of events earns. */
  events(events: readonly SimEvent[]): void {
    for (const event of events) {
      if ((event.kind !== 'tripped' && event.kind !== 'blown') || event.entity === null) continue;
      const key = `${event.kind}:${event.entity}`;
      const now = this.clock.now();
      const last = this.last.get(key);
      if (last !== undefined && now - last < EVENT_TOAST_COALESCE_MS) continue;
      this.last.set(key, now);
      this.notifications.notify(`Device #${event.entity} ${event.kind === 'tripped' ? 'tripped' : 'blew'}.`, {
        level: 'warning',
      });
    }
  }
}
