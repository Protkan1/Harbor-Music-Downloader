import { AudioTrack, StreamErrorCode, StreamFormatOption, StreamMediaInfo, SubtitleTrack } from '../../shared/types';
import { runYtDlpJson } from './processUtils';

type ResolveResult = { success: boolean; data?: StreamMediaInfo; error?: string; errorCode?: StreamErrorCode };

const MAX_FORMATS = 8;

/** Languages offered as machine-translated subtitles. */
const TRANSLATION_LANGS = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'ja', 'ko', 'zh-Hans', 'hi', 'nl', 'pl', 'uk', 'az'];

export class StreamManager {
  /** Battery saver: prefer H.264 (hardware-decoded almost everywhere) over VP9/AV1. */
  private preferH264: () => boolean = () => false;
  public setPreferH264(fn: () => boolean) {
    this.preferH264 = fn;
  }

  /**
   * Resolves a media URL (YouTube, Spotify, SoundCloud, etc.) into direct playable streams.
   */
  public async resolveMedia(inputUrl: string): Promise<ResolveResult> {
    try {
      let targetUrl = inputUrl.trim();
      let spotifyMeta: { title: string; artist?: string; thumbnail?: string } | null = null;

      if (/(^|\.)spotify\.com\//i.test(targetUrl)) {
        if (!/\/track\//i.test(targetUrl)) {
          return { success: false, errorCode: 'spotifyNotTrack' };
        }
        spotifyMeta = await this.resolveSpotifyTrack(targetUrl);
        if (!spotifyMeta) {
          return { success: false, errorCode: 'spotifyLookupFailed' };
        }
        const query = [spotifyMeta.artist, spotifyMeta.title].filter(Boolean).join(' - ');
        targetUrl = `ytsearch1:${query} audio`;
      }

      const { json, error } = await this.extractYtDlpJson(targetUrl);
      if (!json) {
        return { success: false, errorCode: 'resolveFailed', error };
      }

      const formats = this.buildFormats(json);
      const mainStreamUrl = formats[0]?.url || json.url || '';
      if (!mainStreamUrl) {
        return { success: false, errorCode: 'resolveFailed' };
      }

      // Spotify: play audio only, but show the Spotify metadata & cover
      const audioOnly = spotifyMeta !== null;
      const shownFormats = audioOnly ? formats.filter((f) => !f.isVideo) : formats;

      const mediaInfo: StreamMediaInfo = {
        title: spotifyMeta?.title || json.title || '',
        uploader: spotifyMeta?.artist || json.uploader || json.channel || json.artist || '',
        thumbnail: spotifyMeta?.thumbnail || json.thumbnail || '',
        duration: json.duration || 0,
        durationStr: this.formatDuration(json.duration || 0),
        streamUrl: shownFormats[0]?.url || mainStreamUrl,
        formats: shownFormats,
        isVideo: !audioOnly && shownFormats.some((f) => f.isVideo),
        webpageUrl: spotifyMeta ? inputUrl : json.webpage_url || inputUrl,
        subtitles: spotifyMeta ? [] : this.subtitleTracks(json),
        audioTracks: spotifyMeta ? [] : this.audioTracks(json),
      };

      return { success: true, data: mediaInfo };
    } catch (err: any) {
      console.error('StreamManager error:', err);
      return { success: false, errorCode: 'unknown', error: err?.message };
    }
  }

