import { MediaProbe, ProbeResult, QualityOption } from '../../shared/types';
import { isAppleMusicUrl, isPlaylistUrl, isSpotifyUrl, searchQueryFor, sourceOf } from '../../shared/urls';
import { CatalogService } from './CatalogService';
import { StreamManager } from './StreamManager';
import { runYtDlpJson } from './processUtils';

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_HEIGHT = 1080;
/** yt-dlp `--audio-quality 0` (LAME V0) averages roughly 245 kbps. */
const MP3_V0_BPS = 245_000;

/**
 * The link preview: what a pasted link is, and every quality it can be downloaded in with its
 * real size, before anything is downloaded (a 4K AV1 file can be 4x the size of 1080p H.264).
 */
export class ProbeService {
  private cache = new Map<string, { at: number; data: MediaProbe }>();

  constructor(
    private catalog: CatalogService,
    private stream: StreamManager,
    private defaultHeight: () => number
  ) {}

  public async probe(rawUrl: string): Promise<ProbeResult> {
    const url = rawUrl.trim();
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { success: true, data: this.withDefaults(hit.data) };

    let result: ProbeResult;
    try {
      if (isPlaylistUrl(url)) result = await this.collection(url);
      else if (isSpotifyUrl(url)) result = await this.spotifyTrack(url);
      else if (isAppleMusicUrl(url)) result = await this.appleSong(url);
      else result = await this.single(url);
    } catch (err: any) {
      result = { success: false, error: err?.message ?? String(err) };
    }
    if (result.success && result.data) {
      this.cache.set(url, { at: Date.now(), data: result.data });
      result.data = this.withDefaults(result.data);
    }
    return result;
  }

  /** The default picks follow the "default video quality" setting at the time of asking. */
  private withDefaults(p: MediaProbe): MediaProbe {
    const videos = p.options.filter((o) => o.kind === 'video');
    const cap = this.defaultHeight() || Infinity;
    const fit = videos.filter((o) => (o.height ?? 0) <= cap);
    const pick = (fit.length ? fit : videos.slice(-1))[0];
    return { ...p, defaultVideo: pick?.id, defaultAudio: p.options.find((o) => o.kind === 'audio')?.id };
  }

  // ─────────────────────────────── Single video / track ───────────────────────────────

  private async single(url: string, overrides: Partial<MediaProbe> = {}): Promise<ProbeResult> {
    const { json: raw, error } = await runYtDlpJson(['-J', '--no-playlist', '--no-warnings', url], 60000);
    const json = raw && Array.isArray(raw.entries) ? raw.entries[0] : raw; // ytsearch1: returns a list
    if (!json) return { success: false, error };

    const formats: any[] = Array.isArray(json.formats) ? json.formats.filter((f: any) => f.protocol !== 'mhtml') : [];
    const hasVideo = (f: any) => f.vcodec && f.vcodec !== 'none';
    const hasAudio = (f: any) => f.acodec && f.acodec !== 'none';
    const size = (f: any): number | undefined => f?.filesize ?? f?.filesize_approx ?? undefined;
    const approx = (f: any) => !f?.filesize;

    // Original-language audio first (dubbed tracks have a lower language_preference), then AAC, then bitrate
    const audioOnly = formats.filter((f) => hasAudio(f) && !hasVideo(f));
    const audioRank = (f: any) => [
      f.language_preference ?? 0,
      /original/i.test(f.format_note ?? '') ? 1 : 0,
      f.ext === 'm4a' ? 1 : 0,
      f.abr ?? f.tbr ?? 0,
    ];
    const byRank = (a: any, b: any) => {
      const ra = audioRank(a);
      const rb = audioRank(b);
      for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
      return 0;
    };
    audioOnly.sort(byRank);
    const bestAudio = audioOnly[0];
    const bestM4a = audioOnly.find((f) => f.ext === 'm4a');

    const options: QualityOption[] = [];

    // Video: one option per height, the format we'd really download at that height
    const videoOnly = formats.filter((f) => hasVideo(f) && !hasAudio(f) && f.height);
    const progressive = formats.filter((f) => hasVideo(f) && hasAudio(f) && f.height);
    const codecRank = (f: any, h: number) => {
      const v = String(f.vcodec);
      // H.264 plays everywhere; above 1080p YouTube has no H.264, so AV1 (much smaller than VP9)
      if (h <= 1080) return v.startsWith('avc1') ? 3 : v.startsWith('av01') ? 2 : v.startsWith('vp') ? 1 : 0;
      return v.startsWith('av01') ? 3 : v.startsWith('vp') ? 2 : v.startsWith('avc1') ? 1 : 0;
    };
    const heights = [...new Set([...videoOnly, ...progressive].map((f) => f.height as number))].sort((a, b) => b - a);
    for (const h of heights) {
      const pool = videoOnly.filter((f) => f.height === h);
      let formatId: string;
      let vf: any;
      let bytes: number | undefined;
      let isApprox = false;
      if (pool.length && bestAudio) {
        pool.sort((a, b) => (b.fps ?? 0) - (a.fps ?? 0) || codecRank(b, h) - codecRank(a, h) || (size(a) ?? 1e15) - (size(b) ?? 1e15));
        vf = pool[0];
        // mp4 video gets AAC audio so the merge stays a plain MP4
        const af = String(vf.ext) === 'mp4' && bestM4a ? bestM4a : bestAudio;
        formatId = `${vf.format_id}+${af.format_id}`;
        bytes = size(vf) !== undefined && size(af) !== undefined ? size(vf)! + size(af)! : undefined;
        isApprox = approx(vf) || approx(af);
      } else {
        const prog = progressive.filter((f) => f.height === h).sort((a, b) => (size(b) ?? 0) - (size(a) ?? 0));
        if (!prog.length) continue;
        vf = prog[0];
        formatId = vf.format_id;
        bytes = size(vf);
        isApprox = approx(vf);
      }
      const codec = String(vf.vcodec).startsWith('avc1') ? 'H.264' : String(vf.vcodec).startsWith('av01') ? 'AV1' : String(vf.vcodec).startsWith('vp9') ? 'VP9' : '';
      options.push({
        id: `v${h}`,
        kind: 'video',
        label: h >= 2160 ? '4K' : h >= 1440 ? '1440p' : `${h}p`,
        detail: [vf.fps && vf.fps > 30 ? `${Math.round(vf.fps)}fps` : '', codec].filter(Boolean).join(' · '),
        height: h,
        formatId,
        sizeBytes: bytes,
        approx: isApprox,
      });
    }

    // Audio: MP3 (converted, tagged, plays everywhere) and the original AAC as M4A (no re-encode)
    const duration = typeof json.duration === 'number' ? json.duration : undefined;
    if (bestAudio || options.length) {
      options.push({
        id: 'a-mp3',
        kind: 'audio',
        label: 'MP3',
        detail: '320 kbps VBR',
        audioCodec: 'mp3',
        sizeBytes: duration ? (duration * MP3_V0_BPS) / 8 : undefined,
        approx: true,
      });
    }
    if (bestM4a) {
      options.push({
        id: 'a-m4a',
        kind: 'audio',
        label: 'M4A',
        detail: `AAC ${Math.round(bestM4a.abr ?? bestM4a.tbr ?? 128)} kbps`,
        audioCodec: 'm4a',
        formatId: bestM4a.format_id,
        sizeBytes: size(bestM4a),
        approx: approx(bestM4a),
      });
    }

    const data: MediaProbe = {
      url: json.webpage_url || url,
      kind: 'single',
      source: sourceOf(json.webpage_url || url),
      title: json.title || url,
      artist: json.artist || json.uploader || json.channel || undefined,
      thumbnail: json.thumbnail || undefined,
      duration,
      isLive: json.live_status === 'is_live' || json.is_live === true,
      isVideo: options.some((o) => o.kind === 'video'),
      options,
      ...overrides,
    };
    return { success: true, data };
  }

