import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { SettingsService } from './services/SettingsService';
import { DownloadManager } from './services/DownloadManager';
import { StreamManager } from './services/StreamManager';
import { CatalogService } from './services/CatalogService';
import { HistoryService } from './services/HistoryService';
import { UpdateService } from './services/UpdateService';
import { ProbeService } from './services/ProbeService';
import { LibraryService } from './services/LibraryService';
import { SubtitleService } from './services/SubtitleService';

const subtitleService = new SubtitleService();
import { DownloadTaskRequest, AppSettings, MediaMeta } from '../shared/types';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function registerIpcHandlers(
  settingsService: SettingsService,
  downloadManager: DownloadManager,
  streamManager: StreamManager,
  catalogService: CatalogService,
  historyService: HistoryService,
  updateService: UpdateService,
  probeService: ProbeService,
  libraryService: LibraryService
) {
  ipcMain.handle('settings:get', async () => {
    return settingsService.getSettings();
  });

  ipcMain.handle('settings:save', async (_, newSettings: Partial<AppSettings>) => {
    if (!newSettings || typeof newSettings !== 'object') return settingsService.getSettings();
    return settingsService.saveSettings(newSettings);
  });

  ipcMain.handle('stream:resolve', async (_, url: unknown) => {
    if (!isNonEmptyString(url)) return { success: false, errorCode: 'resolveFailed' };
    return streamManager.resolveMedia(url);
  });

  ipcMain.handle('dialog:selectFolder', async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined,
      title: settingsService.getSettings().language === 'en' ? 'Select Download Folder' : 'İndirme Klasörünü Seçin',
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('download:start', async (_, request: DownloadTaskRequest) => {
    if (!request || !isNonEmptyString(request.url) || (request.format !== 'mp3' && request.format !== 'mp4')) {
      return { taskId: '', success: false };
    }
    // Only known fields are accepted from the renderer (no arbitrary target folder)
    return downloadManager.startTask({
      url: request.url.trim(),
      format: request.format,
      subfolder: isNonEmptyString(request.subfolder) ? request.subfolder.slice(0, 200) : undefined,
      meta: cleanMeta(request.meta),
      // A yt-dlp format expression from the preview: ids, '+', '/', '-' only
      formatId: typeof request.formatId === 'string' && /^[\w.+\/-]{1,80}$/.test(request.formatId) ? request.formatId : undefined,
      maxHeight: typeof request.maxHeight === 'number' && request.maxHeight > 0 && request.maxHeight <= 4320 ? Math.round(request.maxHeight) : undefined,
      audioCodec: request.audioCodec === 'm4a' ? 'm4a' : undefined,
    });
  });

  ipcMain.handle('download:cancel', async (_, taskId: string) => {
    return downloadManager.cancelTask(taskId);
  });

  ipcMain.handle('system:openFolder', async (_, taskId?: string) => {
    // Highlight the downloaded file in Explorer when we know it
    const file = taskId ? downloadManager.getTaskFile(taskId) : undefined;
    if (file) {
      shell.showItemInFolder(file);
      return;
    }
    const folder = (taskId && downloadManager.getTaskFolder(taskId)) || settingsService.getSettings().mp3DownloadPath;
    if (folder) {
      await shell.openPath(folder);
    }
  });

  ipcMain.handle('download:deleteFile', async (_, taskId: string) => {
    return downloadManager.deleteDownloadedFile(taskId);
  });

  ipcMain.handle('system:checkDeps', async () => {
    return downloadManager.checkDependencies();
  });

  // ── Catalog: playlist preview & explore/search ──
  ipcMain.handle('catalog:playlist', async (_, url: unknown, fresh: unknown) => {
    if (!isNonEmptyString(url)) return { success: false, errorCode: 'unsupported' };
    return catalogService.getPlaylist(url.trim(), fresh === true);
  });

  ipcMain.handle('catalog:search', async (_, query: unknown, limit: unknown, fresh: unknown) => {
    if (!isNonEmptyString(query)) return { success: false, errorCode: 'notFound' };
    return catalogService.search(query.slice(0, 200), typeof limit === 'number' ? limit : 30, fresh === true);
  });

  // ── Link preview & watch page ──
  ipcMain.handle('media:probe', async (_, url: unknown) => {
    if (!isNonEmptyString(url)) return { success: false };
    return probeService.probe(url.slice(0, 2000));
  });
  ipcMain.handle('stream:subtitle', async (_, url: unknown, track: any) => {
    if (!isNonEmptyString(url) || !track || typeof track.lang !== 'string' || !/^[\w-]{1,20}$/.test(track.lang)) return { success: false };
    const kind = track.kind === 'manual' || track.kind === 'auto' ? track.kind : 'translated';
    const source = typeof track.source === 'string' && /^[\w-]{1,20}$/.test(track.source) ? track.source : undefined;
    return subtitleService.get(url.slice(0, 2000), { lang: track.lang, name: String(track.name ?? ''), kind, source, sourceAuto: !!track.sourceAuto });
  });
  ipcMain.handle('catalog:related', async (_, url: unknown, title: unknown) => {
    if (!isNonEmptyString(url)) return { success: false, errorCode: 'notFound' };
    return catalogService.related(url, typeof title === 'string' ? title.slice(0, 300) : undefined);
  });

  // ── Library (user playlists) ──
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const arr = (v: unknown) => (Array.isArray(v) ? v.slice(0, 5000) : []);
  ipcMain.handle('library:list', async () => libraryService.list());
  ipcMain.handle('library:create', async (_, name: unknown, items: unknown) => libraryService.create(str(name), arr(items)));
  ipcMain.handle('library:rename', async (_, id: unknown, name: unknown) => libraryService.rename(str(id), str(name)));
  ipcMain.handle('library:delete', async (_, id: unknown) => libraryService.remove(str(id)));
  ipcMain.handle('library:addItems', async (_, id: unknown, items: unknown) => libraryService.addItems(str(id), arr(items)));
  ipcMain.handle('library:removeItem', async (_, id: unknown, itemId: unknown) => libraryService.removeItem(str(id), str(itemId)));
  ipcMain.handle('library:import', async (_, url: unknown) =>
    isNonEmptyString(url) ? libraryService.importFrom(url.trim()) : { success: false }
  );
  ipcMain.handle('library:sync', async (_, id: unknown) => libraryService.sync(str(id)));
  ipcMain.handle('library:importLocal', async (event, kind: unknown) => {
    const folder = kind === 'folder';
    const win = BrowserWindow.fromWebContents(event.sender);
    const en = settingsService.getSettings().language === 'en';
    const options: Electron.OpenDialogOptions = folder
      ? { properties: ['openDirectory'], title: en ? 'Choose a music folder' : 'Müzik klasörünü seçin' }
      : {
          properties: ['openFile'],
          title: en ? 'Choose a playlist file' : 'Çalma listesi dosyasını seçin',
          filters: [
            { name: en ? 'Playlists' : 'Çalma listeleri', extensions: ['m3u', 'm3u8', 'pls', 'xml', 'txt'] },
            { name: en ? 'All files' : 'Tüm dosyalar', extensions: ['*'] },
          ],
        };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true };
    return libraryService.importLocal(res.filePaths[0], folder ? 'folder' : 'file', (done, total) => {
      if (!event.sender.isDestroyed()) event.sender.send('library:importProgress', { done, total });
    });
  });

  // ── yt-dlp updates ──
  ipcMain.handle('update:status', async () => updateService.getStatus());
  ipcMain.handle('update:check', async () => updateService.check(true));
  ipcMain.handle('update:run', async () => updateService.update());

  // ── History ──
  ipcMain.handle('history:list', async () => historyService.list());

  ipcMain.handle('history:remove', async (_, ids: unknown) => {
    if (Array.isArray(ids)) historyService.remove(ids.filter((i): i is string => typeof i === 'string'));
  });

  ipcMain.handle('history:clear', async () => historyService.clear());

  // Only files that are in the history can be revealed (the renderer never passes raw paths)
  ipcMain.handle('history:reveal', async (_, id: unknown) => {
    const entry = typeof id === 'string' ? historyService.get(id) : undefined;
    if (!entry) return false;
    if (fs.existsSync(entry.filePath)) {
      shell.showItemInFolder(entry.filePath);
      return true;
    }
    const dir = path.dirname(entry.filePath);
    if (fs.existsSync(dir)) await shell.openPath(dir);
    return false;
  });
}

function cleanMeta(meta: unknown): MediaMeta | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);
  const thumb = str(m.thumbnail);
  return {
    title: str(m.title),
    artist: str(m.artist),
    thumbnail: thumb && /^https:\/\//i.test(thumb) ? thumb : undefined,
    duration: typeof m.duration === 'number' && isFinite(m.duration) ? m.duration : undefined,
  };
}
