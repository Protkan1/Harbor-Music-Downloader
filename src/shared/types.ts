export interface AppSettings {
  theme: 'dark' | 'light';
  colorTheme: ColorTheme;
  language: 'tr' | 'en';
  glassEnabled: boolean;
  glassBlur: number; // in px (e.g. 0 to 40)
  glassOpacity: number; // in percentage 10 to 100
  mp3DownloadPath: string;
  mp4DownloadPath: string;
  maxConcurrentDownloads: number; // how many downloads may run at the same time (others wait in queue)
  /** Update yt-dlp automatically when a new release is out (checked at most twice a day). */
  autoUpdateYtDlp: boolean;
  /** Epoch ms of the last remote version check. */
  lastYtDlpCheck: number;
  /** Highest video height picked when no quality is chosen (0 = best available). */
  defaultVideoHeight: number;
  /** App version whose first-run setup finished (tools verified, yt-dlp updated). */
  setupDoneFor?: string;
  /** Harbor updates itself from GitHub Releases on start (default on). */
  autoUpdateApp: boolean;
  /** Battery saver: off, on battery (default), always */
  powerSaver: PowerSaverMode;
}

export type PowerSaverMode = 'off' | 'battery' | 'on';
export interface PowerState {
  mode: PowerSaverMode;
  onBattery: boolean;
  /** Battery saver is in effect right now */
  active: boolean;
}

/** Harbor's own update (AppUpdateService) */
export interface AppUpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'none' | 'downloading' | 'downloaded' | 'installing' | 'error';
  current: string;
  version?: string;
  percent?: number;
  waitingForDownloads?: boolean;
  checkedAt?: number;
  error?: string;
}

/** First-run setup (SetupService) */
export type SetupStepId = 'engine' | 'ffmpeg' | 'ytdlp';
export interface SetupProgress {
  step: SetupStepId;
  state: 'running' | 'done' | 'skipped' | 'failed';
  /** e.g. the yt-dlp version */
  detail?: string;
}
export interface SetupStatus {
  needed: boolean;
  /** Tools come with the app (installed build) rather than from the system */
  bundled: boolean;
}
export interface SetupResult {
  ok: boolean;
  error?: SetupStepId;
}

/** Midnight ('aura'), Ember ('ember'), Glacier ('true-liquid'), Clay ('claude'). Ids are stored in settings, so they stay. */
export type ColorTheme = 'aura' | 'ember' | 'true-liquid' | 'claude';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'updating' | 'updated' | 'failed';
  installed?: boolean;
  current?: string;
  latest?: string;
  previous?: string;
  updateAvailable?: boolean;
  checkedAt?: number;
  error?: string;
}

export type DownloadFormat = 'mp3' | 'mp4';
export type ToolType = 'spotdl' | 'yt-dlp';

export interface StreamFormatOption {
  formatId: string;
  label: string; // e.g. "4K (2160p)", "2K (1440p)", "1080p 60fps", "Audio HQ"
  resolution?: string;
  url: string;
  /** For video-only (DASH) streams: separate audio stream played in sync with the video. */
  audioUrl?: string;
  isVideo: boolean;
  ext: string;
}

export interface SubtitleTrack {
  lang: string; // yt-dlp language key, e.g. 'en', 'tr', 'en-orig'
  name: string;
  /** manual = uploaded by the creator; auto = speech recognition; translated = machine translation */
  kind: 'manual' | 'auto' | 'translated';
  /** Translated tracks: the original track they are translated from (yt-dlp language key). */
  source?: string;
  /** The source is speech-recognised (download with --write-auto-subs). */
  sourceAuto?: boolean;
}

export interface AudioTrack {
  lang: string;
  label: string;
  url: string;
  original: boolean;
}

export interface StreamMediaInfo {
  title: string;
  subtitles?: SubtitleTrack[];
  /** Dubbed audio (YouTube's multi-language / AI dubbing), original first */
  audioTracks?: AudioTrack[];
  uploader?: string;
  thumbnail?: string;
  duration?: number;
  durationStr?: string;
  streamUrl: string;
  formats: StreamFormatOption[];
  isVideo: boolean;
  webpageUrl: string;
}

export type StreamErrorCode = 'resolveFailed' | 'spotifyNotTrack' | 'spotifyLookupFailed' | 'unknown';

/** Metadata already known by the UI (explore card, playlist preview) — used for history entries. */
export interface MediaMeta {
  title?: string;
  artist?: string;
  thumbnail?: string;
  duration?: number; // seconds
}

