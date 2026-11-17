/**
 * The persistent player bar (Spotify / Apple Music style): queue, shuffle, repeat, seek with
 * elapsed / remaining time, volume, Windows media keys (Media Session API).
 *
 * It plays audio itself (local files, or a remote item's audio stream resolved on demand), and
 * when the user leaves the watch page while a video plays it "adopts" that <video> element,
 * so the same controls drive it like YouTube's miniplayer.
 */
import { searchQueryFor } from '../shared/urls';
import { $, ICONS, el, formatDuration, iconButton, toast } from './dom';
import { t } from './i18n';

export interface PlayItem {
  id?: string;
  title: string;
  artist?: string;
  thumbnail?: string;
  duration?: number;
  /** Remote page/search URL (YouTube, SoundCloud, Spotify track, ytsearch1:) */
  url?: string;
  /** Local file (file:// URL) */
  fileUrl?: string;
  isVideo?: boolean;
  /** The YouTube page the audio resolved to (seeds the "similar songs" radio) */
  pageUrl?: string;
  /** Added by the radio (shown under "Similar songs" in the queue) */
  fromRadio?: boolean;
}

type Repeat = 'off' | 'all' | 'one';

const audio = new Audio();
audio.preload = 'auto';

let queue: PlayItem[] = [];
let order: number[] = []; // play order (shuffled or not) as indexes into queue
let pos = -1; // position in `order`
let shuffle = false;
let repeat: Repeat = 'off';
let loadToken = 0;
/** Keep playing similar songs when the queue runs out (Spotify / YouTube Music "autoplay") */
let autoplaySimilar = true;
let radioLoading = false;
let radioSeeded = new Set<string>(); // seeds already used, so one song never refills twice
const streamCache = new Map<string, { url: string; at: number }>();
const STREAM_TTL = 60 * 60 * 1000; // YouTube stream URLs live ~6 h; refresh hourly

/** When set, the bar drives this element (a video playing on/behind the watch page). */
interface ExternalOpts {
  /** The element the user hears (a separate audio track for 1080p+ streams) */
  audible?: () => HTMLMediaElement;
  onReturn: () => void;
  /** "Next" in the miniplayer: the watch page's first suggestion */
  onNext?: () => void;
}
let external: ({ media: HTMLMediaElement; item: PlayItem } & ExternalOpts) | null = null;
let onWatchVideo: ((item: PlayItem) => void) | null = null;

const media = (): HTMLMediaElement => external?.media ?? audio;
const audible = (): HTMLMediaElement => external?.audible?.() ?? media();
const current = (): PlayItem | undefined => (external ? external.item : queue[order[pos]]);

// ─────────────────────────────── Public API ───────────────────────────────

/**
 * @param opts.radio one song started on its own (search result, preview, watch page "Listen"):
 *   the queue becomes that song + songs similar to it, like a Spotify / YouTube Music radio,
 *   instead of whatever list the song was picked from.
 */
export function playQueue(items: PlayItem[], startIndex = 0, opts: { shuffle?: boolean; radio?: boolean } = {}) {
  if (items.length === 0) return;
  releaseExternal(true);
  radioSeeded = new Set();
  if (opts.radio) {
    queue = [items[startIndex] ?? items[0]];
    shuffle = false;
    buildOrder(0);
  } else {
    queue = items.slice();
    shuffle = opts.shuffle ?? shuffle;
    buildOrder(startIndex);
  }
  pos = 0;
  void loadCurrent(true);
  render();
}

