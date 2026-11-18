import { hardenWebContents, isAppUrl, type HardenableContents } from './navigation-policy';

describe('isAppUrl', () => {
  it('accepts the app origin', () => {
    expect(isAppUrl('app://game/index.html')).toBe(true);
    expect(isAppUrl('app://game/index.html?recovered=renderer-crash')).toBe(true);
    expect(isAppUrl('app://game/career/job-3')).toBe(true);
  });

  it('refuses other schemes, hosts, credentials and junk', () => {
    for (const url of [
      'https://example.com/',
      'http://example.com/',
      'file:///etc/passwd',
      'app://evil/index.html',
      'app://game.evil/index.html',
      'app://user@game/index.html',
      'app://user:pw@game/index.html',
      'app://game:8080/index.html',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'not a url',
      '',
    ]) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });
});

describe('hardenWebContents', () => {
  type Listener = (event: { preventDefault(): void }, url?: string) => void;
  const harden = () => {
    let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const listeners = new Map<string, Listener>();
    const contents = {
      setWindowOpenHandler: (handler: typeof openHandler) => (openHandler = handler),
      on: (event: string, listener: Listener) => listeners.set(event, listener),
    } as unknown as HardenableContents;
    hardenWebContents(contents);
    const fire = (event: string, url?: string) => {
      let prevented = false;
      listeners.get(event)?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    };
    return { open: (url: string) => openHandler?.({ url }), fire, listeners };
  };

  it('denies every window.open, external or not', () => {
    const { open } = harden();
    for (const url of ['https://example.com/', 'http://example.com/', 'app://game/index.html', 'mailto:a@b.c']) {
      expect(open(url)).toEqual({ action: 'deny' });
    }
  });

  it('blocks navigation off app://game/ and allows it within', () => {
    const { fire } = harden();
    expect(fire('will-navigate', 'https://example.com/')).toBe(true);
    expect(fire('will-navigate', 'app://evil/index.html')).toBe(true);
    expect(fire('will-navigate', 'app://game/index.html')).toBe(false);
  });

  it('never attaches a webview', () => {
    const { fire, listeners } = harden();
    expect(listeners.has('will-attach-webview')).toBe(true);
    expect(fire('will-attach-webview')).toBe(true);
  });
});
