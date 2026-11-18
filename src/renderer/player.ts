// ═══════════════════════════════════════════════════════════════════
// WATCH PAGE — a YouTube-style page instead of a modal: the video on the
// left, title / channel / actions under it, "Up next" on the right.
// Leaving the page while a video plays hands it to the player bar
// (miniplayer); coming back takes it over again.
// ═══════════════════════════════════════════════════════════════════
import type { AudioTrack, CatalogEntry, MediaProbe, QualityOption, StreamFormatOption } from '../shared/types';
import { $, el, formatBytes, formatCount, formatDuration, switchTab } from './dom';
import { LangKey, t } from './i18n';
import { adoptExternal, pauseAll, playQueue, releaseExternal } from './playerbar';
import { requestFromOption } from './preview';
import { addToLibraryMenu } from './library';
import { attachVideoControls } from './videocontrols';
import { withViewTransition } from './transitions';
import { isPowerSaver } from './power';

const hintOf = (e: CatalogEntry): StreamHint => ({ title: e.title, artist: e.artist, thumbnail: e.thumbnail });

export interface LocalMedia {
  fileUrl: string;
  title: string;
  artist?: string;
  thumbnail?: string;
  isVideo: boolean;
  durationStr?: string;
}

interface Current {
  title: string;
  artist?: string;
  thumbnail?: string;
  /** The page URL (empty for local files) */
  url: string;
  isVideo: boolean;
}

let api: {
  openStream: (url: string, hint?: StreamHint) => Promise<void>;
  openLocal: (media: LocalMedia) => void;
} | null = null;

/** What the caller already knows, shown at once while the stream resolves. */
export interface StreamHint {
  title?: string;
  artist?: string;
  thumbnail?: string;
  /** The thumbnail element that morphs into the player */
  from?: HTMLElement | null;
}

export function openStream(url: string, hint?: StreamHint) {
  return api?.openStream(url, hint);
}

export function openLocal(media: LocalMedia) {
  api?.openLocal(media);
}