/** Appends songs similar to `seed` (its YouTube Mix; a title search when it has none). */
async function extendWithRadio(seed: PlayItem) {
  // Local files downloaded from YouTube keep the video id in their name: "Song [GwF00uMNO64].mp3"
  const localId = seed.fileUrl ? decodeURIComponent(seed.fileUrl).match(/\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/i)?.[1] : undefined;
  const seedUrl =
    seed.pageUrl ??
    (seed.url && /youtube\.com|youtu\.be/i.test(seed.url) ? seed.url : undefined) ??
    (localId ? `https://www.youtube.com/watch?v=${localId}` : undefined);
  const key = seedUrl ?? `${seed.artist} ${seed.title}`;
  if (radioLoading || radioSeeded.has(key) || seed.fileUrl && !seedUrl) return;
  radioLoading = true;
  radioSeeded.add(key);
  try {
    const res = await window.electronAPI.getRelated(seedUrl ?? searchQueryFor(seed.title, seed.artist), [seed.artist, seed.title].filter(Boolean).join(' - '));
    if (!res.success || !res.data) return;
    const have = new Set(queue.map((q) => q.pageUrl ?? q.url));
    const fresh = res.data.entries
      .filter((e) => !e.isLive && !have.has(e.url))
      .slice(0, 25)
      .map((e): PlayItem => ({ id: e.id, title: e.title, artist: e.artist, thumbnail: e.thumbnail, duration: e.duration, url: e.url, pageUrl: e.url, isVideo: true, fromRadio: true }));
    if (!fresh.length) return;
    const base = queue.length;
    queue.push(...fresh);
    order.push(...fresh.map((_, i) => base + i));
    renderQueue();
    prefetchNext();
  } finally {
    radioLoading = false;
  }
}

/** Refill when the current song is the last one (or the queue was a single radio seed). */
function maybeRadio() {
  if (external || !autoplaySimilar || pos < order.length - 1) return;
  const item = current();
  if (item && (item.url || item.pageUrl || item.fileUrl)) void extendWithRadio(item);
}

/** Adds to the end of the queue (starts playing if nothing is queued). */
export function enqueue(items: PlayItem[]) {
  if (queue.length === 0 || pos < 0) return playQueue(items);
  const base = queue.length;
  queue.push(...items);
  order.push(...items.map((_, i) => base + i));
  toast(t('queuedOne'));
  renderQueue();
}

/** The watch page hands its video over when the user navigates away (miniplayer). */
export function adoptExternal(mediaEl: HTMLMediaElement, item: PlayItem, opts: ExternalOpts) {
  audio.pause();
  external = { media: mediaEl, item, ...opts };
  bindMedia(mediaEl);
  render();
}

/** The watch page takes its video back (or stops it). */
export function releaseExternal(stop = false) {
  if (!external) return;
  if (stop) external.media.pause();
  unbindMedia(external.media);
  external = null;
  bindMedia(audio);
  render();
}

export function pauseAll() {
  audio.pause();
}

export function isPlayingAudio() {
  return !audio.paused;
}

export function setupPlayerBar(handlers: { watchVideo: (item: PlayItem) => void }) {
  onWatchVideo = handlers.watchVideo;
  buildDom();
  bindMedia(audio);
  try {
    const v = parseFloat(localStorage.getItem('pb-volume') ?? '');
    if (isFinite(v)) audio.volume = Math.min(1, Math.max(0, v));
    shuffle = localStorage.getItem('pb-shuffle') === '1';
    autoplaySimilar = localStorage.getItem('pb-autoplay') !== '0';
    repeat = (localStorage.getItem('pb-repeat') as Repeat) || 'off';
  } catch {
    /* storage unavailable */
  }
  setupMediaSession();
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (e.code !== 'Space' || /input|textarea|select/i.test(target.tagName) || target.isContentEditable) return;
    if (target.closest('button')) return; // Space on a focused button presses it
    if (document.getElementById('tab-watch')?.classList.contains('active')) return; // the video's own keys
    if (!current()) return;
    e.preventDefault();
    togglePlay();
  });
  document.addEventListener('language-changed', render);
  render();
}

// ─────────────────────────────── Engine ───────────────────────────────

