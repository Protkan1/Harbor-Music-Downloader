import type { CatalogEntry, CatalogResult } from '../shared/types';
import { $, ICONS, el, formatCount, formatDuration, iconButton, queueDownloads } from './dom';
import { LangKey, getLanguage, t } from './i18n';
import { openPlaylistModal } from './modals';
import { openStream } from './player';
import { playQueue } from './playerbar';
import { addToLibraryMenu } from './library';
import { staggerIn } from './transitions';
import { isPowerSaver } from './power';

interface Category {
  id: string;
  label: LangKey;
  /** A YouTube playlist (charts) or a search query per UI language. */
  playlist?: string;
  query?: { tr: string; en: string };
}

const YEAR = new Date().getFullYear();

// YouTube's own chart playlists work without an account (the old Trending page was retired)
const CATEGORIES: Category[] = [
  { id: 'tr-top', label: 'catTrTop', playlist: 'https://www.youtube.com/playlist?list=PL4fGSI1pDJn5tdVDtIAZArERm_vv4uFCR' },
  { id: 'global-top', label: 'catGlobalTop', playlist: 'https://www.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i' },
  { id: 'new', label: 'catNew', query: { tr: `yeni türkçe şarkılar ${YEAR}`, en: `new music ${YEAR}` } },
  { id: 'rap', label: 'catRap', query: { tr: 'türkçe rap yeni', en: 'turkish rap' } },
  { id: 'lofi', label: 'catLofi', query: { tr: 'lofi hip hop mix', en: 'lofi hip hop mix' } },
  { id: 'podcast', label: 'catPodcast', query: { tr: 'türkçe podcast', en: 'podcast full episode' } },
  { id: 'gaming', label: 'catGaming', query: { tr: 'oyun videoları türkçe', en: 'gaming highlights' } },
];

const PAGE = 30;
const MAX_SEARCH = 100;

const toPlayItem = (e: CatalogEntry) => ({
  id: e.id,
  title: e.title,
  artist: e.artist,
  thumbnail: e.thumbnail,
  duration: e.duration,
  url: e.url,
  isVideo: true,
});

