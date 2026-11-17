/**
 * Link preview: as soon as one link is pasted or typed (no Enter), a card appears between the
 * input and the queue with the thumbnail, title and every quality with its real size, so the
 * user picks 1080p (≈100 MB) instead of silently getting 4K (≈400–700 MB).
 */
import type { DownloadFormat, DownloadTaskRequest, LibraryItem, MediaProbe, QualityOption } from '../shared/types';
import { extractUrls, isSpotifyUrl } from '../shared/urls';
import { $, ICONS, el, formatBytes, formatDuration, iconButton, queueDownloads, toast } from './dom';
import { animateHeight, collapse, fadeIn } from './transitions';
import { LangKey, t } from './i18n';
import { openPlaylistModal } from './modals';
import { openStream } from './player';
import { playQueue } from './playerbar';
import { addToLibraryMenu, catalogToPlayItems } from './library';

const SOURCE_LABEL: Record<MediaProbe['source'], string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  apple: 'Apple Music',
  other: '',
};

/** Builds the download request for one quality of a probed link and queues it. */
export async function requestFromOption(p: MediaProbe, o: QualityOption): Promise<boolean> {
  const format: DownloadFormat = o.kind === 'video' && !isSpotifyUrl(p.url) ? 'mp4' : 'mp3';
  const req: DownloadTaskRequest = {
    url: p.url,
    format,
    formatId: o.formatId,
    maxHeight: o.height,
    audioCodec: o.audioCodec === 'm4a' ? 'm4a' : undefined,
    meta: {
      title: p.title,
      artist: p.artist,
      thumbnail: p.thumbnail && /^https:/.test(p.thumbnail) ? p.thumbnail : undefined,
      duration: p.duration,
    },
  };
  return (await queueDownloads([req])) > 0;
}

export function probeToLibraryItem(p: MediaProbe): LibraryItem {
  return {
    id: '',
    title: p.title,
    artist: p.artist,
    duration: p.duration,
    thumbnail: p.thumbnail,
    url: p.url,
    source: p.source,
    isVideo: p.isVideo,
  };
}

interface PreviewApi {
  /** Call on every input change; probes when the text holds exactly one link. */
  update: (text: string) => void;
  hide: () => void;
  /** The quality chosen for `url`, if the preview shows that link. */
  selection: (url: string) => { probe: MediaProbe; option: QualityOption } | null;
  /** The hero's MP3/MP4 cards pick the matching default in the preview. */
  selectKind: (kind: 'video' | 'audio') => void;
}