function buildOrder(startIndex: number) {
  const idx = queue.map((_, i) => i);
  if (shuffle) {
    const rest = idx.filter((i) => i !== startIndex);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    order = [startIndex, ...rest];
  } else {
    order = [...idx.slice(startIndex), ...idx.slice(0, startIndex)];
  }
}

async function resolveAudio(item: PlayItem): Promise<string | null> {
  if (item.fileUrl) return item.fileUrl;
  if (!item.url) return null;
  const hit = streamCache.get(item.url);
  if (hit && Date.now() - hit.at < STREAM_TTL) return hit.url;

  const tryResolve = async (url: string) => {
    const res = await window.electronAPI.resolveStreamUrl(url);
    if (!res.success || !res.data) return null;
    // Remember the YouTube page a Spotify / Apple / search item resolved to (radio seed)
    if (!item.pageUrl && /youtube\.com|youtu\.be/i.test(res.data.webpageUrl)) item.pageUrl = res.data.webpageUrl;
    const audioFmt = res.data.formats.find((f) => !f.isVideo);
    return audioFmt?.url ?? res.data.formats.find((f) => !f.audioUrl)?.url ?? res.data.streamUrl ?? null;
  };
  let stream = await tryResolve(item.url);
  // Not streamable as-is (some SoundCloud tracks are HLS-only): play the matching YouTube audio
  if (!stream && !/^ytsearch/i.test(item.url) && item.title) stream = await tryResolve(searchQueryFor(item.title, item.artist));
  if (stream) streamCache.set(item.url, { url: stream, at: Date.now() });
  return stream;
}

async function loadCurrent(autoplay: boolean) {
  const item = current();
  if (!item || external) return;
  const token = ++loadToken;
  setLoading(true);
  render();
  const src = await resolveAudio(item);
  if (token !== loadToken) return;
  setLoading(false);
  if (!src) {
    toast(t('barSkipped', { t: item.title }));
    if (pos < order.length - 1) {
      pos++;
      return loadCurrent(autoplay);
    }
    return;
  }
  audio.src = src;
  if (autoplay) audio.play().catch(() => {});
  updateMediaSession();
  prefetchNext();
  maybeRadio();
}

function prefetchNext() {
  const next = queue[order[pos + 1]];
  if (next && !next.fileUrl && next.url) void resolveAudio(next);
}

function togglePlay() {
  const m = media();
  if (!external && !m.src && current()) return void loadCurrent(true);
  if (m.paused) m.play().catch(() => {});
  else m.pause();
}