export function setupExplore() {
  const input = $<HTMLInputElement>('explore-search-input');
  const searchBtn = $<HTMLButtonElement>('explore-search-btn');
  const chipsHost = $('explore-chips');
  const heading = $('explore-heading');
  const listBtn = $<HTMLButtonElement>('explore-list-btn');
  const playAllBtn = $<HTMLButtonElement>('explore-playall-btn');
  const status = $('explore-status');
  const grid = $('explore-grid');
  const moreBtn = $<HTMLButtonElement>('explore-more-btn');

  let current: { kind: 'category'; cat: Category } | { kind: 'search'; query: string } = { kind: 'category', cat: CATEGORIES[0] };
  let limit = PAGE;
  let token = 0;
  let loadedOnce = false;
  let lastEntries: CatalogEntry[] = [];

  // ── Chips ──
  const chipButtons = CATEGORIES.map((cat) => {
    const b = el('button', 'explore-chip');
    b.type = 'button';
    b.dataset.i18n = cat.label;
    b.textContent = t(cat.label);
    b.addEventListener('click', () => {
      input.value = '';
      current = { kind: 'category', cat };
      limit = PAGE;
      load();
    });
    chipsHost.append(b);
    return { cat, b };
  });

  const doSearch = () => {
    const q = input.value.trim();
    if (!q) return;
    current = { kind: 'search', query: q };
    limit = PAGE;
    load();
  };
  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  moreBtn.addEventListener('click', () => {
    limit = Math.min(limit + PAGE, MAX_SEARCH);
    load(true);
  });

  playAllBtn.addEventListener('click', () => {
    const items = lastEntries.filter((e) => !e.isLive).map(toPlayItem);
    if (items.length) playQueue(items, 0);
  });

  listBtn.addEventListener('click', () => {
    if (current.kind === 'category' && current.cat.playlist) openPlaylistModal(current.cat.playlist, 'mp3');
  });

  /** @param keepGrid keep the current cards until new ones arrive  @param fresh bypass the cache */
  async function load(keepGrid = false, fresh = false) {
    const my = ++token;
    loadedOnce = true;
    chipButtons.forEach(({ cat, b }) => b.classList.toggle('active', current.kind === 'category' && current.cat === cat));
    listBtn.style.display = current.kind === 'category' && current.cat.playlist ? '' : 'none';
    playAllBtn.style.display = listBtn.style.display;
    moreBtn.style.display = 'none';
    status.style.display = 'none';
    updateHeading();
    if (!keepGrid) showSkeleton();
    moreBtn.disabled = true;

    let res: CatalogResult;
    if (current.kind === 'search') {
      res = await window.electronAPI.search(current.query, limit, fresh);
    } else if (current.cat.playlist) {
      res = await window.electronAPI.getPlaylist(current.cat.playlist, fresh);
    } else {
      const q = current.cat.query![getLanguage()];
      res = await window.electronAPI.search(q, limit, fresh);
    }
    if (my !== token) return;
    moreBtn.disabled = false;

    if (!res.success || !res.data) {
      if (keepGrid && lastEntries.length) return; // background refresh failed: keep what is shown
      grid.innerHTML = '';
      showStatus(t('exploreError'), res.error, true);
      return;
    }
    lastEntries = res.data.entries;
    if (lastEntries.length === 0) {
      grid.innerHTML = '';
      showStatus(t('exploreEmpty'));
      return;
    }
    const ranked = current.kind === 'category' && !!current.cat.playlist;
    renderGrid(lastEntries, ranked, !keepGrid); // a background refresh swaps quietly
    const isSearch = current.kind === 'search' || !current.cat.playlist;
    moreBtn.style.display = isSearch && lastEntries.length >= limit && limit < MAX_SEARCH ? '' : 'none';
  }

  function updateHeading() {
    heading.textContent = current.kind === 'search' ? t('exploreResultsFor', { q: current.query }) : t(current.cat.label);
  }

  function showStatus(message: string, detail?: string, retry = false) {
    status.innerHTML = '';
    status.append(el('p', undefined, message));
    if (detail) status.append(el('p', 'explore-status-detail', detail));
    if (retry) {
      const b = el('button', 'btn-browse', t('exploreRetry'));
      b.type = 'button';
      b.addEventListener('click', () => load());
      status.append(b);
    }
    status.style.display = 'flex';
  }

  function showSkeleton() {
    grid.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const card = el('div', 'explore-card skeleton');
      card.append(el('div', 'explore-thumb'), el('div', 'skeleton-line'), el('div', 'skeleton-line short'));
      grid.append(card);
    }
  }

  function renderGrid(entries: CatalogEntry[], ranked: boolean, animate = false) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    entries.forEach((entry, i) => frag.append(card(entry, ranked ? i + 1 : undefined)));
    grid.append(frag);
    if (animate) staggerIn([...grid.children] as HTMLElement[]);
  }

  function card(entry: CatalogEntry, rank?: number): HTMLElement {
    const c = el('div', 'explore-card');

    const thumb = el('div', 'explore-thumb');
    if (entry.thumbnail) {
      const img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = entry.thumbnail;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    if (rank) thumb.append(el('span', 'explore-rank', `#${rank}`));
    if (entry.isLive) thumb.append(el('span', 'explore-badge live', t('exploreLive')));
    else if (entry.duration) thumb.append(el('span', 'explore-badge', formatDuration(entry.duration)));

    const playOverlay = el('div', 'explore-play-overlay');
    playOverlay.innerHTML = ICONS.play; // static
    thumb.append(playOverlay);
    thumb.title = t('explorePlay');
    thumb.addEventListener('click', () =>
      openStream(entry.url, { title: entry.title, artist: entry.artist, thumbnail: entry.thumbnail, from: thumb })
    );

    const info = el('div', 'explore-info');
    const title = el('div', 'explore-title', entry.title);
    title.title = entry.title;
    const sub = [entry.artist, entry.viewCount !== undefined ? t('exploreViews', { n: formatCount(entry.viewCount) }) : '']
      .filter(Boolean)
      .join(' · ');
    info.append(title, el('div', 'explore-sub', sub));

    const actions = el('div', 'explore-actions');
    // Thumbnail = watch the video; headphones = listen in the player bar (the whole list as queue)
    const play = iconButton('explore-btn play', ICONS.headphones, t('pvListen'));
    play.addEventListener('click', () => {
      const items = lastEntries.filter((e) => !e.isLive).map(toPlayItem);
      // A chart is a list worth playing in order; a search result starts a radio of similar
      // songs instead (otherwise the queue fills with covers of the same song)
      const isChart = current.kind === 'category' && !!current.cat.playlist;
      playQueue(items, Math.max(0, items.findIndex((i) => i.id === entry.id)), { radio: !isChart });
    });
    const add = iconButton('explore-btn play', ICONS.plus, t('addToPlaylist'));
    add.addEventListener('click', () =>
      addToLibraryMenu(add, [{ id: '', title: entry.title, artist: entry.artist, thumbnail: entry.thumbnail, duration: entry.duration, url: entry.url, source: 'youtube', isVideo: true }])
    );
    const meta = { title: entry.title, artist: entry.artist, thumbnail: entry.thumbnail, duration: entry.duration };
    const mp3 = iconButton('explore-btn', ICONS.download, 'MP3', 'MP3');
    const mp4 = iconButton('explore-btn', ICONS.download, 'MP4', 'MP4');
    mp3.addEventListener('click', () => queueDownloads([{ url: entry.url, format: 'mp3', meta }]));
    mp4.addEventListener('click', () => queueDownloads([{ url: entry.url, format: 'mp4', meta }]));
    if (entry.isLive) {
      mp3.disabled = true;
      mp4.disabled = true;
    }
    actions.append(play, add, mp3, mp4);

    c.append(thumb, info, actions);
    return c;
  }

  // Load the default category the first time the tab is opened
  document.addEventListener('tab-changed', (e) => {
    if ((e as CustomEvent).detail !== 'explore') return;
    // Every visit fetches fresh results (charts and searches change); the old cards stay
    // on screen until the new ones are in, so reopening never flashes empty
    if (!loadedOnce) load();
    // Battery saver: keep what was loaded (no network + re-render on every visit)
    else if (!isPowerSaver()) load(grid.children.length > 0, true);
  });
  document.addEventListener('language-changed', () => {
    if (!loadedOnce) return;
    updateHeading();
    // Category searches have per-language queries; charts and user searches stay as they are
    if (current.kind === 'category' && current.cat.query) load();
    else if (lastEntries.length) renderGrid(lastEntries, current.kind === 'category' && !!current.cat.playlist);
  });
}
