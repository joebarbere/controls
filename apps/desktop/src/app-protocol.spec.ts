import { join, sep } from 'node:path';
import { APP_ENTRY_URL, resolveAppPath, SECURITY_HEADERS } from './app-protocol';

const root = join('/opt', 'controls', 'renderer');

describe('resolveAppPath', () => {
  it('serves files under the renderer root', () => {
    expect(resolveAppPath(root, APP_ENTRY_URL)).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://game/main-ABC.js')).toBe(join(root, 'main-ABC.js'));
  });

  it('falls back to index.html for SPA routes', () => {
    expect(resolveAppPath(root, 'app://game/')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://game/career/job-3')).toBe(join(root, 'index.html'));
  });

  it('never resolves outside the renderer root', () => {
    for (const url of ['app://game/%2e%2e/%2e%2e/etc/passwd.txt', 'app://game/../../etc/passwd.txt']) {
      const resolved = resolveAppPath(root, url);
      expect(resolved === null || resolved.startsWith(root + sep)).toBe(true);
    }
    // Encoded separators survive URL parsing, so the containment check must catch them.
    expect(resolveAppPath(root, 'app://game/..%2F..%2Fsecret.json')).toBeNull();
  });

  it('refuses foreign hosts and other schemes', () => {
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppPath(root, 'file:///etc/passwd')).toBeNull();
    expect(resolveAppPath(root, 'not a url')).toBeNull();
  });
});

describe('SECURITY_HEADERS', () => {
  it('enables cross-origin isolation and a CSP without unsafe-eval', () => {
    expect(SECURITY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toMatch(/'unsafe-eval'/);
  });
});