function next(fromEnded = false) {
  if (external) {
    if (!fromEnded) external.onNext?.();
    return;
  }
  if (fromEnded && repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (pos < order.length - 1) pos++;
  else if (repeat === 'all') pos = 0;
  else return; // end of the queue (the radio refills it while the last song plays)
  void loadCurrent(true);
  render();
}

function prev() {
  if (external) {
    external.media.currentTime = 0;
    return;
  }
  // Like every music player: restart the song first, go back only near its start
  if (audio.currentTime > 3 || pos <= 0) {
    audio.currentTime = 0;
    return;
  }
  pos--;
  void loadCurrent(true);
  render();
}

function jumpTo(queueIndex: number) {
  releaseExternal(true);
  const p = order.indexOf(queueIndex);
  if (p < 0) return;
  pos = p;
  void loadCurrent(true);
  render();
}

function removeFromQueue(queueIndex: number) {
  if (queueIndex === order[pos]) return;
  const curIdx = order[pos];
  queue.splice(queueIndex, 1);
  order = order.filter((i) => i !== queueIndex).map((i) => (i > queueIndex ? i - 1 : i));
  pos = order.indexOf(curIdx > queueIndex ? curIdx - 1 : curIdx);
  renderQueue();
}

// ─────────────────────────────── DOM ───────────────────────────────

let els: Record<string, HTMLElement> = {};
let seeking = false;

function buildDom() {
  const bar = $('player-bar');
  bar.innerHTML = '';

  const left = el('div', 'pb-now');
  const cover = el('div', 'pb-cover');
  const meta = el('div', 'pb-meta');
  const title = el('div', 'pb-title');
  const artist = el('div', 'pb-artist');
  meta.append(title, artist);
  left.append(cover, meta);

  const center = el('div', 'pb-center');
  const controls = el('div', 'pb-controls');
  const shuffleBtn = iconButton('pb-btn pb-small', ICONS.shuffle, t('barShuffle'));
  const prevBtn = iconButton('pb-btn', ICONS.prev, t('barPrev'));
  const playBtn = iconButton('pb-btn pb-play', ICONS.play, t('barPlay'));
  const nextBtn = iconButton('pb-btn', ICONS.next, t('barNext'));
  const repeatBtn = iconButton('pb-btn pb-small', ICONS.repeat, t('barRepeat'));
  controls.append(shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn);

  const timeline = el('div', 'pb-timeline');
  const elapsed = el('span', 'pb-time');
  const seek = el('input', 'pb-seek') as HTMLInputElement;
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.setAttribute('aria-label', t('barSeek'));
  const remaining = el('span', 'pb-time pb-remaining');
  timeline.append(elapsed, seek, remaining);
  center.append(controls, timeline);

  const right = el('div', 'pb-right');
  const watchBtn = iconButton('pb-btn pb-small', ICONS.video, t('watchReturn'));
  const queueBtn = iconButton('pb-btn pb-small', ICONS.list, t('barQueue'));
  const muteBtn = iconButton('pb-btn pb-small', ICONS.volume, t('barMute'));
  const volume = el('input', 'pb-volume') as HTMLInputElement;
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.setAttribute('aria-label', t('barVolume'));
  const closeBtn = iconButton('pb-btn pb-small', ICONS.close, t('barClose'));
  right.append(watchBtn, queueBtn, muteBtn, volume, closeBtn);

  const queuePanel = el('div', 'pb-queue');
  queuePanel.hidden = true;

  bar.append(left, center, right, queuePanel);
  els = { bar, cover, title, artist, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn, elapsed, seek, remaining, watchBtn, queueBtn, muteBtn, volume, closeBtn, queuePanel };

  playBtn.addEventListener('click', togglePlay);
  nextBtn.addEventListener('click', () => next());
  prevBtn.addEventListener('click', prev);
  shuffleBtn.addEventListener('click', () => {
    shuffle = !shuffle;
    const cur = order[pos];
    if (cur !== undefined) {
      buildOrder(cur);
      pos = 0;
    }
    try {
      localStorage.setItem('pb-shuffle', shuffle ? '1' : '0');
    } catch {
      /* ignore */
    }
    render();
  });
  repeatBtn.addEventListener('click', () => {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    try {
      localStorage.setItem('pb-repeat', repeat);
    } catch {
      /* ignore */
    }
    render();
  });
  seek.addEventListener('input', () => {
    seeking = true;
    const m = media();
    if (isFinite(m.duration)) els.elapsed.textContent = formatDuration((Number(seek.value) / 1000) * m.duration) || '0:00';
    paintSeek();
  });
  seek.addEventListener('change', () => {
    const m = media();
    if (isFinite(m.duration)) m.currentTime = (Number(seek.value) / 1000) * m.duration;
    seeking = false;
  });
  volume.addEventListener('input', () => {
    const m = audible();
    m.volume = Number(volume.value) / 100;
    m.muted = m.volume === 0;
    if (!external) audio.volume = m.volume;
    try {
      localStorage.setItem('pb-volume', String(audio.volume));
    } catch {
      /* ignore */
    }
  });
  muteBtn.addEventListener('click', () => {
    const m = audible();
    m.muted = !m.muted;
    renderVolume();
  });
  queueBtn.addEventListener('click', () => {
    queuePanel.hidden = !queuePanel.hidden;
    queueBtn.classList.toggle('on', !queuePanel.hidden);
    if (!queuePanel.hidden) renderQueue();
  });
  watchBtn.addEventListener('click', () => {
    if (external) external.onReturn();
    else {
      const item = current();
      if (item && onWatchVideo) {
        audio.pause();
        onWatchVideo({ ...item, url: item.url });
      }
    }
  });
  closeBtn.addEventListener('click', () => {
    if (external) {
      releaseExternal(true);
    }
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    queue = [];
    order = [];
    pos = -1;
    queuePanel.hidden = true;
    render();
  });
}

const mediaHandlers: Record<string, () => void> = {
  play: () => renderPlayState(),
  pause: () => renderPlayState(),
  timeupdate: () => renderTime(),
  durationchange: () => renderTime(),
  volumechange: () => renderVolume(),
  waiting: () => setLoading(true),
  playing: () => setLoading(false),
  ended: () => {
    if (!external) next(true);
  },
  error: () => {
    if (external || !audio.src) return;
    // An expired stream URL: resolve again once, then skip
    const item = current();
    if (item?.url) streamCache.delete(item.url);
    toast(t('barSkipped', { t: item?.title ?? '' }));
    next(true);
  },
};

function bindMedia(m: HTMLMediaElement) {
  for (const [ev, fn] of Object.entries(mediaHandlers)) m.addEventListener(ev, fn);
}
function unbindMedia(m: HTMLMediaElement) {
  for (const [ev, fn] of Object.entries(mediaHandlers)) m.removeEventListener(ev, fn);
}

function setLoading(on: boolean) {
  els.bar?.classList.toggle('loading', on);
}

function render() {
  const bar = els.bar;
  if (!bar) return;
  const item = current();
  const visible = !!item;
  bar.hidden = !visible;
  document.body.classList.toggle('has-player-bar', visible);
  if (!item) return;

  els.title.textContent = item.title;
  els.title.title = item.title;
  els.artist.textContent = item.artist ?? (external ? '' : t('unknownArtist'));
  els.cover.innerHTML = '';
  if (item.thumbnail) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = item.thumbnail;
    img.addEventListener('error', () => img.remove());
    els.cover.append(img);
  } else {
    els.cover.innerHTML = ICONS.audio; // static
  }
  els.cover.classList.toggle('video', !!external || !!item.isVideo);

  els.shuffleBtn.classList.toggle('on', shuffle);
  els.repeatBtn.classList.toggle('on', repeat !== 'off');
  els.repeatBtn.innerHTML = repeat === 'one' ? ICONS.repeatOne : ICONS.repeat; // static
  els.repeatBtn.title = repeat === 'one' ? t('barRepeatOne') : t('barRepeat');
  // Miniplayer (a video): previous = restart, next = the watch page's next suggestion;
  // shuffle / repeat / queue mean nothing for one video, so they step aside instead of greying out
  for (const b of [els.shuffleBtn, els.repeatBtn, els.queueBtn]) b.hidden = !!external;
  (els.prevBtn as HTMLButtonElement).disabled = false;
  (els.nextBtn as HTMLButtonElement).disabled = !!external && !external.onNext;
  if (external) els.queuePanel.hidden = true;
  // The video button: back to the watch page (miniplayer), or watch this track's video
  els.watchBtn.hidden = !(external || (item.url && !item.fileUrl && item.isVideo !== false));
  els.watchBtn.title = external ? t('watchReturn') : t('watchVideo');
  renderPlayState();
  renderTime();
  renderVolume();
  if (!els.queuePanel.hidden) renderQueue();
}

