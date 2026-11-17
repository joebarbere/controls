import { APP_HOST, APP_SCHEME } from './app-protocol';

/**
 * Navigation and window-opening policy for every `WebContents` (plan §4.11). Electron-free so it is
 * unit-tested; `main.ts` applies it in `web-contents-created`.
 *
 * - `window.open` (and `target="_blank"`, `<a download>` in a new window…) is always denied, and
 *   nothing is handed to `shell.openExternal`. An external link, if the UI ever needs one, goes
 *   through an explicit, allow-listed IPC call, never through the window-open handler.
 * - Navigation is allowed only within `app://game/`; any other scheme or host is refused.
 * - `<webview>` is never attached.
 */

/** True only for a URL on the app's own origin (`app://game/…`), with no credentials. */
export function isAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `URL.origin` is `null` for a non-special scheme in Node, so compare scheme and host directly.
  return (
    parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST && parsed.username === '' && parsed.password === ''
  );
}

/** The structural slice of `WebContents` the policy needs (so tests need no Electron). */
export interface HardenableContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown;
}

/** Applies the policy: every window open denied, navigation off `app://game/` refused, no webviews. */
export function hardenWebContents(contents: HardenableContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
