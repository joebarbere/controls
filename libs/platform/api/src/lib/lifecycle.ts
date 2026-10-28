/** Finishes a pending write (a debounced settings save, an autosave). May be async; should not throw. */
export type PendingWritesFlush = () => Promise<void> | void;

/**
 * Host lifecycle hooks. Generic: any feature with buffered writes registers a flush, so nothing the
 * player changed is lost when the window closes or the app quits.
 */
export interface AppLifecycle {
  /**
   * Runs `flush` before the app quits or its window closes. Returns a function that unregisters it.
   * - Electron: main asks the renderer to flush (`app:flush-request`), waits until every registered
   *   flush has settled, then closes or quits. Main gives up after `FLUSH_BEFORE_QUIT_TIMEOUT_MS`.
   * - Web harness: best effort on `pagehide`. The browser doesn't wait for promises, so only the
   *   synchronous part (a `localStorage` write) is guaranteed.
   */
  onBeforeQuit(flush: PendingWritesFlush): () => void;
}

/** An {@link AppLifecycle} that never calls back (tests, hosts with nothing to flush). */
export const NOOP_LIFECYCLE: AppLifecycle = { onBeforeQuit: () => () => undefined };

/**
 * Runs every flush and settles once all have, never rejecting. Resolves `true` if all succeeded.
 * Each flush is **called synchronously** (a throw is caught), so the synchronous part of every flush
 * has run when this returns: `pagehide` in the web harness depends on that. Shared by the platforms.
 */
export async function runFlushes(flushes: Iterable<PendingWritesFlush>): Promise<boolean> {
  const started = [...flushes].map((flush) => {
    try {
      return Promise.resolve(flush());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const results = await Promise.allSettled(started);
  return results.every((result) => result.status === 'fulfilled');
}