export interface DownloadTaskRequest {
  url: string;
  format: DownloadFormat;
  tool?: ToolType; // optional override, otherwise auto-detected
  customFolder?: string;
  /** Saved into <download folder>/<subfolder> (e.g. playlist name). Sanitized in main. */
  subfolder?: string;
  meta?: MediaMeta;
  /** Exact yt-dlp format chosen in the link preview, e.g. "137+140-19". */
  formatId?: string;
  /** Cap used as a fallback when formatId is gone (formats can change between preview and download). */
  maxHeight?: number;
  /** Audio container: mp3 (converted, tagged) or m4a (YouTube's original AAC, no re-encode). */
  audioCodec?: 'mp3' | 'm4a';
}

// ─────────────── Link preview ───────────────

export type MediaSource = 'youtube' | 'spotify' | 'soundcloud' | 'apple' | 'other';

export interface QualityOption {
  id: string; // 'v1080', 'a-mp3', 'a-m4a'
  kind: 'video' | 'audio';
  label: string; // '1080p', '4K', 'MP3', 'M4A'
  detail?: string; // '60fps · H.264', 'AAC 129 kbps'
  height?: number;
  formatId?: string;
  audioCodec?: 'mp3' | 'm4a';
  sizeBytes?: number;
  approx?: boolean;
}

export interface MediaProbe {
  url: string;
  kind: 'single' | 'collection';
  source: MediaSource;
  title: string;
  artist?: string;
  thumbnail?: string;
  duration?: number;
  isLive?: boolean;
  isVideo: boolean;
  options: QualityOption[];
  defaultVideo?: string;
  defaultAudio?: string;
  /** Collections only */
  collectionKind?: 'playlist' | 'album';
  itemCount?: number;
}

export type ProbeResult = { success: boolean; data?: MediaProbe; error?: string };

// ─────────────── Library (user playlists) ───────────────

export interface LibraryItem {
  id: string;
  title: string;
  artist?: string;
  duration?: number;
  thumbnail?: string;
  /** Playable/downloadable source: a page URL, `ytsearch1:` query, or empty for local-only files. */
  url: string;
  /** Local file (from the download history) — plays offline. */
  filePath?: string;
  source: MediaSource | 'local';
  isVideo?: boolean;
}

export interface LibraryPlaylist {
  id: string;
  name: string;
  /** Imported playlists remember where they came from so they can be refreshed. */
  origin?: { source: MediaSource | 'local'; url: string; kind?: 'file' | 'folder' };
  items: LibraryItem[];
  createdAt: number;
  updatedAt: number;
}

// ─────────────── Catalog (playlist preview, explore/search) ───────────────

export interface CatalogEntry {
  id: string;
  url: string;
  title: string;
  artist?: string;
  duration?: number; // seconds
  thumbnail?: string;
  viewCount?: number;
  /** Live stream: can be played but not downloaded (it never ends). */
  isLive?: boolean;
}

export interface CatalogList {
  source: MediaSource;
  kind: 'playlist' | 'album' | 'search';
  title: string;
  thumbnail?: string;
  entries: CatalogEntry[];
  /** Total items in the source list when more exist than were returned. */
  totalCount?: number;
}

export type CatalogErrorCode = 'unsupported' | 'notFound' | 'failed';
export type CatalogResult = { success: boolean; data?: CatalogList; errorCode?: CatalogErrorCode; error?: string };

// ─────────────── Download history ───────────────

export interface HistoryEntry {
  id: string;
  title: string;
  artist?: string;
  sourceUrl: string;
  filePath: string;
  format: DownloadFormat;
  source: 'youtube' | 'spotify' | 'other';
  thumbnail?: string;
  duration?: number;
  size?: number; // bytes
  completedAt: number; // epoch ms
  /** Filled in by history:list — whether the file is still on disk, and a file:// URL for playback. */
  exists?: boolean;
  fileUrl?: string;
}

export type DownloadStatus = 'queued' | 'downloading' | 'converting' | 'completed' | 'error' | 'cancelled';

/**
 * Machine-readable error reasons. The renderer turns these into localized text;
 * `error` carries the raw tool output (e.g. the last "ERROR:" line from yt-dlp) for details.
 */
export type DownloadErrorCode = 'spawnFailed' | 'exitCode' | 'noOutput' | 'folderFailed';

