/**
 * "Unavailable tracks" dialog: tracks of an imported playlist that the platform won't play here
 * (on Spotify usually region-locked). Each shows its cover, title, artist, album, length and
 * place; the user can search YouTube (or paste a link) and add a copy, which the main process
 * puts at the track's own place in the playlist. "Ignore" hides a track for good.
 */
import type { CatalogEntry, LibraryPlaylist, SkippedTrack } from '../shared/types';
import { ICONS, el, formatDuration, iconButton, toast } from './dom';
import { t } from './i18n';
import { playQueue } from './playerbar';

let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

function close() {
  if (!overlay) return;
  document.getElementById('app-container')?.removeAttribute('inert');
  overlay.remove();
  overlay = null;
  if (onKey) document.removeEventListener('keydown', onKey, true);
  onKey = null;
}

const REASON_KEY = {
  region: 'libSkipRegion',
  local: 'libSkipLocal',
  episode: 'libSkipEpisode',
  unavailable: 'libSkipUnavailable',
} as const;

function thumb(src: string | undefined, cls: string): HTMLElement {
  const box = el('span', cls);
  if (src) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    img.addEventListener('error', () => img.remove());
    box.append(img);
  } else box.innerHTML = ICONS.audio; // static
  return box;
}

export function openSkippedTracks(p: LibraryPlaylist, sourceLabel: string) {
  close();
  const tracks = [...(p.skipped ?? [])].sort((a, b) => a.pos - b.pos);

  overlay = el('div', 'aura-modal-overlay skip-overlay active');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'skip-title');
  const card = el('div', 'aura-modal-card skip-card');
  const head = el('div', 'skip-head');
  const title = el('h3', 'modal-title', `${t('libSkippedTitle')} (${tracks.length})`);
  title.id = 'skip-title';
  const x = iconButton('player-icon-btn close', ICONS.close, t('libSkippedClose'));
  x.addEventListener('click', close);
  head.append(title, x);
  const desc = el('p', 'skip-desc', t('libSkippedDesc', { source: sourceLabel }));
  const list = el('div', 'skip-list');
  const done = el('p', 'skip-done', t('libSkippedAllDone'));
  done.hidden = true;
  card.append(head, desc, list, done);
  overlay.append(card);
  document.getElementById('app-container')?.setAttribute('inert', '');
  document.body.append(overlay);

  let left = tracks.length;
  const resolved = (row: HTMLElement) => {
    row.classList.add('leaving');
    setTimeout(() => row.remove(), 220);
    left--;
    title.textContent = `${t('libSkippedTitle')} (${left})`;
    if (left === 0) done.hidden = false;
  };

  for (const s of tracks) list.append(trackRow(p, s, resolved));

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
}

function trackRow(p: LibraryPlaylist, s: SkippedTrack, resolved: (row: HTMLElement) => void): HTMLElement {
  const row = el('div', 'skip-row');
  const main = el('div', 'skip-main');
  const text = el('div', 'skip-text');
  text.append(
    el('span', 'skip-title', s.title),
    el('span', 'skip-sub', [s.artist, s.album].filter(Boolean).join(' · ')),
    el('span', 'skip-meta', [t('libSkippedPos', { n: s.pos + 1 }), formatDuration(s.duration), t(REASON_KEY[s.reason] ?? 'libSkipUnavailable')].filter(Boolean).join(' · '))
  );
  const searchBtn = el('button', 'btn-browse skip-search-btn', t('libSkippedSearch'));
  searchBtn.type = 'button';
  const ignore = el('button', 'modal-btn-ghost skip-ignore', t('libSkippedIgnore'));
  ignore.type = 'button';
  const actions = el('div', 'skip-actions');
  actions.append(searchBtn, ignore);
  main.append(thumb(s.cover, 'skip-cover'), text, actions);

  const panel = el('div', 'skip-panel');
  panel.hidden = true;
  row.append(main, panel);

  const add = async (url: string, err: HTMLElement) => {
    const res = await window.electronAPI.libraryRestoreSkipped(p.id, s.key, url);
    if (res.success) {
      toast(t('libSkippedAdded', { title: s.title, n: res.position ?? s.pos + 1 }));
      resolved(row);
    } else {
      err.textContent = res.error === 'badUrl' ? t('libSkippedBadUrl') : t('libImportFailed');
      err.hidden = false;
    }
  };

  let searched = false;
  searchBtn.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    row.classList.toggle('open', !panel.hidden);
    if (panel.hidden || searched) return;
    searched = true;
    await fillPanel(panel, s, add);
  });
  ignore.addEventListener('click', async () => {
    await window.electronAPI.libraryDismissSkipped(p.id, s.key);
    resolved(row);
  });
  return row;
}

async function fillPanel(panel: HTMLElement, s: SkippedTrack, add: (url: string, err: HTMLElement) => Promise<void>) {
  const results = el('div', 'skip-results');
  const status = el('p', 'skip-status', t('libSkippedSearching'));
  results.append(status);

  // Paste a link instead
  const form = el('form', 'skip-paste');
  const input = el('input', 'explore-search-input') as HTMLInputElement;
  input.type = 'url';
  input.placeholder = t('libSkippedPaste');
  input.spellcheck = false;
  const addBtn = el('button', 'btn-browse', t('libSkippedAdd'));
  addBtn.type = 'submit';
  form.append(input, addBtn);
  const err = el('p', 'skip-error');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!input.value.trim()) return input.focus();
    addBtn.disabled = true;
    await add(input.value.trim(), err);
    addBtn.disabled = false;
  });
  panel.append(results, form, err);

  const query = [s.artist?.split(',')[0], s.title].filter(Boolean).join(' - ');
  const res = await window.electronAPI.search(query, 5);
  status.remove();
  const entries: CatalogEntry[] = res.success && res.data ? res.data.entries.filter((e) => !e.isLive) : [];
  if (!entries.length) {
    results.append(el('p', 'skip-status', t('libSkippedNoResults')));
    return;
  }
  for (const e of entries) {
    const r = el('div', 'skip-result');
    const info = el('div', 'skip-text');
    const close = s.duration && e.duration && Math.abs(s.duration - e.duration) <= 5;
    const meta = el('span', 'skip-meta', [e.artist, formatDuration(e.duration)].filter(Boolean).join(' · '));
    if (close) meta.append(el('span', 'skip-match', t('libSkippedLengthMatch')));
    info.append(el('span', 'skip-title', e.title), meta);
    const listen = iconButton('history-btn', ICONS.play, t('libSkippedPreview'));
    listen.addEventListener('click', () =>
      playQueue([{ id: e.id, title: e.title, artist: e.artist, thumbnail: e.thumbnail, duration: e.duration, url: e.url }], 0)
    );
    const pick = el('button', 'btn-browse', t('libSkippedAdd'));
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      pick.disabled = true;
      await add(e.url, err);
      pick.disabled = false;
    });
    r.append(thumb(e.thumbnail, 'skip-result-thumb'), info, listen, pick);
    results.append(r);
  }
}