export function setupPreview(hooks: {
  onKindChange: (format: DownloadFormat) => void;
  onDownloaded: () => void;
  /** The hero's MP3 / MP4 choice decides which kind is preselected. */
  currentFormat: () => DownloadFormat;
}): PreviewApi {
  const host = $('link-preview');
  let currentUrl = '';
  let probe: MediaProbe | null = null;
  let selected: string | undefined;
  let token = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    token++;
    currentUrl = '';
    probe = null;
    // Glide shut (what sits below follows) instead of vanishing
    collapse(host, () => {
      host.hidden = true;
      host.innerHTML = '';
    });
  };

  const update = (text: string) => {
    clearTimeout(timer);
    const urls = extractUrls(text);
    const raw = text.trim();
    const url = urls.length === 1 ? urls[0] : urls.length === 0 && /^spotify:/i.test(raw) ? raw : '';
    if (!url) {
      if (!raw || urls.length > 1) hide();
      return;
    }
    if (url === currentUrl) return;
    timer = setTimeout(() => load(url), 300); // let a paste / typing settle
  };

  async function load(url: string) {
    const my = ++token;
    currentUrl = url;
    probe = null;
    animateHeight(host, renderLoading);
    const res = await window.electronAPI.probeMedia(url);
    if (my !== token) return;
    // Skeleton → result: the card resizes smoothly and the real content rises in
    animateHeight(host, () => {
      if (!res.success || !res.data) {
        renderError(res.error);
      } else {
        probe = res.data;
        const wantVideo = hooks.currentFormat() === 'mp4' && !!probe.defaultVideo;
        selected = (wantVideo ? probe.defaultVideo : probe.defaultAudio) ?? probe.defaultVideo;
        render();
      }
    });
    host.querySelectorAll<HTMLElement>('.lp-media, .lp-body').forEach((n) => fadeIn(n, 4));
  }

  function card(): HTMLElement {
    // Only a card that appears from nothing plays the entrance; re-renders (quality chips,
    // skeleton → result) swap in place so nothing flickers
    const entering = host.hidden || !host.firstChild;
    host.hidden = false;
    host.innerHTML = '';
    const c = el('div', entering ? 'lp-card' : 'lp-card lp-swap');
    const close = iconButton('lp-close player-icon-btn', ICONS.close, t('pvClose'));
    close.addEventListener('click', hide);
    c.append(close);
    host.append(c);
    return c;
  }

  function renderLoading() {
    const c = card();
    c.classList.add('loading');
    c.append(el('div', 'lp-media skeleton'));
    const body = el('div', 'lp-body');
    body.append(el('div', 'skeleton-line'), el('div', 'skeleton-line short'), el('div', 'lp-loading-text', t('pvLoading')));
    c.append(body);
  }

  function renderError(detail?: string) {
    const c = card();
    const body = el('div', 'lp-body');
    body.append(el('h3', 'lp-title', t('pvFailed')));
    if (detail) body.append(el('p', 'lp-note', detail));
    c.append(body);
  }

  function media(p: MediaProbe, onPlay: () => void): HTMLElement {
    const m = el('button', `lp-media${p.isVideo ? '' : ' square'}`);
    m.type = 'button';
    m.title = p.isVideo ? t('pvWatch') : t('pvListen');
    if (p.thumbnail) {
      const img = el('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = p.thumbnail;
      img.addEventListener('error', () => img.remove());
      m.append(img);
    }
    if (p.duration && p.kind === 'single') m.append(el('span', 'explore-badge', formatDuration(p.duration)));
    const overlay = el('div', 'explore-play-overlay');
    overlay.innerHTML = ICONS.play; // static
    m.append(overlay);
    m.addEventListener('click', onPlay);
    return m;
  }

  function header(body: HTMLElement, p: MediaProbe, subParts: string[]) {
    const label = SOURCE_LABEL[p.source];
    if (label) body.append(el('span', 'lp-source', label));
    const title = el('h3', 'lp-title', p.title);
    title.title = p.title;
    body.append(title, el('div', 'lp-sub', subParts.filter(Boolean).join(' · ')));
  }

  function render() {
    const p = probe;
    if (!p) return;
    if (p.kind === 'collection') return renderCollection(p);

    const c = card();
    const listen = () =>
      playQueue([{ title: p.title, artist: p.artist, thumbnail: p.thumbnail, duration: p.duration, url: p.url, isVideo: p.isVideo }], 0, { radio: true });
    const m = media(p, () =>
      p.isVideo ? openStream(p.url, { title: p.title, artist: p.artist, thumbnail: p.thumbnail, from: m }) : listen()
    );
    c.append(m);

    const body = el('div', 'lp-body');
    header(body, p, [p.artist ?? '', formatDuration(p.duration)]);

    const opts = el('div', 'lp-options');
    const group = (kind: 'video' | 'audio', label: string) => {
      const list = p.options.filter((o) => o.kind === kind);
      if (!list.length) return;
      const g = el('div', 'lp-group');
      g.append(el('span', 'lp-group-label', label));
      const chips = el('div', 'lp-chips');
      chips.setAttribute('role', 'radiogroup');
      for (const o of list) {
        const chip = el('button', `lp-chip${o.id === selected ? ' active' : ''}`);
        chip.type = 'button';
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(o.id === selected));
        chip.append(el('span', 'lp-chip-label', o.label), el('span', 'lp-chip-size', sizeText(o) || o.detail || ''));
        chip.title = [o.label, o.detail, sizeText(o)].filter(Boolean).join(' · ');
        chip.addEventListener('click', () => {
          selected = o.id;
          hooks.onKindChange(o.kind === 'video' ? 'mp4' : 'mp3');
          render();
        });
        chips.append(chip);
      }
      g.append(chips);
      opts.append(g);
    };
    group('video', t('pvVideo'));
    group('audio', t('pvAudio'));
    body.append(opts);

    const note: LangKey | null = p.isLive ? 'pvLive' : p.source === 'spotify' ? 'pvSpotifyNote' : p.source === 'apple' ? 'pvAppleNote' : null;
    if (note) body.append(el('p', 'lp-note', t(note)));

    const actions = el('div', 'lp-actions');
    const opt = p.options.find((o) => o.id === selected);
    actions.append(el('span', 'lp-summary', opt ? [opt.label, opt.detail, sizeText(opt)].filter(Boolean).join(' · ') : ''));
    const add = iconButton('btn-browse lp-add', ICONS.plus, t('addToPlaylist'), t('pvAddToLibrary'));
    add.addEventListener('click', () => addToLibraryMenu(add, [probeToLibraryItem(p)]));
    const listenBtn = iconButton('btn-browse', ICONS.headphones, t('pvListen'), t('pvListen'));
    listenBtn.addEventListener('click', listen);
    const dl = iconButton('modal-btn-primary lp-download', ICONS.download, t('pvDownload'), t('pvDownload'));
    dl.disabled = !opt || !!p.isLive;
    dl.addEventListener('click', () => download());
    actions.append(add, listenBtn, dl);
    body.append(actions);
    c.append(body);
  }

  function renderCollection(p: MediaProbe) {
    const c = card();
    c.classList.add('collection');
    const playAll = async (shuffle = false) => {
      const res = await window.electronAPI.getPlaylist(p.url);
      if (res.success && res.data) playQueue(catalogToPlayItems(res.data), 0, { shuffle });
    };
    c.append(media(p, () => playAll()));
    const body = el('div', 'lp-body');
    const kind = p.collectionKind === 'album' ? t('plKindAlbum') : t('plKindPlaylist');
    header(body, p, [kind.charAt(0) + kind.slice(1).toLocaleLowerCase(), t('pvItems', { n: p.itemCount ?? 0 }), p.duration ? formatDuration(p.duration) : '']);

    const actions = el('div', 'lp-actions');
    actions.append(el('span', 'lp-summary', ''));
    const importBtn = iconButton('btn-browse', ICONS.plus, t('pvImport'), t('pvImport'));
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      const res = await window.electronAPI.libraryImport(p.url);
      importBtn.disabled = false;
      if (res.success && res.playlist) toast(t('libImported', { name: res.playlist.name, n: res.playlist.items.length }));
      else toast(t('libImportFailed'));
    });
    const play = iconButton('btn-browse', ICONS.play, t('pvPlayAll'), t('pvPlayAll'));
    play.addEventListener('click', () => playAll());
    const choose = iconButton('modal-btn-primary lp-download', ICONS.download, t('pvChooseTracks'), t('pvChooseTracks'));
    choose.addEventListener('click', () => {
      openPlaylistModal(p.url, p.isVideo ? 'mp4' : 'mp3');
    });
    actions.append(importBtn, play, choose);
    body.append(actions);
    c.append(body);
  }

  async function download() {
    if (!probe) return;
    const o = probe.options.find((x) => x.id === selected);
    if (!o) return;
    if (await requestFromOption(probe, o)) {
      hide();
      hooks.onDownloaded();
    }
  }

  function sizeText(o: QualityOption): string {
    return o.sizeBytes ? `${o.approx ? '~' : ''}${formatBytes(o.sizeBytes)}` : '';
  }

  document.addEventListener('language-changed', () => {
    if (probe) render();
  });

  return {
    update,
    hide,
    selection: (url) => {
      if (!probe || probe.kind !== 'single' || (url !== currentUrl && url !== probe.url)) return null;
      const option = probe.options.find((o) => o.id === selected);
      return option ? { probe, option } : null;
    },
    selectKind: (kind) => {
      if (!probe || probe.kind !== 'single') return;
      const pick = kind === 'video' ? probe.defaultVideo : probe.defaultAudio;
      if (pick && probe.options.some((o) => o.id === pick)) {
        selected = pick;
        render();
      }
    },
  };
}
