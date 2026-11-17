import type { CatalogList, DownloadFormat, DownloadTaskRequest } from '../shared/types';
import { extractUrls, isSpotifyUrl } from '../shared/urls';
import { $, el, formatBytes, formatDuration, formatHuman, queueDownloads, setupModal, switchTab } from './dom';
import { t } from './i18n';

/** Two-button MP3/MP4 toggle inside a container: <button data-format="mp3|mp4"> */
function formatToggle(container: HTMLElement, onChange?: (f: DownloadFormat) => void) {
  let value: DownloadFormat = 'mp3';
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[data-format]')];
  const set = (f: DownloadFormat) => {
    value = f;
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.format === f));
    onChange?.(f);
  };
  buttons.forEach((b) => b.addEventListener('click', () => !b.disabled && set(b.dataset.format as DownloadFormat)));
  return {
    get: () => value,
    set,
    setMp4Enabled(enabled: boolean) {
      const mp4 = buttons.find((b) => b.dataset.format === 'mp4');
      if (mp4) mp4.disabled = !enabled;
      if (!enabled && value === 'mp4') set('mp3');
    },
  };
}

// Lists this long get an estimate, and from CONFIRM_AT the download button asks once more,
// so nobody starts a 300-track, 10 GB queue by accident.
const WARN_AT = 25;
const CONFIRM_AT = 50;
const BATCH_WARN_AT = 20;

/** Rough figures: MP3 ~320 kbps ≈ 2.4 MB/min; MP4 1080p ≈ 20 MB/min; seconds of work per item. */
function estimate(seconds: number, count: number, format: DownloadFormat, spotify: boolean, concurrency: number) {
  const minutes = seconds / 60;
  const bytes = minutes * (format === 'mp4' ? 20 : 2.4) * 1024 * 1024;
  const perItem = spotify ? 25 : format === 'mp4' ? 45 : 20; // incl. conversion + tagging
  const work = (count * perItem) / Math.max(1, concurrency);
  return { size: formatBytes(bytes), dur: formatHuman(seconds), time: formatHuman(work) };
}

let concurrency = 3;
const refreshConcurrency = () =>
  window.electronAPI.getSettings().then((s) => (concurrency = s.maxConcurrentDownloads || 3));

// ─────────────────────────────── Batch links ───────────────────────────────

let openBatchImpl: ((text: string, format: DownloadFormat) => void) | null = null;

export function openBatchModal(text = '', format: DownloadFormat = 'mp3') {
  openBatchImpl?.(text, format);
}

export function setupBatchModal() {
  const overlay = $('batch-modal');
  const modal = setupModal(overlay);
  const textarea = $<HTMLTextAreaElement>('batch-textarea');
  const count = $('batch-count');
  const queueBtn = $<HTMLButtonElement>('batch-queue-btn');
  const warn = $('batch-warn');
  const fmt = formatToggle($('batch-format'));

  const refresh = () => {
    const n = extractUrls(textarea.value).length;
    warn.textContent = n >= BATCH_WARN_AT ? t('batchLongWarn', { n, c: concurrency }) : '';
    warn.style.display = n >= BATCH_WARN_AT ? '' : 'none';
    count.textContent = n > 0 ? t('batchDetected', { n }) : t('batchNone');
    count.classList.toggle('warn', n === 0 && textarea.value.trim().length > 0);
    queueBtn.disabled = n === 0;
    queueBtn.textContent = t('batchQueue', { n });
  };
  textarea.addEventListener('input', refresh);
  overlay.querySelector('[data-close]')?.addEventListener('click', modal.close);

  queueBtn.addEventListener('click', async () => {
    const urls = extractUrls(textarea.value);
    if (urls.length === 0) return;
    const format = fmt.get();
    modal.close();
    // Spotify is audio-only; main forces MP3 for it anyway
    await queueDownloads(urls.map((url) => ({ url, format: isSpotifyUrl(url) ? 'mp3' : format })));
    textarea.value = '';
  });

  openBatchImpl = (text, format) => {
    // Normalize to one link per line so the user sees what was detected
    const urls = extractUrls(text);
    textarea.value = urls.length > 0 ? urls.join('\n') + '\n' : text;
    fmt.set(format);
    refresh();
    refreshConcurrency().then(refresh);
    modal.open();
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 50);
  };
  document.addEventListener('language-changed', refresh);
}

// ─────────────────────────────── Playlist preview ───────────────────────────────

let openPlaylistImpl: ((url: string, format: DownloadFormat) => void) | null = null;

export function openPlaylistModal(url: string, format: DownloadFormat = 'mp3') {
  openPlaylistImpl?.(url, format);
}

