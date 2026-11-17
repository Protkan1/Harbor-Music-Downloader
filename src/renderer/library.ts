/**
 * Library tab: the user's own playlists (music and video, local files and links), playlists
 * imported from YouTube / Spotify / SoundCloud / Apple Music, and the "Add to playlist" menu
 * used across the app.
 */
import type { CatalogList, DownloadTaskRequest, LibraryItem, LibraryPlaylist } from '../shared/types';
import { isSpotifyUrl } from '../shared/urls';
import { $, ICONS, el, formatDuration, formatHuman, iconButton, queueDownloads, switchTab, toast } from './dom';
import { t } from './i18n';
import { PlayItem, playQueue } from './playerbar';
import { fadeIn } from './transitions';

const SOURCE_LABEL: Record<string, string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  apple: 'Apple Music',
  local: '',
  other: '',
};
const originLabel = (p: LibraryPlaylist) => (p.origin?.source === 'local' ? t('libLocal') : SOURCE_LABEL[p.origin?.source ?? ''] ?? '');

let playlists: LibraryPlaylist[] = [];
const refreshListeners = new Set<() => void>();

async function refresh() {
  playlists = await window.electronAPI.libraryList();
  refreshListeners.forEach((l) => l());
}

/** "C:\Music\a b.mp3" → "file:///C:/Music/a%20b.mp3" */
export function toFileUrl(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter((x, i) => x || i === 0);
  // Keep the drive letter ("C:") as is; encode every other segment (spaces, #, %, ...)
  const encoded = parts.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return `file:///${encoded.replace(/^\//, '')}`;
}

export function libraryItemToPlayItem(i: LibraryItem): PlayItem {
  return {
    id: i.id,
    title: i.title,
    artist: i.artist,
    thumbnail: i.thumbnail,
    duration: i.duration,
    url: i.url || undefined,
    fileUrl: i.filePath ? toFileUrl(i.filePath) : undefined,
    isVideo: i.isVideo,
  };
}

export function catalogToPlayItems(list: CatalogList): PlayItem[] {
  return list.entries.map((e) => ({
    id: e.id,
    title: e.title,
    artist: e.artist,
    thumbnail: e.thumbnail,
    duration: e.duration,
    url: e.url,
    isVideo: list.source === 'youtube',
  }));
}

// ─────────────────────────────── "Add to playlist" menu ───────────────────────────────

let openMenu: HTMLElement | null = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** A small menu next to `anchor`: pick a playlist, or create one with these items. */
export async function addToLibraryMenu(anchor: HTMLElement, items: LibraryItem[]) {
  closeMenu();
  if (!playlists.length) await refresh();
  const menu = el('div', 'pop-menu add-menu');
  menu.setAttribute('role', 'menu');
  menu.append(el('div', 'pop-menu-head', t('addToPlaylist')));

  for (const p of playlists) {
    const b = el('button', 'pop-menu-item');
    b.type = 'button';
    b.append(el('span', 'pop-menu-label', p.name), el('span', 'pop-menu-size', String(p.items.length)));
    b.addEventListener('click', async () => {
      closeMenu();
      const added = await window.electronAPI.libraryAddItems(p.id, items);
      toast(added > 0 ? t('addedTo', { name: p.name }) : t('alreadyIn'));
    });
    menu.append(b);
  }

  const form = el('form', 'add-menu-new');
  const input = el('input', 'explore-search-input') as HTMLInputElement;
  input.placeholder = t('libNewPrompt');
  input.maxLength = 120;
  const create = iconButton('btn-browse', ICONS.plus, t('libNew'));
  form.append(input, create);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    closeMenu();
    const p = await window.electronAPI.libraryCreate(name, items);
    toast(t('addedTo', { name: p.name }));
  });
  menu.append(form);

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = 260;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  const below = r.bottom + 6;
  menu.style.top = `${below + 320 > window.innerHeight ? Math.max(8, r.top - 6 - Math.min(320, menu.offsetHeight)) : below}px`;
  openMenu = menu;
  if (!playlists.length) setTimeout(() => input.focus(), 30);
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// ─────────────────────────────── Library tab ───────────────────────────────

