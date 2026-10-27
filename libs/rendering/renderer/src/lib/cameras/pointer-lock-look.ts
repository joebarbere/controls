/**
 * Pointer lock and mouse look for walk mode. The browser releases the lock on Esc by itself; we
 * only listen for `pointerlockchange`. Pointer lock is never required for tests: E2E drives modes
 * through the renderer API and asserts state (pointer lock is flaky in headless CI).
 */
import { Disposer } from '../disposer';

export class PointerLockLook {
  private readonly disposer = new Disposer();
  private locked = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly onLook: (dxPx: number, dyPx: number) => void,
    private readonly onLockChange: (locked: boolean) => void,
  ) {
    const doc = element.ownerDocument;
    this.disposer.listen(doc, 'pointerlockchange', () => {
      const now = doc.pointerLockElement === element;
      if (now === this.locked) return;
      this.locked = now;
      this.onLockChange(now);
    });
    this.disposer.listen<MouseEvent>(doc, 'mousemove', (e) => {
      if (this.locked) this.onLook(e.movementX, e.movementY);
    });
    this.disposer.add(() => this.release());
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Must be called from a user gesture (click). Rejections (denied, unsupported) are ignored. */
  request(): void {
    if (this.disposer.disposed || typeof this.element.requestPointerLock !== 'function') return;
    try {
      const result: unknown = this.element.requestPointerLock();
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // Older engines throw synchronously when not in a gesture; staying unlocked is fine.
    }
  }

  release(): void {
    const doc = this.element.ownerDocument;
    if (doc.pointerLockElement === this.element) doc.exitPointerLock();
  }

  dispose(): void {
    this.disposer.dispose();
    this.locked = false;
  }
}
