import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { SettingsService } from './services/SettingsService';
import { DownloadManager } from './services/DownloadManager';
import { StreamManager } from './services/StreamManager';
import { CatalogService } from './services/CatalogService';
import { HistoryService } from './services/HistoryService';
import { UpdateService } from './services/UpdateService';
import { ProbeService } from './services/ProbeService';
import { LibraryService } from './services/LibraryService';
import { registerIpcHandlers } from './ipcHandlers';
import { SetupService } from './services/SetupService';
import { initTools } from './services/tools';

// Settings, history, library and covers live in %APPDATA%\Harbor. Before the rename they
// were in %APPDATA%\spotdl-ytdlp-gui; an existing folder there keeps being used so nobody
// loses their data. Must run before anything reads userData (incl. the single-instance lock).
// An explicit --user-data-dir (used for isolated test runs) always wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const appData = app.getPath('appData');
  const legacy = path.join(appData, 'spotdl-ytdlp-gui');
  app.setPath('userData', fs.existsSync(legacy) ? legacy : path.join(appData, 'Harbor'));
}

let mainWindow: BrowserWindow | null = null;
// Delay instantiation until app is ready (app.getPath requires app to be ready)
let settingsService: SettingsService;
let downloadManager: DownloadManager;
let streamManager: StreamManager;
let catalogService: CatalogService;
let historyService: HistoryService;
let updateService: UpdateService;

// Harbor's icon for the window and taskbar. A packaged build carries it in the .exe as well;
// in development this replaces Electron's default logo.
function appIcon(): string | undefined {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const p = path.join(__dirname, '../../build', file);
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: appIcon(),
    width: 1080,
    height: 760,
    minWidth: 840,
    minHeight: 600,
    frame: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Preload only uses contextBridge/ipcRenderer, so the renderer can be fully sandboxed
      sandbox: true,
      // A media player: resolving a stream can take longer than Chromium's ~5 s click
      // activation window, after which autoplay would be refused
      autoplayPolicy: 'no-user-gesture-required',
    },
    // macOS & Windows modern glass backdrop hints
    vibrancy: 'under-window',
    visualEffectState: 'active',
  });

  downloadManager.setWindow(mainWindow);

  // No File / Edit / View / Window bar (it doesn't appear on Alt either). Copy, paste, undo
  // and select-all keep working in text fields: Chromium handles them itself on Windows/Linux.
  // macOS keeps its standard app menu, which is what makes those shortcuts work there.
  if (process.platform !== 'darwin') mainWindow.removeMenu();

  // The menu also carried the developer shortcuts; keep them while developing only
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if ((input.control && key === 'r') || key === 'f5') {
        event.preventDefault();
        mainWindow?.webContents.reload();
      } else if (key === 'f12' || (input.control && input.shift && key === 'i')) {
        event.preventDefault();
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  // The UI is a local page; never navigate away from it or open in-app popups.
  // External http(s) links open in the user's browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  const rendererPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(rendererPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// One instance only: launching the app again focuses the open window instead of a second copy
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Bundled ffmpeg on PATH, updated yt-dlp location: before any tool is started
  initTools(app.getPath('userData'));
  settingsService = new SettingsService();
  historyService = new HistoryService();
  downloadManager = new DownloadManager(settingsService, historyService);
  streamManager = new StreamManager();
  catalogService = new CatalogService();
  updateService = new UpdateService(settingsService, () => downloadManager.isIdle());
  const probeService = new ProbeService(catalogService, streamManager, () => settingsService.getSettings().defaultVideoHeight ?? 1080);
  const libraryService = new LibraryService(catalogService);
  const setupService = new SetupService(settingsService, updateService, (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:progress', p);
  });
  registerIpcHandlers(
    settingsService,
    downloadManager,
    streamManager,
    catalogService,
    historyService,
    updateService,
    probeService,
    libraryService,
    setupService
  );
  libraryService.onChange(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library:changed');
  });
  updateService.onChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:changed', status);
  });
  historyService.onChange(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history:changed');
  });
  createWindow();
  updateService.scheduleAutoCheck();
  setTimeout(() => downloadManager.backfillHistory().catch((err) => console.error('[history backfill]', err)), 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Don't leave yt-dlp / spotdl / ffmpeg running after the window is closed
app.on('before-quit', () => {
  downloadManager?.shutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
