import { CatalogEntry, CatalogList, CatalogResult, SkippedTrack } from '../../shared/types';
import { isAppleCollection, isSoundCloudSet, isSpotifyCollection, isYouTubePlaylist, searchQueryFor, youTubeId } from '../../shared/urls';
import { spawn } from 'child_process';
import { UTF8_ENV, killTree, readLines, runYtDlpJson, runYtDlpLines } from './processUtils';
import { engineCommand } from './tools';

/** Max items read from a YouTube/SoundCloud playlist (flat listing, ~100 items per request). */
const YT_PLAYLIST_LIMIT = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Lists the contents of playlists/albums (for the preview dialog) and runs YouTube
 * searches (for the Explore tab). No accounts or API keys involved:
 *  - YouTube: `yt-dlp --flat-playlist -J` (playlist pages, chart playlists, ytsearchN:)
 *  - Spotify: the engine's `spotify-list` (complete list, each track with its own cover);
 *    without the engine, the public embed page (first 100 tracks, playlist cover only).
 */
export class CatalogService {
  private cache = new Map<string, { at: number; data: CatalogList }>();

  /**
   * @param fresh skip the cache (Explore refreshes every time it is opened)
   * @param onProgress tracks read so far, and the list's size once it is known
   */
  public async getPlaylist(url: string, fresh = false, onProgress?: ImportProgress): Promise<CatalogResult> {
    const key = `pl:${url}`;
    const cached = fresh ? null : this.fromCache(key);
    if (cached) return { success: true, data: cached };

    const progress: ImportProgress = onProgress ?? (() => {});
    let result: CatalogResult;
    if (isSpotifyCollection(url)) result = await this.spotifyCollection(url, progress);
    else if (isYouTubePlaylist(url)) result = await this.youtubePlaylist(url, progress);
    else if (isSoundCloudSet(url)) result = await this.soundCloudSet(url, progress);
    else if (isAppleCollection(url)) result = await this.appleCollection(url);
    else return { success: false, errorCode: 'unsupported' };

    if (result.success && result.data) this.cache.set(key, { at: Date.now(), data: result.data });
    return result;
  }

  public async search(query: string, limit = 30, fresh = false): Promise<CatalogResult> {
    const q = query.trim();
    if (!q) return { success: false, errorCode: 'notFound' };
    const n = Math.min(Math.max(Math.floor(limit), 1), 100);
    const key = `s:${n}:${q}`;
    const cached = fresh ? null : this.fromCache(key);
    if (cached) return { success: true, data: cached };

    const { json, error } = await runYtDlpJson(['--flat-playlist', '-J', '--no-warnings', `ytsearch${n}:${q}`]);
    if (!json) return { success: false, errorCode: 'failed', error };
    const data: CatalogList = {
      source: 'youtube',
      kind: 'search',
      title: q,
      entries: this.youtubeEntries(json.entries),
    };
    this.cache.set(key, { at: Date.now(), data });
    return { success: true, data };
  }

  private fromCache(key: string): CatalogList | null {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
    this.cache.delete(key);
    return null;
  }

  // ─────────────────────────────── YouTube ───────────────────────────────

