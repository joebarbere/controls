import { app, BrowserWindow, net, protocol, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ENTRY_URL, APP_HOST, APP_ORIGIN, APP_SCHEME, resolveAppPath, SECURITY_HEADERS } from './app-protocol';
import { registerIpcHandlers } from './ipc';
import { startAutoUpdate } from './updater';

const RENDERER_ROOT = join(__dirname, 'renderer');

// Must run before `ready`: makes app:// a standard, secure origin (fetch, CORS, workers, code cache).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function serveAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveAppPath(RENDERER_ROOT, request.url);
    if (!filePath) return new Response('Not found', { status: 404 });
    const upstream = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(upstream.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

function hardenSessions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url); // external docs links open in the OS browser
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1d2126',
    title: 'Controls',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  void window.loadURL(APP_ENTRY_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(() => {
    serveAppProtocol();
    hardenSessions();
    registerIpcHandlers();
    createWindow();
    startAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

export { APP_HOST };
