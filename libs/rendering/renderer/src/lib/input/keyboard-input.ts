/**
 * Keyboard → input actions for the viewport. Listens on the viewport element only (it must have
 * focus), so typing in a text field or the console never moves the camera.
 * TODO(F1.4): the Angular keybinding service owns Commands; this stays the source of movement actions.
 */
import { Disposer } from '../disposer';
import {
  compileBindings,
  DEFAULT_INPUT_BINDINGS,
  isHeldAction,
  type HeldAction,
  type InputAction,
  type InputBindings,
  type TriggeredAction,
} from './input-actions';

export class KeyboardInput {
  /** Actions whose key is currently down. Sampled each frame; never reallocated. */
  readonly held = new Set<HeldAction>();
  private byCode: ReadonlyMap<string, InputAction>;
  private readonly disposer = new Disposer();

  constructor(
    element: EventTarget,
    windowTarget: EventTarget | null,
    /** Returns whether the action did anything; an unhandled key keeps its default (e.g. Escape reaches the shell). */
    private readonly onTrigger: (action: TriggeredAction) => boolean,
    bindings: InputBindings = DEFAULT_INPUT_BINDINGS,
    /** Called when the set of held actions changes (the render loop animates while one is held). */
    private readonly onHeldChange: () => void = () => undefined,
  ) {
    this.byCode = compileBindings(bindings);
    this.disposer.listen<KeyboardEvent>(element, 'keydown', (e) => this.onKeyDown(e));
    this.disposer.listen<KeyboardEvent>(element, 'keyup', (e) => this.onKeyUp(e));
    // A key released while focus is elsewhere never sends keyup: drop held keys on blur.
    const release = () => this.releaseAll();
    this.disposer.listen(element, 'blur', release);
    if (windowTarget) this.disposer.listen(windowTarget, 'blur', release);
  }

  /** Swaps bindings at runtime. Held keys are released so none stay stuck under the old map. */
  setBindings(bindings: InputBindings): void {
    this.byCode = compileBindings(bindings);
    this.releaseAll();
  }

  dispose(): void {
    this.held.clear();
    this.disposer.dispose();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // chords belong to Commands (F1.4)
    const action = this.byCode.get(e.code);
    if (!action) return;
    if (isHeldAction(action)) {
      e.preventDefault(); // stop arrows and space scrolling the page
      if (this.held.has(action)) return; // auto-repeat
      this.held.add(action);
      this.onHeldChange();
    } else if (e.repeat || this.onTrigger(action)) {
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const action = this.byCode.get(e.code);
    if (action && isHeldAction(action) && this.held.delete(action)) this.onHeldChange();
  }

  private releaseAll(): void {
    if (this.held.size === 0) return;
    this.held.clear();
    this.onHeldChange();
  }
}
