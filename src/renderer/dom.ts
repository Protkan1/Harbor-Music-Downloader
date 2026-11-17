import type { DownloadTaskRequest } from '../shared/types';
import { getLanguage, t } from './i18n';
import { tabDirection, withViewTransition } from './transitions';

// Input modality: lets themes hide focus rings for mouse users without hurting keyboard users
document.addEventListener('pointerdown', () => document.body.classList.add('pointer-input'), true);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Tab' || e.key.startsWith('Arrow')) document.body.classList.remove('pointer-input');
  },
  true
);

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Static, trusted SVG icons (never interpolate user data into these). */
export const ICONS = {
  globe: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  cc: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 10.5a2.5 2.5 0 1 0 0 3"/><path d="M17 10.5a2.5 2.5 0 1 0 0 3"/></svg>',
  pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v12L9 12z"/><rect x="5" y="6" width="2.5" height="12" rx="1"/></svg>',
  next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6v12l10-6z"/><rect x="16.5" y="6" width="2.5" height="12" rx="1"/></svg>',
  shuffle: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
  repeat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  repeatOne: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10h1v5" stroke-width="1.8"/></svg>',
  list: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  volume: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  mute: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  headphones: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>',
  pip: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>',
  fullscreen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  edit: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  importIcon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',

  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  audio:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
  video:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>',
  folder:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  redo:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>',
  close:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  download:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
};

export function iconButton(className: string, icon: string, title: string, label?: string): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = icon; // static markup
  if (label) b.append(el('span', undefined, label));
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 19800 → "5 sa 30 dk" / "5 h 30 min" — for totals, not track lengths. */
export function formatHuman(seconds: number): string {
  const en = getLanguage() === 'en';
  const m = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return en ? `${m} min` : `${m} dk`;
  if (rest === 0) return en ? `${h} h` : `${h} sa`;
  return en ? `${h} h ${rest} min` : `${h} sa ${rest} dk`;
}

export function formatCount(n?: number): string {
  if (n === undefined || !isFinite(n)) return '';
  return new Intl.NumberFormat(getLanguage() === 'en' ? 'en' : 'tr', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  const locale = getLanguage() === 'en' ? 'en-GB' : 'tr-TR';
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `${t('today')} ${time}`;
  if (diffDays === 1) return `${t('yesterday')} ${time}`;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: diffDays > 300 ? 'numeric' : undefined });
}

/** Switches the main view to a tab ("downloads" | "explore" | "history" | "settings"). */
let currentTab = 'downloads';
/** Each tab keeps its own scroll position (back from a video lands where you were in the grid) */
const tabScroll = new Map<string, number>();

/**
 * @param opts.morphFrom an element (a thumbnail) that morphs into the watch page's player
 */
export function switchTab(name: string, opts: { morphFrom?: HTMLElement | null } = {}) {
  const from = currentTab;
  currentTab = name;
  const mv = document.querySelector<HTMLElement>('.main-view');
  if (mv) tabScroll.set(from, mv.scrollTop);
  withViewTransition(
    () => {
      document.querySelectorAll('.nav-tab-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === name));
      document.querySelectorAll('.tab-content').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
      if (mv) mv.scrollTop = name === 'watch' ? 0 : tabScroll.get(name) ?? 0;
      document.dispatchEvent(new CustomEvent('tab-changed', { detail: name }));
    },
    from === name ? 'fade' : tabDirection(from, name),
    opts.morphFrom
  );
}

// ─────────────────────────────── Toasts ───────────────────────────────

export function toast(message: string, action?: { label: string; onClick: () => void }) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', 'toast-host');
    host.id = 'toast-host';
    document.body.append(host);
  }
  const box = el('div', 'aura-toast');
  box.append(el('span', 'aura-toast-text', message));
  if (action) {
    const btn = el('button', 'aura-toast-action', action.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    box.append(btn);
  }
  host.append(box);
  requestAnimationFrame(() => box.classList.add('visible'));
  let timer = setTimeout(dismiss, 4000);
  box.addEventListener('mouseenter', () => clearTimeout(timer));
  box.addEventListener('mouseleave', () => (timer = setTimeout(dismiss, 2000)));
  function dismiss() {
    clearTimeout(timer);
    box.classList.remove('visible');
    setTimeout(() => box.remove(), 300);
  }
}

// ─────────────────────────────── Downloads ───────────────────────────────

/** Queues downloads and shows a toast with a shortcut to the queue. Returns how many were accepted. */
export async function queueDownloads(requests: DownloadTaskRequest[], options: { silent?: boolean } = {}): Promise<number> {
  let ok = 0;
  for (const req of requests) {
    try {
      const res = await window.electronAPI.startDownload(req);
      if (res.success) ok++;
    } catch (err) {
      console.error('startDownload failed', err);
    }
  }
  if (ok > 0 && !options.silent) {
    toast(ok === 1 ? t('queuedOne') : t('queuedMany', { n: ok }), { label: t('viewQueue'), onClick: () => switchTab('downloads') });
  }
  return ok;
}

/** Generic overlay modal open/close with Escape + backdrop click handling. */
export function setupModal(overlay: HTMLElement, onClose?: () => void) {
  const close = () => {
    overlay.classList.remove('active');
    onClose?.();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) close();
  });
  return {
    open: () => overlay.classList.add('active'),
    close,
  };
}