  /**
   * One line per video as yt-dlp reads the playlist page by page (~100 per request), so a long
   * list reports progress, then one line with the playlist itself (title, description, artwork).
   */
  private async youtubePlaylist(url: string, onProgress: ImportProgress): Promise<CatalogResult> {
    const raw: any[] = [];
    let meta: any = null;
    let total: number | undefined;
    const { code, error } = await runYtDlpLines(
      [
        '--flat-playlist', '--no-warnings', '-I', `1:${YT_PLAYLIST_LIMIT}`,
        '-O', 'video:V%(.{id,title,channel,uploader,duration,view_count,live_status,url,ie_key,playlist_count})j',
        '-O', 'playlist:P%(.{title,description,thumbnails,playlist_count})j',
        url,
      ],
      (line) => {
        try {
          if (line.startsWith('V')) {
            const e = JSON.parse(line.slice(1));
            raw.push(e);
            if (typeof e.playlist_count === 'number') total = Math.min(e.playlist_count, YT_PLAYLIST_LIMIT);
            if (raw.length % 25 === 0) onProgress(raw.length, total);
          } else if (line.startsWith('P')) meta = JSON.parse(line.slice(1));
        } catch {
          /* not one of our lines */
        }
      }
    );
    const entries = this.youtubeEntries(raw);
    if (entries.length === 0) return { success: false, errorCode: code === 0 ? 'notFound' : 'failed', error };
    onProgress(raw.length, total ?? raw.length);
    const count = typeof meta?.playlist_count === 'number' ? meta.playlist_count : total;
    // A playlist without its own picture shows its first video's thumbnail (i.ytimg.com/vi/<id>/)
    const thumbs: any[] = Array.isArray(meta?.thumbnails) ? meta.thumbnails.filter((t: any) => typeof t?.url === 'string') : [];
    const best = thumbs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url as string | undefined;
    const custom = best && /^https:/.test(best) && !/\/vi(_webp)?\//.test(best) ? best : undefined;
    return {
      success: true,
      data: {
        source: 'youtube',
        kind: 'playlist',
        title: meta?.title || 'YouTube Playlist',
        thumbnail: custom ?? entries[0]?.thumbnail,
        cover: custom,
        description: cleanText(meta?.description),
        entries,
        totalCount: count && count > entries.length ? count : undefined,
      },
    };
  }