  // ─────────────────────────────── Spotify / Apple (audio only) ───────────────────────────────

  private async spotifyTrack(url: string): Promise<ProbeResult> {
    if (!/\/track\//i.test(url)) return { success: false, error: 'Spotify' };
    const meta = await this.stream.resolveSpotifyTrack(url);
    if (!meta) return { success: false, error: 'Spotify' };
    return {
      success: true,
      data: {
        url,
        kind: 'single',
        source: 'spotify',
        title: meta.title,
        artist: meta.artist,
        thumbnail: meta.thumbnail,
        isVideo: false,
        // spotdl picks the audio itself and writes MP3 with full Spotify metadata
        options: [{ id: 'a-mp3', kind: 'audio', label: 'MP3', detail: 'SpotDL · Spotify metadata', audioCodec: 'mp3' }],
      },
    };
  }

  /** An Apple Music song link: name from the page, audio from a matching YouTube result. */
  private async appleSong(url: string): Promise<ProbeResult> {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    const meta = (name: string) =>
      html.match(new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]*)"`, 'i'))?.[1]?.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
    const ogTitle = (meta('og:title') ?? '').replace(/\s+on Apple Music$/i, '');
    // "Song by Artist" — split on the last " by " (song titles may contain "by" too)
    const cut = ogTitle.lastIndexOf(' by ');
    const title = cut > 0 ? ogTitle.slice(0, cut) : ogTitle;
    const artist = cut > 0 ? ogTitle.slice(cut + 4) : undefined;
    if (!title) return { success: false, error: 'Apple Music' };
    const probed = await this.single(searchQueryFor(title, artist), { source: 'apple', title, artist, thumbnail: meta('og:image') });
    if (probed.data) {
      probed.data.url = searchQueryFor(title, artist);
      // Video formats belong to whatever YouTube video matched: offer the audio only
      probed.data.options = probed.data.options.filter((o) => o.kind === 'audio');
      probed.data.isVideo = false;
    }
    return probed;
  }

  // ─────────────────────────────── Playlists / albums ───────────────────────────────

  private async collection(url: string): Promise<ProbeResult> {
    const res = await this.catalog.getPlaylist(url);
    if (!res.success || !res.data) return { success: false, error: res.error ?? res.errorCode };
    const list = res.data;
    return {
      success: true,
      data: {
        url,
        kind: 'collection',
        source: list.source,
        title: list.title,
        thumbnail: list.thumbnail,
        duration: list.entries.reduce((s, e) => s + (e.duration ?? 0), 0) || undefined,
        isVideo: list.source === 'youtube',
        options: [],
        collectionKind: list.kind === 'album' ? 'album' : 'playlist',
        itemCount: list.totalCount ?? list.entries.length,
      },
    };
  }
}

export { DEFAULT_MAX_HEIGHT };
