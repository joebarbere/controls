import { computed, Injectable, signal } from '@angular/core';

export type ShellScreen = 'menu' | 'workspace';
/** `save` and `load` are the Save game and Load game dialogs (F1.8b, `feature-saves`). */
export type ShellDialog = 'settings' | 'about' | 'newGame' | 'save' | 'load';
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
  /** A game is running (the menu offers Resume and Save). Navigation only; `Session.active` is the game's own flag. */
  readonly sessionActive = this.session.asReadonly();
  readonly menuOpen = computed(() => this.screenState() === 'menu');

  /**
   * Enters the workspace for a game that has just started or loaded. The new-game dialog (`newGame`)
   * picks the seed and `Session.newSandbox` loads the workshop level (F1.9), or `SaveGames` loads a
   * save (F1.8b); this is only navigation.
   */
  enterGame(): void {
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