export function setupLibrary() {
  const listHost = $('lib-list');
  const detail = $('lib-detail');
  const newForm = $<HTMLFormElement>('lib-new-form');
  const newInput = $<HTMLInputElement>('lib-new-input');
  const importForm = $<HTMLFormElement>('lib-import-form');
  const importInput = $<HTMLInputElement>('lib-import-input');
  const importBtn = $<HTMLButtonElement>('lib-import-btn');
  let selectedId: string | null = null;

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = newInput.value.trim();
    if (!name) return newInput.focus();
    const p = await window.electronAPI.libraryCreate(name);
    newInput.value = '';
    selectedId = p.id;
  });

  importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = importInput.value.trim();
    if (!url) return importInput.focus();
    importBtn.disabled = true;
    importBtn.textContent = t('libImporting');
    const res = await window.electronAPI.libraryImport(url);
    importBtn.disabled = false;
    importBtn.textContent = t('libImport');
    if (res.success && res.playlist) {
      importInput.value = '';
      selectedId = res.playlist.id;
      toast(t('libImported', { name: res.playlist.name, n: res.playlist.items.length }));
    } else {
      toast(res.error ? `${t('libImportFailed')}: ${res.error}` : t('libImportFailed'));
    }
  });

  function render() {
    if (selectedId && !playlists.some((p) => p.id === selectedId)) selectedId = null;
    if (!selectedId && playlists.length) selectedId = playlists[0].id;

    listHost.innerHTML = '';
    for (const p of playlists) {
      const row = el('button', `lib-row${p.id === selectedId ? ' active' : ''}`);
      row.type = 'button';
      row.append(cover(p, 'lib-row-cover'));
      const text = el('span', 'lib-row-text');
      text.append(el('span', 'lib-row-name', p.name), el('span', 'lib-row-sub', [originLabel(p), t('libItems', { n: p.items.length })].filter(Boolean).join(' · ')));
      row.append(text);
      row.addEventListener('click', () => {
        selectedId = p.id;
        render();
      });
      listHost.append(row);
    }
    renderDetail(playlists.find((p) => p.id === selectedId) ?? null);
  }

  function cover(p: LibraryPlaylist, cls: string): HTMLElement {
    const c = el('span', cls);
    const thumbs = [...new Set(p.items.map((i) => i.thumbnail).filter(Boolean))].slice(0, 4) as string[];
    if (thumbs.length >= 4) c.classList.add('mosaic');
    for (const src of thumbs.length >= 4 ? thumbs : thumbs.slice(0, 1)) {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = src;
      c.append(img);
    }
    if (!thumbs.length) c.innerHTML = ICONS.list; // static
    return c;
  }

  let detailId: string | null | undefined;
  function renderDetail(p: LibraryPlaylist | null) {
    // Switching playlists eases the new one in; syncs and edits of the same one update quietly
    if (detailId !== undefined && (p?.id ?? null) !== detailId) fadeIn(detail);
    detailId = p?.id ?? null;
    detail.innerHTML = '';
    if (!p) {
      const empty = el('div', 'empty-state lib-empty');
      empty.append(el('h4', undefined, t('libEmpty')), el('p', undefined, t('libEmptyDesc')));
      detail.append(empty);
      return;
    }
    const total = p.items.reduce((s, i) => s + (i.duration ?? 0), 0);
    const head = el('div', 'lib-head');
    head.append(cover(p, 'lib-cover'));
    const info = el('div', 'lib-head-info');
    info.append(
      el('span', 'lp-source', originLabel(p) || t('libTitle')),
      el('h3', 'lib-name', p.name),
      el('span', 'lib-meta', [t('libItems', { n: p.items.length }), total ? formatHuman(total) : ''].filter(Boolean).join(' · '))
    );
    const actions = el('div', 'lib-actions');
    const play = iconButton('modal-btn-primary', ICONS.play, t('libPlay'), t('libPlay'));
    const shuffleBtn = iconButton('btn-browse', ICONS.shuffle, t('libShuffle'), t('libShuffle'));
    const dl = iconButton('btn-browse', ICONS.download, t('libDownload'), t('libDownload'));
    play.disabled = shuffleBtn.disabled = p.items.length === 0;
    // Only online items can be downloaded (local files are already on disk)
    dl.disabled = !p.items.some((i) => i.url && !i.filePath);
    play.addEventListener('click', () => playQueue(p.items.map(libraryItemToPlayItem), 0, { shuffle: false }));
    shuffleBtn.addEventListener('click', () =>
      playQueue(p.items.map(libraryItemToPlayItem), Math.floor(Math.random() * p.items.length), { shuffle: true })
    );
    dl.addEventListener('click', () => downloadPlaylist(p));
    actions.append(play, shuffleBtn, dl);
    if (p.origin) {
      const sync = iconButton('btn-browse', ICONS.redo, t('libSync'), t('libSync'));
      sync.addEventListener('click', async () => {
        sync.disabled = true;
        const res = await window.electronAPI.librarySync(p.id);
        sync.disabled = false;
        toast(res.success ? t('libSynced', { n: res.added ?? 0 }) : t('libImportFailed'));
      });
      actions.append(sync);
    }
    const rename = iconButton('history-btn', ICONS.edit, t('libRename'));
    rename.addEventListener('click', () => startRename(info.querySelector('.lib-name') as HTMLElement, p));
    const del = iconButton('history-btn danger', ICONS.trash, t('libDelete'));
    del.addEventListener('click', async () => {
      if (confirm(t('libDeleteConfirm', { name: p.name }))) await window.electronAPI.libraryDelete(p.id);
    });
    actions.append(rename, del);
    info.append(actions);
    head.append(info);
    detail.append(head);

    if (!p.items.length) {
      detail.append(el('p', 'lib-empty-list', t('libEmptyList')));
      return;
    }
    const list = el('div', 'lib-tracks');
    p.items.forEach((item, idx) => list.append(trackRow(p, item, idx)));
    detail.append(list);
  }

  function trackRow(p: LibraryPlaylist, item: LibraryItem, idx: number): HTMLElement {
    const row = el('div', 'lib-track');
    const num = el('span', 'lib-track-index', String(idx + 1));
    const playBtn = iconButton('lib-track-play', ICONS.play, t('libPlay'));
    const thumb = el('span', 'lib-track-thumb');
    if (item.thumbnail) {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = item.thumbnail;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    } else thumb.innerHTML = item.isVideo ? ICONS.video : ICONS.audio; // static
    const text = el('span', 'lib-track-text');
    text.append(el('span', 'lib-track-title', item.title), el('span', 'lib-track-artist', item.artist ?? ''));
    const src = el('span', 'lib-track-source', item.filePath ? '' : SOURCE_LABEL[item.source] ?? '');
    const dur = el('span', 'lib-track-dur', formatDuration(item.duration));
    const remove = iconButton('history-btn danger lib-track-remove', ICONS.close, t('libRemoveItem'));
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      window.electronAPI.libraryRemoveItem(p.id, item.id);
    });
    const start = () => playQueue(p.items.map(libraryItemToPlayItem), idx);
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      start();
    });
    row.addEventListener('dblclick', start);
    row.append(num, playBtn, thumb, text, src, dur, remove);
    return row;
  }

  function startRename(nameEl: HTMLElement, p: LibraryPlaylist) {
    const input = el('input', 'explore-search-input lib-rename') as HTMLInputElement;
    input.value = p.name;
    input.maxLength = 120;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== p.name) await window.electronAPI.libraryRename(p.id, input.value.trim());
      else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function downloadPlaylist(p: LibraryPlaylist) {
    const items = p.items.filter((i) => i.url && !i.filePath);
    if (!items.length) return;
    if (items.length >= 50 && !confirm(t('libDownloadConfirm', { n: items.length }))) return;
    const requests: DownloadTaskRequest[] = items.map((i) => ({
      url: i.url,
      // Music sources become MP3; videos keep the default video quality (1080p)
      format: i.isVideo && !isSpotifyUrl(i.url) && i.source === 'youtube' && !p.origin ? 'mp4' : 'mp3',
      subfolder: p.name,
      meta: { title: i.title, artist: i.artist, thumbnail: i.thumbnail && /^https:/.test(i.thumbnail) ? i.thumbnail : undefined, duration: i.duration },
    }));
    const n = await queueDownloads(requests, { silent: true });
    if (n) {
      toast(t('queuedMany', { n }), { label: t('viewQueue'), onClick: () => switchTab('downloads') });
    }
  }

  // ── Local music: a playlist file exported from Apple Music / iTunes / any player, or a folder ──
  const localStatus = $('lib-local-status');
  const localButtons = [$<HTMLButtonElement>('lib-local-file'), $<HTMLButtonElement>('lib-local-folder')];
  window.electronAPI.onLibraryImportProgress(({ done, total }) => {
    localStatus.hidden = false;
    localStatus.textContent = t('libScanning', { done, total });
  });
  const importLocal = async (kind: 'file' | 'folder') => {
    localButtons.forEach((b) => (b.disabled = true));
    localStatus.hidden = false;
    localStatus.textContent = t('libImporting');
    const res = await window.electronAPI.libraryImportLocal(kind);
    localButtons.forEach((b) => (b.disabled = false));
    localStatus.hidden = true;
    if (res.canceled) return;
    if (res.success && res.playlist) {
      selectedId = res.playlist.id;
      toast(
        res.missing
          ? t('libLocalImportedMissing', { name: res.playlist.name, n: res.playlist.items.length, m: res.missing })
          : t('libImported', { name: res.playlist.name, n: res.playlist.items.length })
      );
    } else toast(res.error ? `${t('libImportFailed')}: ${res.error}` : t('libImportFailed'));
  };
  localButtons[0].addEventListener('click', () => importLocal('file'));
  localButtons[1].addEventListener('click', () => importLocal('folder'));

  refreshListeners.add(render);
  window.electronAPI.onLibraryChanged(() => refresh());
  document.addEventListener('language-changed', render);
  refresh();
}
