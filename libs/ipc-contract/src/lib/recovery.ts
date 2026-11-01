/**
 * Renderer crash recovery (ADR 0011 §10). When the renderer process dies, main reloads the window at
 * {@link rendererCrashRecoveryUrl} instead of the plain entry URL, and the page offers to continue
 * from the latest good autosave. The flag rides on the fixed `app://game/index.html` URL (a query,
 * like `?renderer=webgl2`), so no IPC is needed before the page has started. It is a hint only: the
 * page could navigate itself there (same origin), and all it gets is the notice. Nothing is written.
 */
export const RECOVERY_QUERY_PARAM = 'recovered';

/** The {@link RECOVERY_QUERY_PARAM} value main sets after `render-process-gone`. */
export const RENDERER_CRASH_RECOVERY = 'renderer-crash';

/** The URL main loads after a renderer crash: `entryUrl` with the recovery query. */
export function rendererCrashRecoveryUrl(entryUrl: string): string {
  const url = new URL(entryUrl);
  url.searchParams.set(RECOVERY_QUERY_PARAM, RENDERER_CRASH_RECOVERY);
  return url.toString();
}

/** Whether a page's `location.search` says main reloaded it after a renderer crash. Exact match only. */
export function isRendererCrashRecovery(search: string): boolean {
  return new URLSearchParams(search).get(RECOVERY_QUERY_PARAM) === RENDERER_CRASH_RECOVERY;
}
