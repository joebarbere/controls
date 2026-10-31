import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, effect, inject, signal, type Signal } from '@angular/core';
import type { ViewOverlayArgs } from '@controls/commands';
import { Session, SimHost } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import type { OverlayLegendState, ViewportRenderer } from '@controls/renderer';

/** What the viewport template needs from the overlays. */
export interface ViewportOverlays {
  /** The legend's state (which overlays are on, which scales and styles are in view). */
  readonly legend: Signal<OverlayLegendState>;
  /** Whether current arrows are static: settings `display.reducedMotion`, `system` following `prefers-reduced-motion`. */
  readonly reducedMotion: Signal<boolean>;
  /** The overlays on, for the host's `data-overlays` (`current voltage`), or `null`. */
  readonly active: Signal<string | null>;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Connects the renderer's debug overlays (plan F2.6) to the app, in the viewport's injection context:
 *
 * - `view.overlay {name, on}` (palette, console, scripts) takes effect through `Session.onCommand`,
 *   like `view.mode`; the renderer keeps it as view state;
 * - the renderer reads sim snapshots from `SimHost` (its `subscribe` and `running`, ADR 0011 §9.2);
 *   the subscription is the renderer's and ends when it is disposed;
 * - reduced motion follows the settings, and `prefers-reduced-motion` while they say `system`.
 */
export function connectViewportOverlays(renderer: ViewportRenderer): ViewportOverlays {
  const destroyRef = inject(DestroyRef);
  const session = inject(Session);
  const settings = inject(SettingsStore);
  const view = inject(DOCUMENT).defaultView;

  const legend = signal<OverlayLegendState>(renderer.overlayLegend);
  destroyRef.onDestroy(renderer.onOverlayLegend((s) => legend.set(s)));
  destroyRef.onDestroy(
    session.onCommand('view.overlay', (e) => {
      const args = e.command.args as ViewOverlayArgs;
      renderer.setOverlay(args.name, args.on);
    }),
  );
  renderer.attachSnapshots(inject(SimHost));

  const query = typeof view?.matchMedia === 'function' ? view.matchMedia(REDUCED_MOTION_QUERY) : null;
  const systemReduced = signal(query?.matches ?? false);
  if (query) {
    const onChange = (e: MediaQueryListEvent) => systemReduced.set(e.matches);
    query.addEventListener('change', onChange);
    destroyRef.onDestroy(() => query.removeEventListener('change', onChange));
  }
  const reducedMotion = computed(() => {
    const setting = settings.settings().display.reducedMotion;
    return setting === 'reduce' || (setting === 'system' && systemReduced());
  });
  effect(() => renderer.setReducedMotion(reducedMotion()));

  const active = computed(() => {
    const s = legend();
    const on = [s.current ? 'current' : null, s.voltage ? 'voltage' : null].filter((n) => n !== null);
    return on.length > 0 ? on.join(' ') : null;
  });
  return { legend: legend.asReadonly(), reducedMotion, active };
}
