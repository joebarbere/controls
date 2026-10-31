import { extname, join, normalize, sep } from 'node:path';

/** Custom scheme + host the renderer is served from (never `file://`). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'game';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * Content Security Policy for every response. `wasm-unsafe-eval` is for future WASM solvers. Workers
 * load from 'self': the sim worker is a bundled `app://game/worker-*.js` (F2.3b, ADR 0011), never a
 * blob, and desktop-e2e asserts its URL. `blob:` stays in `worker-src` because the spec's CSP (plan
 * §4) lists it; nothing uses it today. Angular component styles need inline styles.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** COOP + COEP make the renderer `crossOriginIsolated`, which SharedArrayBuffer requires. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Maps an `app://game/...` URL to a file under `rendererRoot`, or `null` if it must be refused
 * (wrong host, path traversal). Extension-less paths fall back to `index.html` (SPA routes).
 */
export function resolveAppPath(rendererRoot: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname === '/' || extname(pathname) === '') pathname = '/index.html';

  const root = normalize(rendererRoot);
  const resolved = normalize(join(root, pathname));
  return resolved.startsWith(root.endsWith(sep) ? root : root + sep) ? resolved : null;
}
