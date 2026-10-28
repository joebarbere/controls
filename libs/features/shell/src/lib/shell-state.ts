import { computed, Injectable, signal } from '@angular/core';

export type ShellScreen = 'menu' | 'workspace';
export type ShellDialog = 'settings' | 'about' | 'newGame';
/** Interaction modes (plan §4.9). */
export type InteractionMode = 'walk' | 'work' | 'editor';

/**
 * Which screen and dialog the shell shows. UI-only state: nothing here touches the world, is saved
 * or is replayed, so plain signals are right (no Commands).
 */
@Injectable({ providedIn: 'root' })
export class ShellState {
  private readonly screenState = signal<ShellScreen>('menu');
  private readonly dialogState = signal<ShellDialog | null>(null);
  private readonly session = signal(false);

  readonly screen = this.screenState.asReadonly();
  readonly dialog = this.dialogState.asReadonly();
  /** A sandbox is running (the menu offers Resume). TODO(F1.2): derive from feature-session. */
  readonly sessionActive = this.session.asReadonly();
  readonly menuOpen = computed(() => this.screenState() === 'menu');

  /**
   * Enters the workspace for a sandbox that has just started. The new-game dialog (`newGame`) picks
   * the seed and `Session.newSandbox` loads the workshop level (F1.9); this is only navigation.
   */
  newSandbox(): void {
    this.session.set(true);
    this.dialogState.set(null);
    this.screenState.set('workspace');
  }

  resume(): void {
    if (this.session()) this.screenState.set('workspace');
  }

  openMenu(): void {
    this.screenState.set('menu');
  }

  openDialog(dialog: ShellDialog): void {
    this.dialogState.set(dialog);
  }

  closeDialog(): void {
    this.dialogState.set(null);
  }
}