  /**
   * Builds the quality list. YouTube only offers progressive (video+audio) streams up to
   * 360p/720p; 1080p and above are video-only DASH streams, so those get the best audio
   * stream attached as `audioUrl` and the renderer plays both in sync.
   */
  private buildFormats(json: any): StreamFormatOption[] {
    if (!Array.isArray(json.formats)) return [];

    // Only formats a <video>/<audio> element can play directly from a URL
    const playable = json.formats.filter(
      (f: any) => f.url && (f.protocol === 'https' || f.protocol === 'http')
    );
    const hasVideo = (f: any) => f.vcodec && f.vcodec !== 'none';
    const hasAudio = (f: any) => f.acodec && f.acodec !== 'none';
    const byQuality = (a: any, b: any) =>
      (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0);

    const audioOnly = playable.filter((f: any) => !hasVideo(f) && hasAudio(f));
    // Original language first: on videos with AI dubbing, the highest bitrate may be a dub
    audioOnly.sort(
      (a: any, b: any) =>
        (b.language_preference ?? 0) - (a.language_preference ?? 0) ||
        (/original/i.test(b.format_note ?? '') ? 1 : 0) - (/original/i.test(a.format_note ?? '') ? 1 : 0) ||
        (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)
    );
    const bestAudio = audioOnly[0];

    const progressive = playable.filter((f: any) => hasVideo(f) && hasAudio(f)).sort(byQuality);
    const videoOnly = bestAudio ? playable.filter((f: any) => hasVideo(f) && !hasAudio(f)).sort(byQuality) : [];

    const out: StreamFormatOption[] = [];
    const seenHeights = new Set<number>();

    // Merge both lists; for each height keep the best option. At equal height & fps a
    // progressive stream wins over a higher-bitrate video-only one (no audio sync needed).
    const candidates = [...progressive.map((f: any) => ({ f, progressive: true })), ...videoOnly.map((f: any) => ({ f, progressive: false }))];
    const h264 = this.preferH264();
    const isAvc = (f: any) => (/^avc/i.test(f.vcodec ?? '') ? 1 : 0);
    candidates.sort(
      (a, b) =>
        (b.f.height || 0) - (a.f.height || 0) ||
        (b.f.fps || 0) - (a.f.fps || 0) ||
        (h264 ? isAvc(b.f) - isAvc(a.f) : 0) ||
        (a.progressive === b.progressive ? 0 : a.progressive ? -1 : 1) ||
        (b.f.tbr || 0) - (a.f.tbr || 0)
    );

    for (const { f, progressive: isProg } of candidates) {
      const h = f.height || 0;
      if (!h || seenHeights.has(h)) continue;
      seenHeights.add(h);
      const fps = f.fps && f.fps > 30 ? ` ${Math.round(f.fps)}fps` : '';
      out.push({
        formatId: isProg ? f.format_id : `${f.format_id}+${bestAudio.format_id}`,
        label: `${this.heightLabel(h)}${fps}`,
        resolution: `${f.width || '?'}x${h}`,
        url: f.url,
        audioUrl: isProg ? undefined : bestAudio.url,
        isVideo: true,
        ext: f.ext || 'mp4',
      });
    }

    const videoOptions = out.slice(0, MAX_FORMATS - (bestAudio ? 1 : 0));
    if (bestAudio) {
      videoOptions.push({
        formatId: bestAudio.format_id,
        // Renderer prefixes this with a localized "Audio" label
        label: bestAudio.abr || bestAudio.tbr ? `${Math.round(bestAudio.abr || bestAudio.tbr)} kbps` : '',
        url: bestAudio.url,
        isVideo: false,
        ext: bestAudio.ext || 'm4a',
      });
    }
    return videoOptions;
  }

  /** One stream per audio language (YouTube multi-language / AI dubbing), original first. */
  private audioTracks(json: any): AudioTrack[] {
    if (!Array.isArray(json.formats)) return [];
    const best = new Map<string, any>();
    for (const f of json.formats) {
      if (!f.url || !f.language || (f.protocol !== 'https' && f.protocol !== 'http')) continue;
      if ((f.vcodec && f.vcodec !== 'none') || !f.acodec || f.acodec === 'none') continue;
      const cur = best.get(f.language);
      if (!cur || (f.abr || 0) > (cur.abr || 0)) best.set(f.language, f);
    }
    if (best.size < 2) return []; // a single language: nothing to choose
    const tracks = [...best.values()].map((f) => {
      const original = (f.language_preference ?? 0) > 0 || /original/i.test(f.format_note ?? '');
      // format_note reads "Deutsch (Deutschland) - dubbed-auto" / "American English - original (original)"
      const label =
        String(f.format_note ?? f.language)
          .split(' - ')[0]
          .split(',')[0]
          .replace(/\s*original.*$/i, '')
          .trim() || f.language;
      return { lang: f.language as string, label, url: f.url as string, original };
    });
    return tracks.sort((a, b) => Number(b.original) - Number(a.original) || a.label.localeCompare(b.label));
  }

