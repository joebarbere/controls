/**
 * Collects teardown work (event listeners, observers, GPU resources) and runs it once, in reverse
 * order. Every resource owner in the renderer registers here so `dispose()` can't miss one.
 */
export class Disposer {
  private readonly tasks: Array<() => void> = [];
  private done = false;

  get disposed(): boolean {
    return this.done;
  }

  /** Registers a teardown task. After `dispose()` the task runs immediately. */
  add(task: () => void): void {
    if (this.done) task();
    else this.tasks.push(task);
  }

  /** `addEventListener` now, `removeEventListener` (same options) at dispose. */
  listen<E extends Event = Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.add(() => target.removeEventListener(type, listener, options));
  }

  /** Runs every task in reverse order, once. All tasks run even if one throws; the first error is rethrown. */
  dispose(): void {
    if (this.done) return;
    this.done = true;
    let first: unknown;
    let failed = false;
    while (this.tasks.length > 0) {
      const task = this.tasks.pop() as () => void;
      try {
        task();
      } catch (error) {
        if (!failed) first = error;
        failed = true;
      }
    }
    if (failed) throw first;
  }
}