export function setupPlaylistModal() {
  const overlay = $('playlist-modal');
  let token = 0;
  const modal = setupModal(overlay, () => token++);
  const cover = $<HTMLImageElement>('pl-cover');
  const kind = $('pl-kind');
  const title = $('pl-title');
  const meta = $('pl-meta');
  const loading = $('pl-loading');
  const errorBox = $('pl-error');
  const errorText = $('pl-error-text');
  const wholeBtn = $<HTMLButtonElement>('pl-whole-btn');
  const body = $('pl-body');
  const selectAll = $<HTMLInputElement>('pl-select-all');
  const selectedLabel = $('pl-selected');
  const note = $('pl-note');
  const items = $('pl-items');
  const subfolder = $<HTMLInputElement>('pl-subfolder');
  const downloadBtn = $<HTMLButtonElement>('pl-download-btn');
  const warn = $('pl-warn');
  let armed = false; // a long list needs a second, deliberate click
  const fmt = formatToggle($('pl-format'), () => {
    armed = false;
    refreshSelection();
  });
  $('pl-close-btn').addEventListener('click', modal.close);

  let list: CatalogList | null = null;
  let sourceUrl = '';
  let checks: HTMLInputElement[] = [];

  const refreshSelection = () => {
    if (!list) return;
    const picked = list.entries.filter((_, i) => checks[i]?.checked);
    const n = picked.length;
    selectedLabel.textContent = t('plSelected', { n, total: checks.length });
    selectAll.checked = n === checks.length && n > 0;
    selectAll.indeterminate = n > 0 && n < checks.length;
    downloadBtn.disabled = n === 0;
    if (n < CONFIRM_AT) armed = false;
    downloadBtn.textContent = armed ? t('plLongConfirm', { n }) : t('plDownload', { n });
    downloadBtn.classList.toggle('confirm', armed);

    if (n >= WARN_AT) {
      const seconds = picked.reduce((s, e) => s + (e.duration || 210), 0); // unknown length: ~3.5 min
      const spotify = list.source === 'spotify';
      const est = estimate(seconds, n, spotify ? 'mp3' : fmt.get(), spotify, concurrency);
      warn.textContent = t('plLongWarn', { n, dur: est.dur, size: est.size, time: est.time });
      warn.style.display = '';
      warn.classList.toggle('emphasis', armed);
    } else {
      warn.style.display = 'none';
    }
  };

  const onPick = () => {
    armed = false;
    refreshSelection();
  };
  selectAll.addEventListener('change', () => {
    checks.forEach((c) => (c.checked = selectAll.checked));
    onPick();
  });

  function setState(state: 'loading' | 'error' | 'ready') {
    loading.style.display = state === 'loading' ? 'flex' : 'none';
    errorBox.style.display = state === 'error' ? 'flex' : 'none';
    body.style.display = state === 'ready' ? 'flex' : 'none';
  }

  function render(data: CatalogList) {
    list = data;
    kind.textContent = data.kind === 'album' ? t('plKindAlbum') : t('plKindPlaylist');
    title.textContent = data.title;
    const total = data.entries.reduce((s, e) => s + (e.duration || 0), 0);
    meta.textContent = [t('plTrackCount', { n: data.entries.length }), formatDuration(total)].filter(Boolean).join(' · ');
    if (data.thumbnail) {
      cover.src = data.thumbnail;
      cover.style.visibility = '';
    }

    const notes: string[] = [];
    if (data.totalCount) notes.push(t('plTruncated', { n: data.entries.length, total: data.totalCount }));
    if (data.source === 'spotify') notes.push(t('plSpotifyMp3Only'));
    note.textContent = notes.join(' · ');
    note.style.display = notes.length ? '' : 'none';
    fmt.setMp4Enabled(data.source !== 'spotify');

    items.innerHTML = '';
    checks = [];
    data.entries.forEach((entry, i) => {
      const row = el('label', 'pl-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', onPick);
      checks.push(cb);
      const text = el('div', 'pl-row-text');
      text.append(el('span', 'pl-row-title', entry.title));
      if (entry.artist) text.append(el('span', 'pl-row-artist', entry.artist));
      row.append(cb, el('span', 'pl-row-index', String(i + 1)), text, el('span', 'pl-row-duration', formatDuration(entry.duration)));
      items.append(row);
    });
    items.scrollTop = 0;
    refreshSelection();
    setState('ready');
  }

  downloadBtn.addEventListener('click', async () => {
    if (!list) return;
    const count = checks.filter((c) => c.checked).length;
    if (count >= CONFIRM_AT && !armed) {
      armed = true;
      refreshSelection();
      return;
    }
    armed = false;
    const format = list.source === 'spotify' ? 'mp3' : fmt.get();
    const folder = subfolder.checked ? list.title : undefined;
    const requests: DownloadTaskRequest[] = list.entries
      .filter((_, i) => checks[i]?.checked)
      .map((e) => ({
        url: e.url,
        format,
        subfolder: folder,
        meta: { title: e.title, artist: e.artist, thumbnail: e.thumbnail, duration: e.duration },
      }));
    modal.close();
    const n = await queueDownloads(requests, { silent: true });
    if (n > 0) switchTab('downloads');
  });

  // Fallback when the list can't be previewed: let the tool download the whole list itself
  wholeBtn.addEventListener('click', async () => {
    const format = isSpotifyUrl(sourceUrl) ? 'mp3' : fmt.get();
    modal.close();
    await queueDownloads([{ url: sourceUrl, format }]);
  });

  openPlaylistImpl = async (url, format) => {
    const my = ++token;
    sourceUrl = url;
    list = null;
    armed = false;
    refreshConcurrency();
    kind.textContent = '';
    title.textContent = url;
    meta.textContent = '';
    cover.removeAttribute('src');
    cover.style.visibility = 'hidden';
    fmt.set(format);
    fmt.setMp4Enabled(!isSpotifyUrl(url));
    setState('loading');
    modal.open();

    const res = await window.electronAPI.getPlaylist(url);
    if (my !== token) return; // closed or reopened meanwhile
    if (!res.success || !res.data) {
      errorText.textContent = res.error ? `${t('plLoadFailed')}\n${res.error}` : t('plLoadFailed');
      setState('error');
      return;
    }
    render(res.data);
  };

  document.addEventListener('language-changed', () => {
    if (list) {
      kind.textContent = list.kind === 'album' ? t('plKindAlbum') : t('plKindPlaylist');
      refreshSelection();
    }
  });
}
