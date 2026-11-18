import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { app } from 'electron';
import { CatalogEntry, LibraryItem, LibraryPlaylist, SkippedTrack } from '../../shared/types';
import { sourceOf, youTubeId } from '../../shared/urls';
import { CatalogService, ImportProgress } from './CatalogService';
import { LocalSource, parsePlaylistFile, scanFolder, toLibraryItems } from './LocalImport';

const MAX_ITEMS = 5000;

/** Only https images from the platform are kept as a playlist cover. */
const safeCover = (url?: string) => (url && /^https:\/\//i.test(url) && url.length <= 2000 ? url : undefined);

/** Skipped tracks as stored: bounded strings, https covers, at most 5000; undefined when none. */
function cleanSkipped(list?: SkippedTrack[]): SkippedTrack[] | undefined {
  if (!Array.isArray(list) || !list.length) return undefined;
  const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  return list.slice(0, 5000).map((s) => ({
    key: String(s.key).slice(0, 200),
    pos: s.pos,
    title: str(s.title) ?? '?',
    artist: str(s.artist),
    album: str(s.album),
    duration: typeof s.duration === 'number' && isFinite(s.duration) ? Math.round(s.duration) : undefined,
    cover: safeCover(s.cover),
    url: safeCover(s.url),
    reason: s.reason,
  }));
}

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * The user's own playlists (%APPDATA%/<app>/library.json). A playlist can mix music and video,
 * local files and online links, and can be imported from a YouTube / Spotify / SoundCloud /
 * Apple Music link (then it remembers its origin and can be refreshed).
 */
export class LibraryService {
  private filePath: string;
  private coversDir: string;
  private playlists: LibraryPlaylist[] = [];
  private listeners = new Set<() => void>();

  constructor(private catalog: CatalogService) {
    this.filePath = path.join(app.getPath('userData'), 'library.json');
    this.coversDir = path.join(app.getPath('userData'), 'covers');
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(parsed)) this.playlists = parsed.filter((p) => p && p.id && Array.isArray(p.items));
      }
    } catch (err) {
      console.error('[LibraryService] Failed to load library:', err);
    }
  }

  public onChange(l: () => void) {
    this.listeners.add(l);
  }

  public list(): LibraryPlaylist[] {
    return this.playlists.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }));
  }

  public create(name: string, items: LibraryItem[] = []): LibraryPlaylist {
    const now = Date.now();
    const playlist: LibraryPlaylist = {
      id: newId('pl'),
      name: name.trim().slice(0, 120) || 'Playlist',
      items: items.map((i) => this.clean(i)).filter(Boolean) as LibraryItem[],
      createdAt: now,
      updatedAt: now,
    };
    this.playlists.unshift(playlist);
    this.persist();
    return playlist;
  }

  public rename(id: string, name: string) {
    const p = this.find(id);
    if (!p || !name.trim()) return;
    p.name = name.trim().slice(0, 120);
    p.updatedAt = Date.now();
    this.persist();
  }

  /** Name and description from the edit dialog (the cover has its own calls). */
  public update(id: string, patch: { name?: string; description?: string }) {
    const p = this.find(id);
    if (!p) return;
    if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 120);
    if (typeof patch.description === 'string') {
      const d = patch.description.replace(/\r\n?/g, '\n').trim().slice(0, 1000);
      p.description = d || undefined;
    }
    p.updatedAt = Date.now();
    this.persist();
  }

  /**
   * The user's own picture for a playlist. The renderer has already cropped it to a square
   * JPEG (any format Chromium or ffmpeg can open goes in); here it is only checked and saved.
   */
  public setCustomCover(id: string, jpeg: Buffer): boolean {
    const p = this.find(id);
    if (!p || jpeg.length < 100 || jpeg.length > 8 * 1024 * 1024) return false;
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return false;
    try {
      fs.mkdirSync(this.coversDir, { recursive: true });
      // A new name each time, so the <img> doesn't show the old picture from its cache
      const file = path.join(this.coversDir, `playlist_${p.id}_${Date.now().toString(36)}.jpg`);
      fs.writeFileSync(file, jpeg);
      this.deleteCustomCover(p);
      p.customCover = pathToFileURL(file).href;
    } catch (err) {
      console.error('[LibraryService] Failed to save cover:', err);
      return false;
    }
    p.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** Back to the platform's cover, or the 4-track mosaic. */
  public clearCustomCover(id: string) {
    const p = this.find(id);
    if (!p?.customCover) return;
    this.deleteCustomCover(p);
    p.updatedAt = Date.now();
    this.persist();
  }

  private deleteCustomCover(p: LibraryPlaylist) {
    if (!p.customCover) return;
    try {
      const file = fileURLToPath(p.customCover);
      // Only ever delete our own files
      if (path.dirname(path.resolve(file)).toLowerCase() === path.resolve(this.coversDir).toLowerCase()) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
    p.customCover = undefined;
  }

  public remove(id: string) {
    const gone = this.find(id);
    if (gone) this.deleteCustomCover(gone);
    this.playlists = this.playlists.filter((p) => p.id !== id);
    this.persist();
  }

  /** Adds items, skipping ones already in the playlist (same link or same file). Returns how many were added. */
  public addItems(id: string, items: LibraryItem[]): number {
    const p = this.find(id);
    if (!p) return 0;
    const key = (i: LibraryItem) => (i.filePath ? `f:${i.filePath.toLowerCase()}` : `u:${i.url}`);
    const have = new Set(p.items.map(key));
    let added = 0;
    for (const raw of items) {
      const item = this.clean(raw);
      if (!item || have.has(key(item)) || p.items.length >= MAX_ITEMS) continue;
      have.add(key(item));
      p.items.push(item);
      added++;
    }
    if (added) {
      p.updatedAt = Date.now();
      this.persist();
    }
    return added;
  }

  public removeItem(id: string, itemId: string) {
    const p = this.find(id);
    if (!p) return;
    p.items = p.items.filter((i) => i.id !== itemId);
    p.updatedAt = Date.now();
    this.persist();
  }

  public async importFrom(
    url: string,
    onProgress: ImportProgress = () => {}
  ): Promise<{ success: boolean; playlist?: LibraryPlaylist; error?: string }> {
    const res = await this.catalog.getPlaylist(url, true, onProgress);
    if (!res.success || !res.data) return { success: false, error: res.error ?? res.errorCode };
    const list = res.data;
    const playlist = this.create(list.title, list.entries.map((e) => this.fromEntry(e, list.source)));
    playlist.origin = { source: list.source, url };
    playlist.cover = safeCover(list.cover);
    playlist.description = list.description;
    playlist.skipped = cleanSkipped(list.skipped);
    this.persist();
    return { success: true, playlist: this.list().find((p) => p.id === playlist.id) };
  }

  /**
   * Puts a YouTube copy of a skipped track into the playlist at the track's own place, with the
   * platform's title, artist, length and cover (so downloads are tagged like the rest).
   */
  public restoreSkipped(id: string, key: string, youtubeUrl: string): { success: boolean; position?: number; error?: 'notFound' | 'badUrl' } {
    const p = this.find(id);
    const s = p?.skipped?.find((x) => x.key === key);
    if (!p || !s) return { success: false, error: 'notFound' };
    const vid = /^https:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i.test(youtubeUrl.trim()) ? youTubeId(youtubeUrl.trim()) : null;
    if (!vid) return { success: false, error: 'badUrl' };
    const item: LibraryItem = {
      id: newId('it'),
      title: s.title,
      artist: s.artist,
      duration: s.duration,
      thumbnail: s.cover,
      url: `https://www.youtube.com/watch?v=${vid}`,
      source: 'youtube',
      isVideo: false, // stands in for a song: plays and downloads as music
      pos: s.pos,
    };
    const position = this.placeByPos(p, item);
    this.markSkippedDone(p, key);
    return { success: true, position: position + 1 };
  }

  public dismissSkipped(id: string, key: string) {
    const p = this.find(id);
    if (p?.skipped?.some((x) => x.key === key)) this.markSkippedDone(p, key);
  }

  private markSkippedDone(p: LibraryPlaylist, key: string) {
    p.skipped = (p.skipped ?? []).filter((x) => x.key !== key);
    p.skippedDone = [...new Set([...(p.skippedDone ?? []), key])].slice(-5000);
    p.updatedAt = Date.now();
    this.persist();
  }

  /**
   * Inserts before the first item that came later in the source list. Items without a place
   * (added by hand) stay at the end. Returns the index used.
   */
  private placeByPos(p: LibraryPlaylist, item: LibraryItem): number {
    const pos = item.pos ?? Infinity;
    let at = p.items.findIndex((i) => typeof i.pos === 'number' && i.pos > pos);
    if (at < 0) {
      // After the last item that has a place; a list without places gets it by number
      let last = -1;
      p.items.forEach((i, idx) => typeof i.pos === 'number' && (last = idx));
      at = last >= 0 ? last + 1 : Math.min(Number.isFinite(pos) ? pos : p.items.length, p.items.length);
    }
    p.items.splice(at, 0, item);
    return at;
  }

  /**
   * Imports local music: a playlist file exported from Apple Music / iTunes / any player
   * (M3U, M3U8, PLS, XML, TXT) or a whole folder. Tags and covers come from the files.
   */
  public async importLocal(
    target: string,
    kind: 'file' | 'folder',
    onProgress: (done: number, total: number) => void
  ): Promise<{ success: boolean; playlist?: LibraryPlaylist; missing?: number; error?: string }> {
    let source: LocalSource;
    try {
      source = kind === 'folder' ? scanFolder(target) : parsePlaylistFile(target);
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }
    if (!source.entries.length) return { success: false, error: 'no songs found' };
    const { items, missing } = await toLibraryItems(source.entries, this.coversDir, onProgress);
    if (!items.length) return { success: false, missing, error: 'files not found' };
    const playlist = this.create(source.name, items);
    playlist.origin = { source: 'local', url: target, kind };
    this.persist();
    return { success: true, playlist: this.list().find((p) => p.id === playlist.id), missing };
  }

  /** Re-reads an imported playlist and appends what is new there (nothing is removed). */
  public async sync(id: string): Promise<{ success: boolean; added?: number; error?: string }> {
    const p = this.find(id);
    if (!p?.origin) return { success: false, error: 'not imported' };
    if (p.origin.source === 'local') {
      try {
        const src = p.origin.kind === 'folder' ? scanFolder(p.origin.url) : parsePlaylistFile(p.origin.url);
        const have = new Set(p.items.map((i) => (i.filePath ?? '').toLowerCase()));
        const fresh = src.entries.filter((e) => !have.has(e.path.toLowerCase()));
        const { items } = await toLibraryItems(fresh, this.coversDir, () => {});
        return { success: true, added: this.addItems(id, items) };
      } catch (err: any) {
        return { success: false, error: err?.message };
      }
    }
    const res = await this.catalog.getPlaylist(p.origin.url, true);
    if (!res.success || !res.data) return { success: false, error: res.error ?? res.errorCode };
    const data = res.data;
    // The platform's picture may have changed (a custom one the user picked here still wins)
    p.cover = safeCover(data.cover);
    // An empty description is filled from the platform; one the user wrote is kept
    if (!p.description && data.description) p.description = data.description;
    // Playlists imported before 2.13 have no places yet: take them from the fresh list
    const posByUrl = new Map(data.entries.map((e) => [e.url, e.pos]));
    for (const i of p.items) if (i.pos === undefined && posByUrl.get(i.url) !== undefined) i.pos = posByUrl.get(i.url);
    // New tracks go to their place in the list, not to the end
    const have = new Set(p.items.map((i) => i.url));
    let added = 0;
    for (const e of data.entries) {
      if (have.has(e.url) || p.items.length >= MAX_ITEMS) continue;
      have.add(e.url);
      this.placeByPos(p, this.fromEntry(e, data.source));
      added++;
    }
    // Skipped tracks: the current ones, minus those already replaced or ignored
    const done = new Set(p.skippedDone ?? []);
    p.skipped = cleanSkipped(data.skipped)?.filter((s) => !done.has(s.key));
    p.updatedAt = Date.now();
    this.persist();
    return { success: true, added };
  }

  private fromEntry(e: CatalogEntry, source: LibraryItem['source']): LibraryItem {
    return {
      id: newId('it'),
      title: e.title,
      artist: e.artist,
      duration: e.duration,
      thumbnail: e.thumbnail,
      url: e.url,
      source,
      isVideo: source === 'youtube',
      pos: e.pos,
    };
  }

  /** Never trust the renderer's objects: keep known fields, bounded strings, safe URLs. */
  private clean(i: LibraryItem): LibraryItem | null {
    if (!i || typeof i !== 'object') return null;
    const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const url = str(i.url, 2000) ?? '';
    const filePath = str(i.filePath, 1000);
    if (!/^(https?:\/\/|ytsearch\d*:)/i.test(url) && !filePath) return null;
    const thumb = str(i.thumbnail, 2000);
    return {
      id: newId('it'),
      title: str(i.title) ?? url,
      artist: str(i.artist),
      duration: typeof i.duration === 'number' && isFinite(i.duration) ? Math.round(i.duration) : undefined,
      thumbnail: thumb && /^(https:|file:)/i.test(thumb) ? thumb : undefined,
      url: /^(https?:\/\/|ytsearch\d*:)/i.test(url) ? url : '',
      filePath,
      source: filePath && !url ? 'local' : (i.source ?? sourceOf(url)),
      isVideo: !!i.isVideo,
      pos: Number.isInteger(i.pos) && (i.pos as number) >= 0 ? i.pos : undefined,
    };
  }

  private find(id: string) {
    return this.playlists.find((p) => p.id === id);
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.playlists, null, 1), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[LibraryService] Failed to save library:', err);
    }
    for (const l of this.listeners) l();
  }
}