function renderPlayState() {
  const paused = media().paused;
  els.playBtn.innerHTML = paused ? ICONS.play : ICONS.pause; // static
  els.playBtn.title = paused ? t('barPlay') : t('barPause');
  els.playBtn.setAttribute('aria-label', els.playBtn.title);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}

function renderTime() {
  const m = media();
  const d = isFinite(m.duration) ? m.duration : current()?.duration ?? 0;
  if (!seeking) {
    els.elapsed.textContent = formatDuration(m.currentTime) || '0:00';
    (els.seek as HTMLInputElement).value = d ? String(Math.round((m.currentTime / d) * 1000)) : '0';
    paintSeek();
  }
  // Remaining time, as Apple Music shows it
  els.remaining.textContent = d ? `-${formatDuration(Math.max(0, d - m.currentTime)) || '0:00'}` : '';
  if ('mediaSession' in navigator && d && isFinite(d)) {
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(m.currentTime, d), playbackRate: m.playbackRate });
    } catch {
      /* ignore */
    }
  }
}

function paintSeek() {
  const s = els.seek as HTMLInputElement;
  s.style.setProperty('--pb-fill', `${Number(s.value) / 10}%`);
}

function renderVolume() {
  const m = audible();
  const v = m.muted ? 0 : m.volume;
  (els.volume as HTMLInputElement).value = String(Math.round(v * 100));
  els.volume.style.setProperty('--pb-fill', `${v * 100}%`);
  els.muteBtn.innerHTML = v === 0 ? ICONS.mute : ICONS.volume; // static
}

