/** URL helpers shared by main and renderer. */

export function isSpotifyUrl(url: string): boolean {
  return /(^|\.)spotify\.com\//i.test(url) || /^spotify:/i.test(url);
}

/** Spotify playlist / album link (not a single track). */
export function isSpotifyCollection(url: string): boolean {
  return isSpotifyUrl(url) && /\/(playlist|album)\/[A-Za-z0-9]+/i.test(url);
}

/**
 * YouTube playlist link. A "watch?v=..&list=.." link is treated as a single video
 * (the user opened a video that happens to be in a playlist / mix).
 */
export function isYouTubePlaylist(url: string): boolean {
  if (!/(^|\/\/|\.)(youtube\.com|youtu\.be)\//i.test(url)) return false;
  if (/\/playlist\?/i.test(url)) return true;
  return /[?&]list=/i.test(url) && !/[?&]v=/i.test(url) && !/youtu\.be\/[A-Za-z0-9_-]{6,}/i.test(url);
}

/** SoundCloud set (playlist/album): soundcloud.com/<user>/sets/<name> */
export function isSoundCloudSet(url: string): boolean {
  return /(^|\/\/|\.)soundcloud\.com\/[^/]+\/sets\/[^/?#]+/i.test(url);
}

export function isAppleMusicUrl(url: string): boolean {
  return /(^|\/\/)music\.apple\.com\//i.test(url);
}

/** Apple Music playlist or album (an album link with ?i=<id> points at one song). */
export function isAppleCollection(url: string): boolean {
  return isAppleMusicUrl(url) && (/\/playlist\//i.test(url) || (/\/album\//i.test(url) && !/[?&]i=\d+/.test(url)));
}

export function isPlaylistUrl(url: string): boolean {
  return isSpotifyCollection(url) || isYouTubePlaylist(url) || isSoundCloudSet(url) || isAppleCollection(url);
}

export function sourceOf(url: string): 'youtube' | 'spotify' | 'soundcloud' | 'apple' | 'other' {
  if (isSpotifyUrl(url)) return 'spotify';
  if (/(^|\/\/|\.)(youtube\.com|youtu\.be)\//i.test(url) || /^ytsearch/i.test(url)) return 'youtube';
  if (/(^|\/\/|\.)soundcloud\.com\//i.test(url)) return 'soundcloud';
  if (isAppleMusicUrl(url)) return 'apple';
  return 'other';
}

/** YouTube video id from a watch / youtu.be / shorts link. */
export function youTubeId(url: string): string | null {
  const m = url.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** A query yt-dlp can resolve to a YouTube result, for tracks that only exist on Spotify/Apple. */
export function searchQueryFor(title: string, artist?: string): string {
  return `ytsearch1:${[artist, title].filter(Boolean).join(' - ')} audio`;
}

/**
 * Extracts every http(s) link from free text. Also splits links that got glued together
 * (an <input> drops newlines on paste: "https://a...https://b...").
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/.+?(?=https?:\/\/|[\s,;"'<>]|$)/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const url = m.replace(/[)\].]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
