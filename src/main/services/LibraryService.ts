import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { CatalogEntry, LibraryItem, LibraryPlaylist } from '../../shared/types';
import { sourceOf } from '../../shared/urls';
import { CatalogService } from './CatalogService';
import { LocalSource, parsePlaylistFile, scanFolder, toLibraryItems } from './LocalImport';

const MAX_ITEMS = 5000;

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

  public remove(id: string) {
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

  public async importFrom(url: string): Promise<{ success: boolean; playlist?: LibraryPlaylist; error?: string }> {
    const res = await this.catalog.getPlaylist(url, true);
    if (!res.success || !res.data) return { success: false, error: res.error ?? res.errorCode };
    const list = res.data;
    const playlist = this.create(list.title, list.entries.map((e) => this.fromEntry(e, list.source)));
    playlist.origin = { source: list.source, url };
    this.persist();
    return { success: true, playlist: this.list().find((p) => p.id === playlist.id) };
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
    const added = this.addItems(id, res.data.entries.map((e) => this.fromEntry(e, res.data!.source)));
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