  /**
   * The subtitle menu: creator-uploaded tracks, the speech-recognised original, and machine
   * translations into common languages (YouTube offers ~170; a short list stays usable).
   */
  private subtitleTracks(json: any): SubtitleTrack[] {
    const manual = json.subtitles && typeof json.subtitles === 'object' ? json.subtitles : {};
    const auto = json.automatic_captions && typeof json.automatic_captions === 'object' ? json.automatic_captions : {};
    const nameOf = (list: any[], fallback: string) => (Array.isArray(list) ? list.find((f) => f?.name)?.name : undefined) ?? fallback;
    const base = (l: string) => l.split('-')[0].toLowerCase();
    // The video's own language: dubbed videos also carry an auto track per dub — skip those
    const origAudio = (json.formats ?? []).find((f: any) => (f.language_preference ?? 0) > 0 && f.language)?.language;
    const origLang = base(String(json.language ?? origAudio ?? ''));

    const out: SubtitleTrack[] = [];
    for (const lang of Object.keys(manual)) {
      if (lang === 'live_chat') continue;
      out.push({ lang, name: nameOf(manual[lang], lang), kind: 'manual' });
    }
    const origKeys = Object.keys(auto).filter((l) => l.endsWith('-orig'));
    const ownAuto = origKeys.find((l) => base(l) === origLang) ?? (origKeys.length === 1 ? origKeys[0] : undefined);
    if (ownAuto) out.push({ lang: ownAuto, name: nameOf(auto[ownAuto], ownAuto).replace(/\s*\(Original\)\s*$/i, ''), kind: 'auto' });

    // Translations are made from the creator's track in the original language when there is
    // one (better than speech recognition), else from the speech-recognised original
    const manualSource = Object.keys(manual).find((l) => base(l) === origLang) ?? Object.keys(manual).find((l) => l !== 'live_chat');
    const source = manualSource ?? ownAuto;
    if (source) {
      const have = new Set(out.map((t) => base(t.lang)));
      for (const lang of TRANSLATION_LANGS) {
        if (have.has(base(lang))) continue;
        out.push({ lang, name: nameOf(auto[lang], lang), kind: 'translated', source, sourceAuto: !manualSource });
      }
    }
    return out;
  }

  private heightLabel(h: number): string {
    if (h >= 2160) return '4K (2160p)';
    if (h >= 1440) return '2K (1440p)';
    if (h >= 1080) return '1080p Full HD';
    if (h >= 720) return '720p HD';
    return `${h}p`;
  }

  private async extractYtDlpJson(url: string): Promise<{ json: any | null; error?: string }> {
    const { json, error } = await runYtDlpJson(['-J', '--no-playlist', '--no-warnings', url]);
    // Search results come back as a playlist with entries
    if (json && Array.isArray(json.entries)) {
      return json.entries.length > 0 ? { json: json.entries[0] } : { json: null, error };
    }
    return { json, error };
  }

  /**
   * Gets the real track title & artist from the public Spotify track page (Open Graph tags),
   * falling back to the oEmbed endpoint (title only). No API key needed.
   */
  public async resolveSpotifyTrack(url: string): Promise<{ title: string; artist?: string; thumbnail?: string } | null> {
    const id = url.match(/\/track\/([A-Za-z0-9]+)/)?.[1];
    if (!id) return null;
    const trackUrl = `https://open.spotify.com/track/${id}`;
    const signal = AbortSignal.timeout(10000);

    try {
      const res = await fetch(trackUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' }, signal });
      if (res.ok) {
        const html = await res.text();
        const meta = (attr: string) => {
          const re = new RegExp(`<meta\\s+(?:property|name)="${attr}"\\s+content="([^"]*)"`, 'i');
          const m = html.match(re);
          return m ? this.decodeHtml(m[1]) : undefined;
        };
        const title = meta('og:title');
        if (title) {
          return {
            title,
            artist: meta('music:musician_description') || meta('og:description')?.split(' · ')[0],
            thumbnail: meta('og:image'),
          };
        }
      }
    } catch (err) {
      console.warn('[StreamManager] Spotify page lookup failed:', err);
    }

    try {
      const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, { signal });
      if (res.ok) {
        const data: any = await res.json();
        if (data?.title) return { title: data.title, thumbnail: data.thumbnail_url };
      }
    } catch (err) {
      console.warn('[StreamManager] Spotify oEmbed lookup failed:', err);
    }
    return null;
  }

  private decodeHtml(s: string): string {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private formatDuration(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const h = Math.floor(m / 60);
    const remM = m % 60;
    if (h > 0) {
      return `${h}:${remM.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}