function store(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setupPlayer() {
  const page = $('tab-watch');
  const screen = $('watch-screen');
  const videoEl = $<HTMLVideoElement>('liquid-video');
  const audioEl = $<HTMLAudioElement>('liquid-audio');
  const titleEl = $('player-title');
  const authorEl = $('player-author');
  const backBtn = $<HTMLButtonElement>('watch-back-btn');
  const qualitySelect = $<HTMLSelectElement>('player-quality-select');
  const spinner = $('player-loading-spinner');
  const audioView = $('player-audio-view');
  const coverImg = $<HTMLImageElement>('audio-cover-img');
  const listenBtn = $<HTMLButtonElement>('watch-listen-btn');
  const addBtn = $<HTMLButtonElement>('watch-add-btn');
  const dlBtn = $<HTMLButtonElement>('player-download-this-btn');
  const dlMenu = $('watch-dl-menu');
  const related = $('watch-related');
  const side = $('watch-side');

  let cur: Current | null = null;
  let formats: StreamFormatOption[] = [];
  let thumbnail = '';
  let syncAudio = false; // a separate audio track follows the video (1080p+ streams)
  let token = 0;
  let backTo = 'downloads';
  let probe: MediaProbe | null = null;
  let curFmt: StreamFormatOption | null = null;
  /** A dubbed audio language picked in the controls (null = the video's own audio) */
  let audioOverride: AudioTrack | null = null;
  let relatedEntries: CatalogEntry[] = [];

  // The element the user hears: the separate audio track when one plays, else the video
  const audible = (): HTMLMediaElement => (syncAudio ? audioEl : videoEl);
  const controls = attachVideoControls({
    screen,
    video: videoEl,
    audible,
    isActive: () => page.classList.contains('active'),
    onAudioTrack: (track) => {
      audioOverride = track;
      if (curFmt) loadFormat(curFmt, videoEl.currentTime, !videoEl.paused);
    },
  });

  // ── Separate audio track sync (for video-only 1080p+ streams) ──
  // Seeking used to be slow: the audio only started fetching after the video had finished
  // seeking, and while it was still buffering a drift check re-seeked it 4× a second, so every
  // check threw away its download and started a new one. Now both seek at the same moment,
  // the video waits for the audio, and small drift is corrected by speed, not by seeking.
  const drift = () => audioEl.currentTime - videoEl.currentTime;
  const audioReady = () => !audioEl.seeking && audioEl.readyState >= 3;
  /** The video was paused by us (waiting for the audio), not by the user */
  let heldForAudio = false;

  const syncTime = () => {
    if (!syncAudio || videoEl.paused || videoEl.seeking || !audioReady()) return;
    const d = drift();
    const base = videoEl.playbackRate;
    if (Math.abs(d) > 0.4) {
      audioEl.currentTime = videoEl.currentTime; // too far off: one hard re-seek
      audioEl.playbackRate = base;
    } else if (Math.abs(d) > 0.06) {
      audioEl.playbackRate = base * (d > 0 ? 0.97 : 1.03); // ease back in, inaudibly
    } else if (audioEl.playbackRate !== base) {
      audioEl.playbackRate = base;
    }
  };
  videoEl.addEventListener('seeking', () => {
    // Fetch both streams in parallel from the start
    if (syncAudio) audioEl.currentTime = videoEl.currentTime;
  });
  videoEl.addEventListener('play', () => {
    if (!syncAudio) return;
    if (Math.abs(drift()) > 0.4) audioEl.currentTime = videoEl.currentTime;
    audioEl.play().catch(() => {});
  });
  videoEl.addEventListener('playing', () => {
    if (!syncAudio) return;
    if (!audioReady()) {
      // Picture is ready before the sound: hold the picture until the audio catches up
      heldForAudio = true;
      videoEl.pause();
      return;
    }
    audioEl.play().catch(() => {});
  });
  audioEl.addEventListener('canplay', () => {
    if (!syncAudio || !heldForAudio) return;
    heldForAudio = false;
    if (Math.abs(drift()) > 0.4) audioEl.currentTime = videoEl.currentTime;
    videoEl.play().catch(() => {});
  });
  for (const ev of ['pause', 'waiting', 'ended'] as const) {
    videoEl.addEventListener(ev, () => {
      if (!syncAudio) return;
      if (ev === 'pause' && heldForAudio) return; // keep the audio loading
      audioEl.pause();
    });
  }
  videoEl.addEventListener('seeked', () => {
    if (syncAudio && !audioEl.seeking && Math.abs(drift()) > 0.4) audioEl.currentTime = videoEl.currentTime;
  });
  videoEl.addEventListener('timeupdate', syncTime);
  videoEl.addEventListener('ratechange', () => (audioEl.playbackRate = videoEl.playbackRate));

  function clearAudioTrack() {
    syncAudio = false;
    heldForAudio = false;
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  }

  function setAudioMode(on: boolean) {
    screen.classList.toggle('audio-mode', on);
    audioView.style.display = on ? 'flex' : 'none';
    if (on) {
      if (thumbnail) coverImg.src = thumbnail;
      else coverImg.removeAttribute('src');
      coverImg.style.visibility = thumbnail ? '' : 'hidden';
    }
  }

  function loadFormat(fmt: StreamFormatOption, resumeAt = 0, autoplay = true) {
    const prev = audible();
    const vol = prev.volume;
    const muted = prev.muted;
    curFmt = fmt;
    clearAudioTrack();
    setAudioMode(!fmt.isVideo);
    videoEl.src = fmt.url;
    // A dub replaces the audio; on progressive (low-res) streams the video's own sound is muted
    const audioSrc = (fmt.isVideo && audioOverride?.url) || fmt.audioUrl;
    if (audioSrc) {
      syncAudio = true;
      audioEl.src = audioSrc;
      videoEl.muted = true;
    } else {
      videoEl.muted = false;
    }
    const target = audible();
    target.volume = vol;
    target.muted = muted;
    controls.refresh();
    videoEl.addEventListener(
      'loadedmetadata',
      () => {
        if (resumeAt > 0) videoEl.currentTime = resumeAt;
        if (autoplay) videoEl.play().catch(() => {});
      },
      { once: true }
    );
  }

  videoEl.addEventListener('ended', () => {
    // Autoplay the first suggestion, like YouTube — only while the watch page is open
    if (page.classList.contains('active') && relatedEntries[0] && cur?.url && store('wp-autoplay') !== '0') void doOpenStream(relatedEntries[0].url, hintOf(relatedEntries[0]));
  });

  function stopMedia() {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    clearAudioTrack();
    setAudioMode(false);
  }

  /**
   * Shows the watch page with `prepare`'s changes. From another tab the clicked thumbnail morphs
   * into the player; on the watch page itself (an "Up next" click) the same morph runs in place.
   */
  function showPage(prepare: () => void, from?: HTMLElement | null) {
    releaseExternal(); // the bar gives the video back
    pauseAll(); // and stops its own audio
    dlMenu.hidden = true;
    if (page.classList.contains('active')) {
      withViewTransition(prepare, 'fade', from);
    } else {
      prepare();
      switchTab('watch', { morphFrom: from });
    }
  }

  // ── Open a stream (YouTube, Spotify track, SoundCloud, ytsearch1: …) ──
  async function doOpenStream(url: string, hint: StreamHint = {}) {
    const my = ++token;
    probe = null;
    showPage(() => {
      stopMedia();
      thumbnail = hint.thumbnail ?? '';
      // The thumbnail the user clicked stays on screen while the stream resolves
      if (hint.thumbnail) videoEl.poster = hint.thumbnail;
      else videoEl.removeAttribute('poster');
      cur = { title: hint.title ?? t('playerPlaying'), artist: hint.artist, url, isVideo: true };
      titleEl.textContent = cur.title;
      authorEl.textContent = hint.artist ?? '';
      qualitySelect.innerHTML = '';
      qualitySelect.style.display = '';
      dlBtn.style.display = '';
      listenBtn.style.display = '';
      addBtn.style.display = '';
      related.innerHTML = '';
      side.style.display = '';
      spinner.style.display = 'flex';
    }, hint.from);

    const res = await window.electronAPI.resolveStreamUrl(url);
    if (my !== token) return;
    spinner.style.display = 'none';
    if (!res.success || !res.data) {
      const key: LangKey =
        res.errorCode === 'spotifyNotTrack'
          ? 'streamSpotifyNotTrack'
          : res.errorCode === 'spotifyLookupFailed'
            ? 'streamSpotifyLookupFailed'
            : res.errorCode === 'unknown'
              ? 'streamUnknown'
              : 'streamResolveFailed';
      titleEl.textContent = t(key);
      authorEl.textContent = res.error ?? '';
      return;
    }

    const media = res.data;
    thumbnail = media.thumbnail || thumbnail;
    if (thumbnail) videoEl.poster = thumbnail;
    cur = { title: media.title || url, artist: media.uploader, thumbnail, url: media.webpageUrl || url, isVideo: media.isVideo };
    titleEl.textContent = cur.title;
    authorEl.textContent = [media.uploader || t('unknownArtist'), media.durationStr].filter(Boolean).join(' · ');
    document.title = `${cur.title} — Harbor`;

    formats = media.formats.length
      ? media.formats
      : [{ formatId: 'default', label: t('playerBestQuality'), url: media.streamUrl, isVideo: media.isVideo, ext: '' }];
    qualitySelect.innerHTML = '';
    formats.forEach((fmt, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = fmt.isVideo ? fmt.label : [t('audioOnly'), fmt.label].filter(Boolean).join(' · ');
      qualitySelect.appendChild(opt);
    });
    // Start at the default quality (1080p) instead of the heaviest stream; higher is one click away
    // Battery saver: start at 720p at most (less to decode); higher stays one click away
    const userCap = (await window.electronAPI.getSettings()).defaultVideoHeight || Infinity;
    const cap = isPowerSaver() ? Math.min(userCap, 720) : userCap;
    if (my !== token) return;
    const heightOf = (f: StreamFormatOption) => parseInt((f.resolution ?? '').split('x')[1] ?? '', 10) || 0;
    const startIdx = Math.max(0, formats.findIndex((f) => !f.isVideo || heightOf(f) <= cap));
    qualitySelect.value = String(startIdx);
    audioOverride = null;
    controls.setMedia({ url: cur.url, subtitles: media.subtitles ?? [], audioTracks: media.audioTracks ?? [] });
    loadFormat(formats[startIdx]);
    loadRelated(cur.url, cur.title);
  }

  // ── Local file from the history ──
  function doOpenLocal(m: LocalMedia) {
    token++;
    probe = null;
    showPage(() => {
    stopMedia();
    thumbnail = m.thumbnail || '';
    cur = { title: m.title, artist: m.artist, thumbnail, url: '', isVideo: m.isVideo };
    titleEl.textContent = m.title;
    authorEl.textContent = [m.artist || t('unknownArtist'), m.durationStr].filter(Boolean).join(' · ');
    formats = [{ formatId: 'local', label: t('playerLocalFile'), url: m.fileUrl, isVideo: m.isVideo, ext: '' }];
    qualitySelect.style.display = 'none';
    dlBtn.style.display = 'none';
    listenBtn.style.display = 'none';
    addBtn.style.display = 'none';
    side.style.display = 'none';
    spinner.style.display = 'none';
    if (thumbnail) videoEl.poster = thumbnail;
    else videoEl.removeAttribute('poster');
    });
    audioOverride = null;
    controls.setMedia({ url: '', subtitles: [], audioTracks: [] });
    loadFormat(formats[0]);
  }

  api = { openStream: doOpenStream, openLocal: doOpenLocal };

  // ── Up next ──
  async function loadRelated(url: string, title: string) {
    const my = token;
    related.innerHTML = '';
    for (let i = 0; i < 6; i++) related.append(el('div', 'watch-rel skeleton'));
    const res = await window.electronAPI.getRelated(url, title);
    if (my !== token) return;
    related.innerHTML = '';
    const entries = res.success && res.data ? res.data.entries : [];
    relatedEntries = entries;
    if (!entries.length) {
      related.append(el('p', 'watch-rel-empty', t('watchRelatedEmpty')));
      return;
    }
    for (const e of entries) related.append(relatedRow(e));
  }

  function relatedRow(e: CatalogEntry): HTMLElement {
    const row = el('button', 'watch-rel');
    row.type = 'button';
    const thumb = el('div', 'watch-rel-thumb');
    if (e.thumbnail) {
      const img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = e.thumbnail;
      thumb.append(img);
    }
    if (e.duration) thumb.append(el('span', 'explore-badge', formatDuration(e.duration)));
    const text = el('div', 'watch-rel-text');
    text.append(
      el('span', 'watch-rel-title', e.title),
      el('span', 'watch-rel-sub', [e.artist, e.viewCount !== undefined ? t('exploreViews', { n: formatCount(e.viewCount) }) : ''].filter(Boolean).join(' · '))
    );
    row.append(thumb, text);
    row.title = e.title;
    row.addEventListener('click', () => doOpenStream(e.url, { title: e.title, artist: e.artist, thumbnail: e.thumbnail, from: thumb }));
    return row;
  }

  // ── Actions ──
  qualitySelect.addEventListener('change', () => {
    const fmt = formats[parseInt(qualitySelect.value, 10)];
    if (fmt) loadFormat(fmt, videoEl.currentTime, !videoEl.paused);
  });

  backBtn.addEventListener('click', () => switchTab(backTo));

  // Listen as music: hand the item to the player bar (audio only) and keep the position
  listenBtn.addEventListener('click', () => {
    if (!cur?.url) return;
    stopMedia();
    playQueue([{ title: cur.title, artist: cur.artist, thumbnail: cur.thumbnail, url: cur.url, pageUrl: cur.url, isVideo: true }], 0, { radio: true });
    switchTab(backTo);
  });

  addBtn.addEventListener('click', () => {
    if (!cur?.url) return;
    addToLibraryMenu(addBtn, [
      { id: '', title: cur.title, artist: cur.artist, thumbnail: cur.thumbnail, url: cur.url, source: 'youtube', isVideo: cur.isVideo },
    ]);
  });

  // Download: the same per-quality list (with real sizes) as the link preview
  dlBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!dlMenu.hidden) {
      dlMenu.hidden = true;
      return;
    }
    if (!cur?.url) return;
    dlMenu.hidden = false;
    dlMenu.innerHTML = '';
    dlMenu.append(el('div', 'pop-menu-note', t('pvLoading')));
    if (!probe) {
      const my = token;
      const res = await window.electronAPI.probeMedia(cur.url);
      if (my !== token) return;
      probe = res.success && res.data ? res.data : null;
    }
    dlMenu.innerHTML = '';
    if (!probe || !probe.options.length) {
      dlMenu.append(el('div', 'pop-menu-note', t('pvFailed')));
      return;
    }
    const p = probe;
    const addGroup = (kind: 'video' | 'audio', label: string) => {
      const opts = p.options.filter((o) => o.kind === kind);
      if (!opts.length) return;
      dlMenu.append(el('div', 'pop-menu-head', label));
      for (const o of opts) dlMenu.append(menuOption(p, o));
    };
    addGroup('video', t('pvVideo'));
    addGroup('audio', t('pvAudio'));
  });

  function menuOption(p: MediaProbe, o: QualityOption): HTMLElement {
    const b = el('button', 'pop-menu-item');
    b.type = 'button';
    b.append(el('span', 'pop-menu-label', o.label), el('span', 'pop-menu-detail', o.detail ?? ''), el('span', 'pop-menu-size', o.sizeBytes ? `${o.approx ? '~' : ''}${formatBytes(o.sizeBytes)}` : ''));
    b.addEventListener('click', () => {
      dlMenu.hidden = true;
      void requestFromOption(p, o);
    });
    return b;
  }
  document.addEventListener('click', (e) => {
    if (!dlMenu.hidden && !dlMenu.contains(e.target as Node) && e.target !== dlBtn) dlMenu.hidden = true;
  });

  // ── Miniplayer: leaving the page keeps a playing video going in the player bar ──
  let onWatch = false;
  document.addEventListener('tab-changed', (e) => {
    const tab = (e as CustomEvent).detail as string;
    if (tab === 'watch') {
      onWatch = true;
      // While the video sits in the picture-in-picture window its controls stay with it
      if (document.pictureInPictureElement !== videoEl) releaseExternal();
      return;
    }
    backTo = tab;
    const leaving = onWatch;
    onWatch = false;
    if (!leaving) return;
    document.title = 'Harbor';
    if (cur && videoEl.src && !videoEl.paused && !document.pictureInPictureElement) {
      adoptExternal(videoEl, { title: cur.title, artist: cur.artist, thumbnail: cur.thumbnail, isVideo: true }, {
        audible,
        onReturn: () => switchTab('watch'),
        // "Next" in the miniplayer plays what "Up next" lists, like YouTube
        onNext: relatedEntries[0] ? () => void doOpenStream(relatedEntries[0].url, hintOf(relatedEntries[0])) : undefined,
      });
    }
  });

  // ── Picture-in-picture: its buttons (next, previous, seek) act on this video ──
  // The PiP window's buttons come from the Media Session, which normally drives the player
  // bar's own audio. Handing the video to the bar for as long as PiP is open routes them here:
  // next = first "Up next" entry, previous = back to the start, seek = ±10 s.
  videoEl.addEventListener('enterpictureinpicture', () => {
    if (!cur) return;
    adoptExternal(videoEl, { title: cur.title, artist: cur.artist, thumbnail: cur.thumbnail, isVideo: true }, {
      audible,
      onReturn: () => {
        if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
        switchTab('watch');
      },
      onNext: relatedEntries[0] ? () => void doOpenStream(relatedEntries[0].url, hintOf(relatedEntries[0])) : undefined,
    });
  });
  videoEl.addEventListener('leavepictureinpicture', () => {
    // "Back to tab" (or closing PiP): show the app again, on the watch page
    void window.electronAPI.focusWindow();
    if (!page.classList.contains('active')) {
      if (!videoEl.paused) switchTab('watch');
      else releaseExternal();
    } else {
      releaseExternal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && page.classList.contains('active') && !document.fullscreenElement) switchTab(backTo);
  });

}
