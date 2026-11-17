import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI, DownloadProgressPayload, DownloadTaskRequest, AppSettings, UpdateStatus, LibraryItem, SubtitleTrack } from '../shared/types';

const api: ElectronAPI = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('settings:save', settings),
  selectFolder: (defaultPath?: string) => ipcRenderer.invoke('dialog:selectFolder', defaultPath),
  startDownload: (request: DownloadTaskRequest) => ipcRenderer.invoke('download:start', request),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('download:cancel', taskId),
  openFolder: (taskId?: string) => ipcRenderer.invoke('system:openFolder', taskId),
  deleteDownloadedFile: (taskId: string) => ipcRenderer.invoke('download:deleteFile', taskId),
  checkDependencies: () => ipcRenderer.invoke('system:checkDeps'),
  resolveStreamUrl: (url: string) => ipcRenderer.invoke('stream:resolve', url),
  getPlaylist: (url: string, fresh?: boolean) => ipcRenderer.invoke('catalog:playlist', url, fresh),
  search: (query: string, limit?: number, fresh?: boolean) => ipcRenderer.invoke('catalog:search', query, limit, fresh),
  probeMedia: (url: string) => ipcRenderer.invoke('media:probe', url),
  getRelated: (url: string, title?: string) => ipcRenderer.invoke('catalog:related', url, title),
  getSubtitle: (url: string, track: SubtitleTrack) => ipcRenderer.invoke('stream:subtitle', url, track),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryCreate: (name: string, items?: LibraryItem[]) => ipcRenderer.invoke('library:create', name, items),
  libraryRename: (id: string, name: string) => ipcRenderer.invoke('library:rename', id, name),
  libraryDelete: (id: string) => ipcRenderer.invoke('library:delete', id),
  libraryAddItems: (id: string, items: LibraryItem[]) => ipcRenderer.invoke('library:addItems', id, items),
  libraryRemoveItem: (id: string, itemId: string) => ipcRenderer.invoke('library:removeItem', id, itemId),
  libraryImport: (url: string) => ipcRenderer.invoke('library:import', url),
  librarySync: (id: string) => ipcRenderer.invoke('library:sync', id),
  libraryImportLocal: (kind: 'file' | 'folder') => ipcRenderer.invoke('library:importLocal', kind),
  onLibraryImportProgress: (callback: (p: { done: number; total: number }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: { done: number; total: number }) => callback(p);
    ipcRenderer.on('library:importProgress', handler);
    return () => {
      ipcRenderer.removeListener('library:importProgress', handler);
    };
  },
  onLibraryChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('library:changed', handler);
    return () => {
      ipcRenderer.removeListener('library:changed', handler);
    };
  },
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  runUpdate: () => ipcRenderer.invoke('update:run'),
  onUpdateStatus: (callback: (s: UpdateStatus) => void) => {
    const handler = (_: Electron.IpcRendererEvent, s: UpdateStatus) => callback(s);
    ipcRenderer.on('update:changed', handler);
    return () => {
      ipcRenderer.removeListener('update:changed', handler);
    };
  },
  getHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (ids: string[]) => ipcRenderer.invoke('history:remove', ids),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  revealHistoryFile: (id: string) => ipcRenderer.invoke('history:reveal', id),
  onHistoryChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('history:changed', handler);
    return () => {
      ipcRenderer.removeListener('history:changed', handler);
    };
  },
  onDownloadProgress: (callback: (data: DownloadProgressPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: DownloadProgressPayload) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => {
      ipcRenderer.removeListener('download:progress', handler);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