  private youtubeEntries(raw: any[] | undefined): CatalogEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: CatalogEntry[] = [];
    for (const e of raw) {
      if (!e || !e.id) continue;
      // Skip channels/playlists that can show up in search results, and deleted/private videos
      if (e.ie_key && e.ie_key !== 'Youtube') continue;
      if (/^\[(Deleted|Private) video\]$/i.test(e.title || '')) continue;
      out.push({
        id: e.id,
        url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title || e.id,
        artist: e.channel || e.uploader || undefined,
        duration: typeof e.duration === 'number' ? Math.round(e.duration) : undefined,
        // Predictable 320x180 thumbnail; the flat listing's own thumbnail URLs vary a lot
        thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        viewCount: typeof e.view_count === 'number' ? e.view_count : undefined,
        isLive: e.live_status === 'is_live' || undefined,
      });
    }
    return out;
  }

  // ─────────────────────────────── Spotify ───────────────────────────────

  /**
   * Whole playlist/album through the engine (spotapi pages through the web player's API).
   * null when the engine isn't there or the run failed, so the embed page is used instead.
   */
  private spotifyFull(url: string, onProgress: ImportProgress): Promise<CatalogResult | null> {
    const engine = engineCommand('spotify-list');
    if (!engine) return Promise.resolve(null);
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      let stderr = '';
      const child = spawn(engine.cmd, [...engine.prefix, url], { shell: false, windowsHide: true, env: UTF8_ENV });
      const timer = setTimeout(() => killTree(child), 5 * 60 * 1000);
      child.stdout!.on('data', (d: Buffer) => out.push(d));
      readLines(child.stderr!, (l) => {
        const m = l.match(/^__PROGRESS__ (\d+) (\d+)/);
        if (m) onProgress(Number(m[1]), Number(m[2]) || undefined);
        else stderr += l + '\n';
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const d = JSON.parse(Buffer.concat(out).toString('utf8'));
          if (code !== 0 || !Array.isArray(d?.tracks) || d.tracks.length === 0) throw new Error(stderr.trim().split('\n').pop());
          const entries: CatalogEntry[] = d.tracks.map((t: any) => ({
            id: t.id,
            url: `https://open.spotify.com/track/${t.id}`,
            title: t.title,
            artist: t.artist ?? undefined,
            duration: t.duration ?? undefined,
            thumbnail: t.cover ?? d.cover ?? undefined,
            pos: typeof t.pos === 'number' ? t.pos : undefined,
          }));
          const skipped: SkippedTrack[] = (Array.isArray(d.skipped) ? d.skipped : [])
            .filter((s: any) => typeof s?.pos === 'number')
            .map((s: any) => ({
              key: s.id ? `sp:${s.id}` : `pos:${s.pos}:${s.title ?? ''}`,
              pos: s.pos,
              title: s.title || '?',
              artist: s.artist ?? undefined,
              album: s.album ?? undefined,
              duration: s.duration ?? undefined,
              cover: s.cover ?? undefined,
              url: s.id ? `https://open.spotify.com/track/${s.id}` : undefined,
              reason: ['region', 'local', 'episode'].includes(s.reason) ? s.reason : 'unavailable',
            }));
          const cover = spotifyDesignedCover(d.cover);
          resolve({
            success: true,
            data: {
              source: 'spotify',
              kind: d.kind,
              title: d.title,
              thumbnail: d.cover ?? entries[0]?.thumbnail,
              cover,
              description: cleanText(d.description),
              entries,
              skipped,
            },
          });
        } catch (err: any) {
          console.warn('[catalog] spotify-list failed, using the embed page:', err?.message);
          resolve(null);
        }
      });
    });
  }

  private async spotifyCollection(url: string, onProgress: ImportProgress): Promise<CatalogResult> {
    const full = await this.spotifyFull(url, onProgress);
    if (full) return full;
    const m = url.match(/\/(playlist|album)\/([A-Za-z0-9]+)/i);
    if (!m) return { success: false, errorCode: 'unsupported' };
    const type = m[1].toLowerCase() as 'playlist' | 'album';
    const id = m[2];

    let html: string;
    try {
      const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { success: false, errorCode: res.status === 404 ? 'notFound' : 'failed', error: `HTTP ${res.status}` };
      html = await res.text();
    } catch (err: any) {
      return { success: false, errorCode: 'failed', error: err?.message };
    }

    const script = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!script) return { success: false, errorCode: 'failed', error: 'embed data not found' };
    let entity: any;
    try {
      entity = JSON.parse(script[1])?.props?.pageProps?.state?.data?.entity;
    } catch (err: any) {
      return { success: false, errorCode: 'failed', error: err?.message };
    }
    if (!entity || !Array.isArray(entity.trackList)) return { success: false, errorCode: 'notFound' };

    const cover = this.pickSpotifyImage(entity);
    const entries: CatalogEntry[] = [];
    const skipped: SkippedTrack[] = [];
    entity.trackList.forEach((t: any, pos: number) => {
      const trackId = typeof t.uri === 'string' && t.uri.startsWith('spotify:track:') ? t.uri.split(':').pop() : undefined;
      const artist = typeof t.subtitle === 'string' ? t.subtitle.replace(/\u00a0/g, ' ') : undefined;
      const duration = typeof t.duration === 'number' ? Math.round(t.duration / 1000) : undefined;
      if (!trackId || t.isPlayable === false) {
        // The embed page does not say why; usually "not available in your country"
        skipped.push({
          key: trackId ? `sp:${trackId}` : `pos:${pos}:${t.title ?? ''}`,
          pos,
          title: t.title || '?',
          artist,
          duration,
          cover,
          url: trackId ? `https://open.spotify.com/track/${trackId}` : undefined,
          reason: typeof t.uri === 'string' && t.uri.startsWith('spotify:local:') ? 'local' : 'unavailable',
        });
        return;
      }
      entries.push({ id: trackId, url: `https://open.spotify.com/track/${trackId}`, title: t.title || trackId, artist, duration, thumbnail: cover, pos });
    });
    if (entries.length === 0) return { success: false, errorCode: 'notFound' };

    return {
      success: true,
      data: {
        source: 'spotify',
        kind: type,
        title: entity.name || entity.title || 'Spotify',
        thumbnail: cover,
        cover: spotifyDesignedCover(cover),
        description: cleanText(entity.description),
        entries,
        skipped,
      },
    };
  }

  // ─────────────────────────────── Up next (watch page) ───────────────────────────────

  /**
   * Recommendations without an account: YouTube's own "Mix" for the video (music videos have
   * one), else a search for similar titles. The current video is left out.
   */
  public async related(url: string, title?: string): Promise<CatalogResult> {
    const id = youTubeId(url);
    const key = `rel:${id ?? url}`;
    const cached = this.fromCache(key);
    if (cached) return { success: true, data: cached };

    let entries: CatalogEntry[] = [];
    if (id) {
      const { json } = await runYtDlpJson(['--flat-playlist', '-J', '--no-warnings', '-I', '1:25', `https://www.youtube.com/watch?v=${id}&list=RD${id}`], 30000);
      if (json && Array.isArray(json.entries)) entries = this.youtubeEntries(json.entries);
    }
    if (entries.filter((e) => e.id !== id).length < 4 && title) {
      // Drop noise like "(Official Video)" and bracketed tags so the search finds the topic
      const q = title.replace(/[\[(【].*?[\])】]/g, ' ').replace(/[|｜:–-].*$/, '').trim() || title;
      const res = await this.search(q, 20);
      if (res.success && res.data) entries = [...entries, ...res.data.entries];
    }
    const seen = new Set<string>(id ? [id] : []);
    const unique = entries.filter((e) => !seen.has(e.id) && seen.add(e.id) && !e.isLive);
    const data: CatalogList = { source: 'youtube', kind: 'search', title: title ?? '', entries: unique.slice(0, 20) };
    if (unique.length) this.cache.set(key, { at: Date.now(), data });
    return { success: true, data };
  }

  // ─────────────────────────────── SoundCloud ───────────────────────────────

  /**
   * yt-dlp's flat listing of a set is fast (~2 s) but has no titles; a full extraction takes
   * ~45 s for 55 tracks. So: flat list, then SoundCloud's public oEmbed (8 at a time) for names.
   */
  private async soundCloudSet(url: string, onProgress: ImportProgress): Promise<CatalogResult> {
    const { json, error } = await runYtDlpJson(['--flat-playlist', '-J', '--no-warnings', '-I', `1:${YT_PLAYLIST_LIMIT}`, url]);
    if (!json || !Array.isArray(json.entries)) return { success: false, errorCode: 'failed', error };

    const raw: any[] = json.entries.filter((e: any) => e?.url);
    const entries: CatalogEntry[] = new Array(raw.length);
    let next = 0;
    let done = 0;
    onProgress(0, raw.length);
    const worker = async () => {
      while (next < raw.length) {
        const i = next++;
        const e = raw[i];
        const trackUrl: string = e.url;
        let title: string | undefined = e.title;
        let artist: string | undefined = e.uploader;
        let thumbnail: string | undefined;
        try {
          const res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(trackUrl)}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const o: any = await res.json();
            artist = o.author_name || artist;
            // oEmbed titles read "Song by Artist"
            title = (o.title || title || '').replace(new RegExp(`\\s+by\\s+${escapeRegExp(artist ?? '')}$`, 'i'), '');
            thumbnail = o.thumbnail_url;
          }
        } catch {
          /* keep what yt-dlp gave */
        }
        if (!title) title = slugTitle(trackUrl);
        if (++done % 8 === 0) onProgress(done, raw.length);
        entries[i] = {
          id: String(e.id ?? trackUrl),
          url: trackUrl,
          title,
          artist,
          duration: typeof e.duration === 'number' ? Math.round(e.duration) : undefined,
          thumbnail,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, raw.length) }, worker));
    // A set has thumbnails only when it has its own artwork (otherwise SoundCloud shows a track's)
    const setThumbs: any[] = Array.isArray(json.thumbnails) ? json.thumbnails : [];
    const cover: string | undefined = (setThumbs.find((t) => t?.id === 't500x500') ?? setThumbs.find((t) => t?.id === 't300x300'))?.url;
    const list = entries.filter(Boolean);
    if (list.length === 0) return { success: false, errorCode: 'notFound' };
    return {
      success: true,
      data: {
        source: 'soundcloud',
        kind: 'playlist',
        title: json.title || 'SoundCloud',
        thumbnail: cover ?? list[0]?.thumbnail,
        cover,
        description: cleanText(json.description),
        entries: list,
      },
    };
  }

  // ─────────────────────────────── Apple Music ───────────────────────────────

  /**
   * The public playlist/album page carries its track list as JSON (serialized-server-data).
   * Apple tracks can't be streamed or downloaded directly, so each entry gets a YouTube search
   * query (artist - title) that yt-dlp resolves when it is played or downloaded.
   */
  private async appleCollection(url: string): Promise<CatalogResult> {
    let html: string;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { success: false, errorCode: res.status === 404 ? 'notFound' : 'failed', error: `HTTP ${res.status}` };
      html = await res.text();
    } catch (err: any) {
      return { success: false, errorCode: 'failed', error: err?.message };
    }
    const m = html.match(/<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/);
    if (!m) return { success: false, errorCode: 'failed', error: 'page data not found' };
    let sections: any[] = [];
    try {
      sections = JSON.parse(m[1])?.data?.[0]?.data?.sections ?? [];
    } catch (err: any) {
      return { success: false, errorCode: 'failed', error: err?.message };
    }
    const header = sections.find((s) => /header/i.test(s?.id ?? ''))?.items?.[0];
    const art = (a: any, size = 300): string | undefined =>
      typeof a?.dictionary?.url === 'string' ? a.dictionary.url.replace('{w}', String(size)).replace('{h}', String(size)).replace('{f}', 'jpg') : undefined;

    const entries: CatalogEntry[] = [];
    for (const section of sections) {
      for (const it of section?.items ?? []) {
        if (it?.contentDescriptor?.kind !== 'song' || !it.title) continue;
        const artist = it.artistName || it.subtitleLinks?.[0]?.title;
        entries.push({
          id: String(it.contentDescriptor.identifiers?.storeAdamID ?? it.id),
          url: searchQueryFor(it.title, artist),
          title: it.title,
          artist,
          duration: typeof it.duration === 'number' ? Math.round(it.duration / 1000) : undefined,
          thumbnail: art(it.artwork) ?? art(header?.artwork),
        });
      }
    }
    if (entries.length === 0) return { success: false, errorCode: 'notFound' };
    return {
      success: true,
      data: {
        source: 'apple',
        kind: /\/album\//i.test(url) ? 'album' : 'playlist',
        title: header?.title || 'Apple Music',
        thumbnail: art(header?.artwork, 600) ?? entries[0].thumbnail,
        cover: art(header?.artwork, 600),
        entries,
      },
    };
  }

  private pickSpotifyImage(entity: any): string | undefined {
    const sources: any[] =
      entity?.coverArt?.sources ?? entity?.visualIdentity?.image ?? entity?.images ?? [];
    if (!Array.isArray(sources) || sources.length === 0) return undefined;
    const sorted = [...sources].sort((a, b) => (b.maxHeight || b.height || 0) - (a.maxHeight || a.height || 0));
    return sorted[0]?.url;
  }
}

/** Progress of a long listing: tracks read so far, and the list's size once it is known. */
export type ImportProgress = (done: number, total?: number) => void;

/**
 * Spotify draws a 2x2 collage (mosaic.scdn.co) for playlists nobody gave a picture; Harbor
 * draws its own mosaic then, so only a designed image counts as the playlist's cover.
 */
function spotifyDesignedCover(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.startsWith('https://')) return undefined;
  try {
    return new URL(url).hostname === 'mosaic.scdn.co' ? undefined : url;
  } catch {
    return undefined;
  }
}

/** Plain, trimmed description text (or undefined), at most 1000 characters. */
function cleanText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? text.slice(0, 1000) : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "https://soundcloud.com/user/some-track-name" → "Some Track Name" */
function slugTitle(url: string): string {
  const slug = url.split('?')[0].split('/').filter(Boolean).pop() ?? url;
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