function renderQueue() {
  const panel = els.queuePanel;
  if (!panel) return;
  panel.innerHTML = '';
  const head = el('div', 'pb-queue-head');
  head.append(el('span', undefined, t('barQueue')));
  const auto = el('label', 'pb-autoplay');
  const cb = el('input') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = autoplaySimilar;
  cb.addEventListener('change', () => {
    autoplaySimilar = cb.checked;
    try {
      localStorage.setItem('pb-autoplay', autoplaySimilar ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (autoplaySimilar) maybeRadio();
  });
  auto.append(cb, el('span', undefined, t('barAutoplay')));
  head.append(auto);
  panel.append(head);
  if (!queue.length) {
    panel.append(el('p', 'pb-queue-empty', t('barQueueEmpty')));
    return;
  }
  const list = el('div', 'pb-queue-list');
  let radioHead = false;
  order.forEach((qi, p) => {
    if (p < pos) return; // show what is playing and what comes next
    const item = queue[qi];
    if (item.fromRadio && p > pos && !radioHead) {
      radioHead = true;
      list.append(el('div', 'pb-queue-sub', t('barSimilar')));
    }
    const row = el('div', `pb-queue-row${p === pos ? ' current' : ''}`);
    const txt = el('div', 'pb-queue-text');
    txt.append(el('span', 'pb-queue-title', item.title), el('span', 'pb-queue-artist', item.artist ?? ''));
    row.append(el('span', 'pb-queue-index', p === pos ? '▶' : String(p - pos)), txt, el('span', 'pb-queue-dur', formatDuration(item.duration)));
    if (p !== pos) {
      const rm = iconButton('pb-btn pb-small', ICONS.close, t('libRemoveItem'));
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromQueue(qi);
      });
      row.append(rm);
    }
    row.addEventListener('click', () => jumpTo(qi));
    list.append(row);
  });
  panel.append(list);
}

// ─────────────────────────────── Media Session (Windows media keys / overlay) ───────────────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a: MediaSessionAction, h: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(a, h);
    } catch {
      /* unsupported action */
    }
  };
  set('play', () => media().play().catch(() => {}));
  set('pause', () => media().pause());
  set('nexttrack', () => next());
  set('previoustrack', prev);
  set('seekto', (d) => {
    if (typeof d.seekTime === 'number') media().currentTime = d.seekTime;
  });
}

function updateMediaSession() {
  const item = current();
  if (!item || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: item.artist ?? '',
    artwork: item.thumbnail && /^https:/.test(item.thumbnail) ? [{ src: item.thumbnail, sizes: '512x512' }] : [],
  });
}
