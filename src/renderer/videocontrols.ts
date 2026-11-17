/**
 * Custom video controls for the watch page.
 *
 * Why not the native ones: 1080p+ YouTube streams are video-only with the sound in a separate
 * <audio> element, so Chromium greys out the native volume control. These controls drive the
 * element that is actually audible, and add speed, dubbed audio and (translated) subtitles.
 */
import type { AudioTrack, SubtitleTrack } from '../shared/types';
import { ICONS, el, formatDuration, iconButton } from './dom';
import { getLanguage, t } from './i18n';

export interface VideoControlsApi {
  /** A new video: its page URL (for subtitles) and its subtitle / audio-language choices. */
  setMedia: (info: { url: string; subtitles: SubtitleTrack[]; audioTracks: AudioTrack[] } | null) => void;
  /** Re-read play / volume state (e.g. after the audible element changed). */
  refresh: () => void;
  toggleFullscreen: () => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Language names in the app's language ("tr" → "Türkçe"), falling back to YouTube's English name. */
function langName(code: string, fallback: string): string {
  try {
    const name = new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(code.replace(/-orig$/, ''));
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(getLanguage()) + name.slice(1);
  } catch {
    /* unknown code */
  }
  return fallback;
}

/** Cue position: lifted above the control bar while it shows, near the bottom edge when idle. */
function placeCues(video: HTMLVideoElement, idle: boolean) {
  for (const tt of Array.from(video.textTracks)) {
    for (const cue of Array.from(tt.cues ?? [])) {
      const c = cue as VTTCue;
      c.snapToLines = true;
      c.line = idle ? -2 : -4;
    }
  }
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function attachVideoControls(o: {
  screen: HTMLElement;
  video: HTMLVideoElement;
  /** The element whose volume the user hears (the separate audio track when there is one). */
  audible: () => HTMLMediaElement;
  /** null = the video's own / original audio */
  onAudioTrack: (track: AudioTrack | null) => void;
  isActive: () => boolean;
}): VideoControlsApi {
  const { screen, video } = o;
  video.controls = false;

  const root = el('div', 'vc');
  const status = el('div', 'vc-status');
  status.hidden = true;
  const bottom = el('div', 'vc-bottom');
  const seek = el('input', 'vc-seek') as HTMLInputElement;
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.setAttribute('aria-label', t('barSeek'));

  const row = el('div', 'vc-row');
  const playBtn = iconButton('vc-btn', ICONS.play, t('barPlay'));
  const muteBtn = iconButton('vc-btn', ICONS.volume, t('barMute'));
  const volume = el('input', 'vc-volume') as HTMLInputElement;
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.setAttribute('aria-label', t('barVolume'));
  const time = el('span', 'vc-time');
  const spacer = el('span', 'vc-spacer');
  const speedBtn = el('button', 'vc-btn vc-text', '1×');
  speedBtn.type = 'button';
  speedBtn.title = t('vcSpeed');
  const audioBtn = iconButton('vc-btn', ICONS.globe, t('vcAudio'));
  const ccBtn = iconButton('vc-btn vc-cc', ICONS.cc, t('vcSubtitles'));
  const pipBtn = iconButton('vc-btn', ICONS.pip, t('playerPipTitle'));
  const fsBtn = iconButton('vc-btn', ICONS.fullscreen, t('playerFullscreenTitle'));
  row.append(playBtn, muteBtn, volume, time, spacer, speedBtn, audioBtn, ccBtn, pipBtn, fsBtn);
  const menu = el('div', 'pop-menu vc-menu');
  menu.hidden = true;
  bottom.append(seek, row);
  root.append(status, bottom, menu);
  screen.append(root);

  let url = '';
  let subtitles: SubtitleTrack[] = [];
  let audioTracks: AudioTrack[] = [];
  let currentSub: SubtitleTrack | null = null;
  let currentAudio: AudioTrack | null = null;
  let subToken = 0;
  let seeking = false;

  // ── State → UI ──
  const audible = () => o.audible();
  function renderPlay() {
    playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause; // static
    playBtn.title = video.paused ? t('barPlay') : t('barPause');
    screen.classList.toggle('vc-paused', video.paused);
  }
  function renderTime() {
    const d = isFinite(video.duration) ? video.duration : 0;
    if (!seeking) {
      seek.value = d ? String(Math.round((video.currentTime / d) * 1000)) : '0';
      seek.style.setProperty('--pb-fill', `${Number(seek.value) / 10}%`);
    }
    time.textContent = `${formatDuration(video.currentTime) || '0:00'} / ${formatDuration(d) || '0:00'}`;
  }
  function renderVolume() {
    const a = audible();
    const v = a.muted ? 0 : a.volume;
    volume.value = String(Math.round(v * 100));
    volume.style.setProperty('--pb-fill', `${v * 100}%`);
    muteBtn.innerHTML = v === 0 ? ICONS.mute : ICONS.volume; // static
  }
  function renderSpeed() {
    const r = video.playbackRate;
    speedBtn.textContent = `${Number.isInteger(r) ? r : r.toString()}×`;
  }
  function renderTracks() {
    audioBtn.hidden = audioTracks.length < 2;
    ccBtn.hidden = subtitles.length === 0;
    ccBtn.classList.toggle('on', !!currentSub);
  }

  for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, () => {
    renderPlay();
    wake();
  });
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('durationchange', renderTime);
  video.addEventListener('ratechange', renderSpeed);
  video.addEventListener('loadedmetadata', () => {
    // Keep the chosen speed across videos and quality switches
    const saved = parseFloat(store.get('vc-rate') ?? '');
    if (SPEEDS.includes(saved)) video.playbackRate = saved;
    renderVolume();
  });

  // ── Controls ──
  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  playBtn.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  video.addEventListener('dblclick', () => toggleFullscreen());

  seek.addEventListener('input', () => {
    seeking = true;
    seek.style.setProperty('--pb-fill', `${Number(seek.value) / 10}%`);
    const d = isFinite(video.duration) ? video.duration : 0;
    time.textContent = `${formatDuration((Number(seek.value) / 1000) * d) || '0:00'} / ${formatDuration(d)}`;
  });
  seek.addEventListener('change', () => {
    if (isFinite(video.duration)) video.currentTime = (Number(seek.value) / 1000) * video.duration;
    seeking = false;
  });

  const setVolume = (v: number) => {
    const a = audible();
    a.volume = Math.min(1, Math.max(0, v));
    a.muted = a.volume === 0;
    store.set('vc-volume', String(a.volume));
    renderVolume();
  };
  volume.addEventListener('input', () => setVolume(Number(volume.value) / 100));
  muteBtn.addEventListener('click', () => {
    const a = audible();
    a.muted = !a.muted;
    if (!a.muted && a.volume === 0) a.volume = 0.5;
    renderVolume();
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) screen.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }
  fsBtn.addEventListener('click', toggleFullscreen);
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    } catch {
      /* not available */
    }
  });

  // ── Menus ──
  let menuFor: HTMLElement | null = null;
  function openMenu(anchor: HTMLElement, build: () => void) {
    if (menuFor === anchor && !menu.hidden) return closeMenu();
    menu.innerHTML = '';
    build();
    menu.hidden = false;
    menuFor = anchor;
    wake();
  }
  function closeMenu() {
    menu.hidden = true;
    menuFor = null;
  }
  function item(label: string, active: boolean, onClick: () => void, detail?: string) {
    const b = el('button', `pop-menu-item${active ? ' active' : ''}`);
    b.type = 'button';
    b.append(el('span', 'vc-check', active ? '✓' : ''), el('span', 'pop-menu-label', label));
    if (detail) b.append(el('span', 'pop-menu-detail', detail));
    b.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
    menu.append(b);
  }

  speedBtn.addEventListener('click', () =>
    openMenu(speedBtn, () => {
      menu.append(el('div', 'pop-menu-head', t('vcSpeed')));
      for (const s of SPEEDS) {
        item(s === 1 ? t('vcNormal') : `${s}×`, video.playbackRate === s, () => {
          video.playbackRate = s;
          store.set('vc-rate', String(s));
        });
      }
    })
  );

  audioBtn.addEventListener('click', () =>
    openMenu(audioBtn, () => {
      menu.append(el('div', 'pop-menu-head', t('vcAudio')));
      for (const a of audioTracks) {
        const active = currentAudio ? currentAudio.lang === a.lang : a.original;
        item(a.label, active, () => {
          currentAudio = a.original ? null : a;
          o.onAudioTrack(currentAudio);
        }, a.original ? t('vcOriginal') : t('vcDubbed'));
      }
    })
  );

  ccBtn.addEventListener('click', () =>
    openMenu(ccBtn, () => {
      menu.append(el('div', 'pop-menu-head', t('vcSubtitles')));
      item(t('vcOff'), !currentSub, () => setSubtitle(null));
      const own = subtitles.filter((s) => s.kind !== 'translated');
      const translated = subtitles.filter((s) => s.kind === 'translated');
      for (const s of own) item(langName(s.lang, s.name), currentSub === s, () => setSubtitle(s), s.kind === 'auto' ? t('vcAutoGenerated') : undefined);
      if (translated.length) {
        menu.append(el('div', 'pop-menu-head', t('vcTranslated')));
        const named = translated.map((s) => ({ s, name: langName(s.lang, s.name) }));
        named.sort((a, b) => a.name.localeCompare(b.name, getLanguage()));
        for (const { s, name } of named) item(name, currentSub === s, () => setSubtitle(s));
      }
    })
  );

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !(menuFor && menuFor.contains(e.target as Node))) closeMenu();
  });

  // ── Subtitles: WebVTT from main → blob <track> ──
  function clearTracks() {
    for (const tr of [...video.querySelectorAll('track')]) {
      if (tr.src.startsWith('blob:')) URL.revokeObjectURL(tr.src);
      tr.remove();
    }
  }
  async function setSubtitle(s: SubtitleTrack | null) {
    const my = ++subToken;
    currentSub = s;
    store.set('vc-sub', s ? s.lang : '');
    renderTracks();
    clearTracks();
    if (!s) {
      showStatus('');
      return;
    }
    showStatus(s.kind === 'translated' ? t('vcTranslating') : t('vcLoadingSubs'));
    const res = await window.electronAPI.getSubtitle(url, s);
    if (my !== subToken) return;
    if (!res.success || !res.vtt) {
      showStatus(t('vcSubsFailed'), 3000);
      currentSub = null;
      renderTracks();
      return;
    }
    showStatus('');
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.srclang = s.lang;
    track.label = s.name;
    track.src = URL.createObjectURL(new Blob([res.vtt], { type: 'text/vtt' }));
    track.default = true;
    track.addEventListener('load', () => placeCues(video, screen.classList.contains('vc-idle')));
    video.append(track);
    track.track.mode = 'showing';
  }

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  function showStatus(text: string, hideAfter = 0) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.hidden = !text;
    if (text && hideAfter) statusTimer = setTimeout(() => (status.hidden = true), hideAfter);
  }

  // ── Auto-hide while playing ──
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function setIdle(idle: boolean) {
    if (screen.classList.contains('vc-idle') === idle) return;
    screen.classList.toggle('vc-idle', idle);
    placeCues(video, idle);
  }
  function wake() {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && menu.hidden) setIdle(true);
    }, 2500);
  }
  screen.addEventListener('mousemove', wake);
  screen.addEventListener('mouseleave', () => {
    if (!video.paused && menu.hidden) setIdle(true);
  });

  // ── Keyboard (YouTube's keys) ──
  document.addEventListener('keydown', (e) => {
    if (!o.isActive() || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (/input|textarea|select/i.test(target.tagName) && target !== seek && target !== volume) return;
    const k = e.key.toLowerCase();
    const handled = ((): boolean => {
      if (k === ' ' || k === 'k') return toggle(), true;
      if (k === 'arrowright') return (video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)), true;
      if (k === 'arrowleft') return (video.currentTime = Math.max(0, video.currentTime - 5)), true;
      if (k === 'arrowup') return setVolume(audible().volume + 0.05), true;
      if (k === 'arrowdown') return setVolume(audible().volume - 0.05), true;
      if (k === 'm') return muteBtn.click(), true;
      if (k === 'f') return toggleFullscreen(), true;
      if (k === 'c' && subtitles.length) {
        const pref = subtitles.find((s) => s.lang === store.get('vc-sub-last')) ?? subtitles[0];
        if (currentSub) store.set('vc-sub-last', currentSub.lang);
        void setSubtitle(currentSub ? null : pref);
        return true;
      }
      return false;
    })();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      wake();
    }
  }, true);

  return {
    setMedia(info) {
      subToken++;
      clearTracks();
      showStatus('');
      closeMenu();
      url = info?.url ?? '';
      subtitles = info?.subtitles ?? [];
      audioTracks = info?.audioTracks ?? [];
      currentSub = null;
      currentAudio = null;
      renderTracks();
      // Restore the subtitle language the user picked last time, when this video has it
      const pref = store.get('vc-sub');
      const match = pref ? subtitles.find((s) => s.lang === pref) : undefined;
      if (match) void setSubtitle(match);
      const vol = parseFloat(store.get('vc-volume') ?? '');
      if (isFinite(vol)) {
        audible().volume = vol;
        video.volume = vol;
      }
      renderPlay();
      renderTime();
      renderVolume();
      renderSpeed();
    },
    refresh() {
      renderPlay();
      renderVolume();
      renderTime();
    },
    toggleFullscreen,
  };
}
