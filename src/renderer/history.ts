import type { HistoryEntry } from '../shared/types';
import { $, ICONS, el, formatBytes, formatDate, formatDuration, iconButton, queueDownloads } from './dom';
import { t } from './i18n';
import { openLocal } from './player';
import { playQueue } from './playerbar';
import { addToLibraryMenu } from './library';
import { fadeIn } from './transitions';

type Filter = 'all' | 'mp3' | 'mp4';

export function setupHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  const emptyTitle = $('history-empty-title');
  const emptyDesc = $('history-empty-desc');
  const countChip = $('history-count');
  const searchInput = $<HTMLInputElement>('history-search');
  const clearBtn = $<HTMLButtonElement>('history-clear-btn');
  const filterButtons = [...document.querySelectorAll<HTMLButtonElement>('#history-filter button[data-filter]')];

  let entries: HistoryEntry[] = [];
  let shown: HistoryEntry[] = []; // what the filters currently show (the play queue for songs)
  let filter: Filter = 'all';
  let dirty = true;

  const isVisible = () => $('tab-history').classList.contains('active');

  async function refresh() {
    entries = await window.electronAPI.getHistory();
    dirty = false;
    render();
  }

  function render() {
    countChip.textContent = t('historyCount', { n: entries.length });
    clearBtn.disabled = entries.length === 0;

    const q = searchInput.value.trim().toLocaleLowerCase();
    shown = entries.filter(
      (e) =>
        (filter === 'all' || e.format === filter) &&
        (!q || `${e.title} ${e.artist ?? ''}`.toLocaleLowerCase().includes(q))
    );

    list.innerHTML = '';
    if (shown.length === 0) {
      empty.style.display = 'flex';
      const noData = entries.length === 0;
      emptyTitle.textContent = noData ? t('historyEmpty') : t('historyNoMatch');
      emptyDesc.textContent = noData ? t('historyEmptyDesc') : '';
      return;
    }
    empty.style.display = 'none';
    const frag = document.createDocumentFragment();
    for (const e of shown) frag.append(row(e));
    list.append(frag);
  }

  function row(e: HistoryEntry): HTMLElement {
    const r = el('div', 'history-row');
    if (!e.exists) r.classList.add('missing');

    const thumb = el('div', `history-thumb ${e.format}`);
    thumb.innerHTML = e.format === 'mp4' ? ICONS.video : ICONS.audio; // static fallback icon
    if (e.thumbnail) {
      const img = el('img');
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = e.thumbnail;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }

    const info = el('div', 'history-info');
    const title = el('div', 'history-title', e.title);
    title.title = e.filePath;
    const metaParts = [e.artist, e.format.toUpperCase(), formatDuration(e.duration), formatBytes(e.size), formatDate(e.completedAt)];
    const meta = el('div', 'history-meta', metaParts.filter(Boolean).join(' · '));
    info.append(title, meta);
    if (!e.exists) info.append(el('span', 'history-missing', t('historyMissing')));

    const actions = el('div', 'history-actions');
    const play = iconButton('history-btn', ICONS.play, t('historyPlay'));
    play.disabled = !e.exists || !e.fileUrl;
    play.addEventListener('click', () => {
      if (!e.fileUrl) return;
      if (e.format !== 'mp4') {
        // Music plays in the player bar, with the other songs on screen as the queue
        const songs = shown.filter((x) => x.format !== 'mp4' && x.exists && x.fileUrl);
        playQueue(
          songs.map((x) => ({ id: x.id, title: x.title, artist: x.artist, thumbnail: x.thumbnail, duration: x.duration, fileUrl: x.fileUrl })),
          Math.max(0, songs.indexOf(e))
        );
        return;
      }
      openLocal({
        fileUrl: e.fileUrl,
        title: e.title,
        artist: e.artist,
        thumbnail: e.thumbnail,
        isVideo: e.format === 'mp4',
        durationStr: formatDuration(e.duration),
      });
    });
    const reveal = iconButton('history-btn', ICONS.folder, t('historyReveal'));
    reveal.addEventListener('click', () => window.electronAPI.revealHistoryFile(e.id));
    const redo = iconButton('history-btn', ICONS.redo, t('historyRedownload'));
    redo.addEventListener('click', () =>
      queueDownloads([
        { url: e.sourceUrl, format: e.format, meta: { title: e.title, artist: e.artist, thumbnail: e.thumbnail, duration: e.duration } },
      ])
    );
    const remove = iconButton('history-btn danger', ICONS.close, t('historyRemove'));
    remove.addEventListener('click', async () => {
      r.classList.add('removing');
      await window.electronAPI.removeHistory([e.id]);
    });
    const add = iconButton('history-btn', ICONS.plus, t('addToPlaylist'));
    add.addEventListener('click', () =>
      addToLibraryMenu(add, [
        { id: '', title: e.title, artist: e.artist, thumbnail: e.thumbnail, duration: e.duration, url: e.sourceUrl, filePath: e.filePath, source: 'local', isVideo: e.format === 'mp4' },
      ])
    );
    actions.append(play, add, reveal, redo, remove);

    // Double click plays, like a media library
    r.addEventListener('dblclick', (ev) => {
      if (!(ev.target as HTMLElement).closest('button') && !play.disabled) play.click();
    });

    r.append(thumb, info, actions);
    return r;
  }

  filterButtons.forEach((b) =>
    b.addEventListener('click', () => {
      filter = b.dataset.filter as Filter;
      filterButtons.forEach((x) => x.classList.toggle('active', x === b));
      render();
      fadeIn(list);
    })
  );
  searchInput.addEventListener('input', render);
  clearBtn.addEventListener('click', async () => {
    if (confirm(t('historyClearConfirm'))) await window.electronAPI.clearHistory();
  });

  // Main notifies on every change; re-read now if visible, otherwise on next open
  let pending: ReturnType<typeof setTimeout> | undefined;
  window.electronAPI.onHistoryChanged(() => {
    dirty = true;
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (isVisible()) refresh();
    }, 150);
  });
  document.addEventListener('tab-changed', (ev) => {
    if ((ev as CustomEvent).detail === 'history' && dirty) refresh();
  });
  document.addEventListener('language-changed', () => {
    if (!dirty) render();
  });
}
