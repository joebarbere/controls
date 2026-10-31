import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { Toast, ToastLevel } from '@controls/ui';

export interface NotifyOptions {
  readonly level?: ToastLevel;
  /**
   * Auto-dismiss after this many ms. Defaults: 8 s for info and success; warnings and errors stay
   * until dismissed. `0` means never.
   */
  readonly timeoutMs?: number;
  /**
   * An action button that runs a command by id through the registry (ADR 0011 §13: the crash
   * toast's Restart simulation runs `sim.restart`). The app sets the runner ({@link setActionRunner}).
   */
  readonly action?: { readonly label: string; readonly commandId: string };
}

const DEFAULT_TIMEOUT_MS: Record<ToastLevel, number> = { info: 8000, success: 8000, warning: 0, error: 0 };
/** How long to wait before retrying an expiry while the player is reading (pointer or focus inside). */
export const HELD_RETRY_MS = 1000;
/** Oldest toasts drop off beyond this many, so a burst can't cover the screen. */
export const MAX_TOASTS = 5;

/**
 * Player notifications (UI-only state; nothing here is saved or replayed). Rendered by
 * `<ctl-notifications>`. Expiry pauses while the stack is held, so a toast never vanishes under
 * the keyboard focus or the pointer.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly items = signal<readonly Toast[]>([]);
  readonly toasts = this.items.asReadonly();
  private nextId = 1;
  private held = false;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly actions = new Map<number, string>();
  private runner: ((commandId: string) => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timers.forEach((t) => clearTimeout(t)));
  }

  notify(message: string, options: NotifyOptions = {}): number {
    const level = options.level ?? 'info';
    const id = this.nextId++;
    const action = options.action;
    if (action !== undefined) this.actions.set(id, action.commandId);
    this.items.update((list) =>
      [
        ...list,
        action === undefined ? { id, message, level } : { id, message, level, action: { label: action.label } },
      ].slice(-MAX_TOASTS),
    );
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[level];
    if (timeout > 0) this.schedule(id, timeout);
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.actions.delete(id);
    this.items.update((list) => list.filter((t) => t.id !== id));
  }

  /** Runs a toast's action (then dismisses it). Without a runner the toast is only dismissed. */
  act(id: number): void {
    const commandId = this.actions.get(id);
    this.dismiss(id);
    if (commandId !== undefined) this.runner?.(commandId);
  }

  /** Sets what runs a toast action's command (the app: `Session.exec`). */
  setActionRunner(runner: ((commandId: string) => void) | null): void {
    this.runner = runner;
  }

  /** While held (pointer or focus inside the stack), expiries are postponed. */
  setHeld(held: boolean): void {
    this.held = held;
  }

  private schedule(id: number, ms: number): void {
    this.timers.set(
      id,
      setTimeout(() => {
        if (this.held) this.schedule(id, HELD_RETRY_MS);
        else this.dismiss(id);
      }, ms),
    );
  }
}
