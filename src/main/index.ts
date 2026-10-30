/**
 * Electron main process.
 *
 * Security posture (see `docs/SECURITY.md`):
 *   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
 *   - the renderer never sees `ipcRenderer`, `require` or `process`;
 *   - external navigation and new windows are denied;
 *   - a strict CSP is applied to every response;
 *   - the process refuses to run as root.
 */

import { app, BrowserWindow, nativeTheme, session, shell } from 'electron';
import { join } from 'node:path';
import { createAppContext, type AppContext } from './app-context';
import { registerIpcHandlers } from './ipc/register-handlers';
import { applyNativeTheme } from './theme';
import { createLogger } from './nvidia/logger';

const logger = createLogger('main');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? '';
const isDevelopment = DEV_SERVER_URL !== '';

/** The single application window. */
let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;
let disposeIpc: (() => void) | null = null;

/**
 * The app must never run with administrative privileges. Running as root
 * would give the renderer an unnecessary attack surface.
 */
function refuseToRunAsRoot(): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.error(
      '[main] Recusando executar como root. O GPU Power Manager nunca precisa de privilégios administrativos.',
    );
    app.exit(1);
  }
}

/** Applies a strict content security policy to every response. */
function applyContentSecurityPolicy(): void {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  // Nothing in this app needs a camera, a microphone or a location. The only
  // exception is *writing* to the clipboard, which the "copy" button needs:
  // reading the user's clipboard stays forbidden.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-write', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}

/**
 * Blocks navigation away from the app and denies every request to open a new
 * window. External links are handed to the system browser instead.
 */
function hardenNavigation(target: BrowserWindow): void {
  const appOrigin = isDevelopment ? new URL(DEV_SERVER_URL).origin : 'file://';

  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  target.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appOrigin)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  target.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0b0d',
    title: 'GPU Power Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDevelopment,
    },
  });

  hardenNavigation(window);

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  if (isDevelopment) {
    await window.loadURL(DEV_SERVER_URL);
  } else {
    await window.loadFile(join(__dirname, '../../dist/renderer/index.html'));
  }

  return window;
}

async function bootstrap(): Promise<void> {
  refuseToRunAsRoot();
  applyContentSecurityPolicy();

  const simulate = process.argv.includes('--simulate');

  context = createAppContext({ simulate });

  const window = await createWindow();
  mainWindow = window;

  // The native window chrome follows the application theme.
  applyNativeTheme(context.settings.get().theme, window);
  nativeTheme.on('updated', () => {
    applyNativeTheme(context?.settings.get().theme ?? 'system', mainWindow);
  });

  disposeIpc = registerIpcHandlers({ context, window });

  if (context.settings.get().telemetryEnabled) {
    context.telemetry.start();
  } else {
    logger.info('Telemetria desativada nas preferências.');
  }

  logger.info('Aplicativo iniciado.', {
    simulated: context.isSimulated(),
    development: isDevelopment,
  });
}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error('[main] Falha ao iniciar:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // On Linux and Windows the app quits with the last window.
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().then((window) => {
      mainWindow = window;
    });
  }
});

app.on('before-quit', () => {
  disposeIpc?.();
  context?.dispose();
});