export interface DownloadProgressPayload {
  taskId: string;
  status: DownloadStatus;
  percent: number;
  /** Raw speed string from the tool, e.g. "12.3MiB/s". Absent while preparing/processing. */
  speed?: string;
  /** Raw ETA string from the tool, e.g. "00:42". */
  eta?: string;
  title?: string;
  rawLog?: string;
  error?: string;
  errorCode?: DownloadErrorCode;
  filePath?: string;
  /** Number of files produced (playlists/albums produce more than one). */
  fileCount?: number;
  /** Playlist progress for spotdl: items done / total. */
  itemsDone?: number;
  itemsTotal?: number;
  format?: DownloadFormat;
}

export interface DependencyStatus {
  spotdl: boolean;
  ytdlp: boolean;
  ffmpeg: boolean;
  /** Python with mutagen + Pillow available (needed by the MP3 tagger). */
  tagger: boolean;
}

export interface ElectronAPI {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  selectFolder: (defaultPath?: string) => Promise<string | null>;
  startDownload: (request: DownloadTaskRequest) => Promise<{ taskId: string; success: boolean }>;
  cancelDownload: (taskId: string) => Promise<boolean>;
  onDownloadProgress: (callback: (data: DownloadProgressPayload) => void) => () => void;
  openFolder: (taskId?: string) => Promise<void>;
  focusWindow: () => Promise<void>;
  deleteDownloadedFile: (taskId: string) => Promise<{ success: boolean; errorCode?: 'noPath' | 'notOnDisk' | 'failed'; error?: string }>;
  checkDependencies: () => Promise<DependencyStatus>;
  resolveStreamUrl: (url: string) => Promise<{ success: boolean; data?: StreamMediaInfo; error?: string; errorCode?: StreamErrorCode }>;
  getPlaylist: (url: string, fresh?: boolean) => Promise<CatalogResult>;
  search: (query: string, limit?: number, fresh?: boolean) => Promise<CatalogResult>;
  probeMedia: (url: string) => Promise<ProbeResult>;
  /** Up-next list for the watch page: the video's YouTube Mix, else similar search results. */
  getRelated: (url: string, title?: string) => Promise<CatalogResult>;
  /** WebVTT text of one subtitle track (translated ones fall back to translating the original). */
  getSubtitle: (url: string, track: SubtitleTrack) => Promise<{ success: boolean; vtt?: string; error?: string }>;
  libraryList: () => Promise<LibraryPlaylist[]>;
  libraryCreate: (name: string, items?: LibraryItem[]) => Promise<LibraryPlaylist>;
  libraryRename: (id: string, name: string) => Promise<void>;
  libraryDelete: (id: string) => Promise<void>;
  libraryAddItems: (id: string, items: LibraryItem[]) => Promise<number>;
  libraryRemoveItem: (id: string, itemId: string) => Promise<void>;
  libraryImport: (url: string) => Promise<{ success: boolean; playlist?: LibraryPlaylist; error?: string }>;
  librarySync: (id: string) => Promise<{ success: boolean; added?: number; error?: string }>;
  /** Pick a playlist file (M3U/M3U8/PLS/XML/TXT) or a folder and import its local songs. */
  libraryImportLocal: (kind: 'file' | 'folder') => Promise<{ success: boolean; canceled?: boolean; playlist?: LibraryPlaylist; missing?: number; error?: string }>;
  onLibraryImportProgress: (callback: (p: { done: number; total: number }) => void) => () => void;
  onLibraryChanged: (callback: () => void) => () => void;
  getAppUpdateStatus: () => Promise<AppUpdateStatus>;
  checkAppUpdate: () => Promise<AppUpdateStatus>;
  onAppUpdateStatus: (callback: (s: AppUpdateStatus) => void) => () => void;
  getPowerState: () => Promise<PowerState>;
  onPowerState: (callback: (s: PowerState) => void) => () => void;
  /** Frees the renderer's image/resource caches (battery saver, window hidden) */
  trimMemory: () => void;
  getSetupStatus: () => Promise<SetupStatus>;
  runSetup: () => Promise<SetupResult>;
  onSetupProgress: (callback: (p: SetupProgress) => void) => () => void;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdate: () => Promise<UpdateStatus>;
  runUpdate: () => Promise<UpdateStatus>;
  onUpdateStatus: (callback: (s: UpdateStatus) => void) => () => void;
  getHistory: () => Promise<HistoryEntry[]>;
  removeHistory: (ids: string[]) => Promise<void>;
  clearHistory: () => Promise<void>;
  revealHistoryFile: (id: string) => Promise<boolean>;
  onHistoryChanged: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
