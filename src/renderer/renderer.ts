import type {
  AppSettings,
  DependencyStatus,
  DownloadFormat,
  DownloadProgressPayload,
  DownloadStatus,
} from '../shared/types';
import { LangKey, applyTranslations, setLanguage, t } from './i18n';
import { ElasticSlider } from './components/ElasticSlider';
import { extractUrls, isPlaylistUrl, isSpotifyUrl } from '../shared/urls';
import { $, el, switchTab } from './dom';
import { openStream, setupPlayer } from './player';
import { openBatchModal, openPlaylistModal, setupBatchModal, setupPlaylistModal } from './modals';
import { setupExplore } from './explore';
import { setupHistory } from './history';
import { setupUpdates } from './updates';
import { setupMotion } from './motion';
import { setupPreview, requestFromOption } from './preview';
import { setupPlayerBar } from './playerbar';
import { setupLibrary } from './library';
import { runFirstSetup } from './setup';
import { withViewTransition } from './transitions';

// Application State
let currentSettings: AppSettings = {
  theme: 'dark',
  colorTheme: 'claude',
  language: 'tr',
  glassEnabled: true,
  glassBlur: 24,
  glassOpacity: 75,
  mp3DownloadPath: '',
  mp4DownloadPath: '',
  maxConcurrentDownloads: 3,
  autoUpdateYtDlp: true,
  lastYtDlpCheck: 0,
  defaultVideoHeight: 1080,
};

let selectedFormat: DownloadFormat = 'mp3';

interface TaskView {
  card: HTMLElement;
  last: DownloadProgressPayload;
  els: {
    title: HTMLElement;
    icon: HTMLElement;
    badge: HTMLElement;
    action: HTMLButtonElement;
    del: HTMLButtonElement;
    fill: HTMLElement;
    speed: HTMLElement;
    eta: HTMLElement;
    percent: HTMLElement;
    note: HTMLElement;
  };
}
const tasks = new Map<string, TaskView>();
let lastDeps: DependencyStatus | null = null;


// DOM Elements
const bodyEl = document.body;
const urlInput = $<HTMLInputElement>('url-input');
const pasteBtn = $<HTMLButtonElement>('paste-btn');
const startDownloadBtn = $<HTMLButtonElement>('start-download-btn');
const formatMp3Btn = $('format-mp3');
const formatMp4Btn = $('format-mp4');
const downloadsList = $('downloads-list');
const emptyState = $('empty-state');

// Tabs
const tabButtons = document.querySelectorAll('.nav-tab-btn');

// Settings Elements
const glassToggle = $<HTMLInputElement>('setting-glass-toggle');
const themeSelect = $<HTMLSelectElement>('setting-theme');
const langSelect = $<HTMLSelectElement>('setting-language');
const concurrencySelect = $<HTMLSelectElement>('setting-concurrency');
const qualitySelect = $<HTMLSelectElement>('setting-default-quality');
const mp3PathInput = $<HTMLInputElement>('mp3-path-input');
const mp4PathInput = $<HTMLInputElement>('mp4-path-input');
const browseMp3Btn = $<HTMLButtonElement>('browse-mp3-btn');
const browseMp4Btn = $<HTMLButtonElement>('browse-mp4-btn');

const blurValueDisplay = $('glass-blur-value');
const opacityValueDisplay = $('glass-opacity-value');

// Sliders container
const blurSliderContainer = $('elastic-blur-slider');
const opacitySliderContainer = $('elastic-opacity-slider');
const playgroundSliderContainer = $('elastic-playground-slider');


// Initialize
async function initApp() {
  setupNavigation();
  setupFormatSelector();
  setupDownloadActions();
  setupDeleteModal();
  setupPlayerBar({ watchVideo: (item) => item.url && openStream(item.url) });
  setupPlayer();
  setupLibrary();
  setupBatchModal();
  setupPlaylistModal();
  setupExplore();
  setupHistory();
  setupMotion();

  // Load Initial Settings
  currentSettings = await window.electronAPI.getSettings();
  applySettings(currentSettings);
  setLanguage(currentSettings.language);
  applyTranslations();
  updateTaskCounters();

  initElasticSliders();
  setupSettingsEvents();

  window.electronAPI.onDownloadProgress((payload) => updateTaskCard(payload));

  // First launch of a version: verify the bundled tools (blocking dialog) before anything else
  await runFirstSetup();
  checkDependencies();
  setupUpdates(currentSettings);

  $<HTMLButtonElement>('stream-play-btn').addEventListener('click', () => {
    const raw = urlInput.value.trim();
    if (!raw) {
      flashInput();
      return;
    }
    openStream(extractUrls(raw)[0] ?? raw);
  });
}

function setupNavigation() {
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      if (tabName) switchTab(tabName);
    });
  });
}

function selectFormat(format: DownloadFormat) {
  selectedFormat = format;
  formatMp3Btn.classList.toggle('selected', format === 'mp3');
  formatMp4Btn.classList.toggle('selected', format === 'mp4');
}

// The link preview (created in setupDownloadActions)
let preview: ReturnType<typeof setupPreview> | null = null;

function setupFormatSelector() {
  // Clicking MP3 / MP4 also moves the preview's selection to that kind's default
  formatMp3Btn.addEventListener('click', () => {
    selectFormat('mp3');
    preview?.selectKind('audio');
  });
  formatMp4Btn.addEventListener('click', () => {
    selectFormat('mp4');
    preview?.selectKind('video');
  });
}

function setupDownloadActions() {
  preview = setupPreview({
    onKindChange: (format) => selectFormat(format),
    onDownloaded: () => {
      urlInput.value = '';
    },
    currentFormat: () => selectedFormat,
  });

  // Pasting several links (or a playlist) opens the matching dialog instead of the single-link flow
  const handlePastedText = (text: string): boolean => {
    const urls = extractUrls(text);
    if (urls.length > 1) {
      openBatchModal(text, selectedFormat);
      return true;
    }
    return false;
  };

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (handlePastedText(text)) return;
      urlInput.value = (extractUrls(text)[0] ?? text).trim();
      if (isSpotifyUrl(urlInput.value)) selectFormat('mp3');
      preview?.update(urlInput.value);
    } catch (err) {
      console.warn('Clipboard read failed', err);
    }
  });

  urlInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (handlePastedText(text)) e.preventDefault();
  });

  $<HTMLButtonElement>('batch-btn').addEventListener('click', () => {
    openBatchModal(urlInput.value, selectedFormat);
    urlInput.value = '';
  });

  // Spotify is audio only: switch to MP3 as soon as a Spotify link is entered.
  // Every change also feeds the link preview (no Enter needed).
  urlInput.addEventListener('input', () => {
    if (isSpotifyUrl(urlInput.value.trim())) selectFormat('mp3');
    preview?.update(urlInput.value);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startDownloadBtn.click();
  });

  startDownloadBtn.addEventListener('click', async () => {
    const raw = urlInput.value.trim();
    if (!raw) {
      flashInput();
      return;
    }
    const urls = extractUrls(raw);
    if (urls.length > 1) {
      openBatchModal(raw, selectedFormat);
      urlInput.value = '';
      return;
    }
    const url = urls[0] ?? raw;
    if (isSpotifyUrl(url)) selectFormat('mp3');

    if (isPlaylistUrl(url)) {
      openPlaylistModal(url, selectedFormat);
      urlInput.value = '';
      preview?.hide();
      return;
    }

    // The quality picked in the preview wins; otherwise main applies the default (1080p cap)
    const picked = preview?.selection(url);
    if (picked) {
      if (await requestFromOption(picked.probe, picked.option)) {
        urlInput.value = '';
        preview?.hide();
      }
      return;
    }
    const res = await window.electronAPI.startDownload({ url, format: selectedFormat });
    if (res.success) {
      urlInput.value = '';
      preview?.hide();
    }
  });
}

function flashInput() {
  urlInput.focus();
  urlInput.style.borderColor = 'var(--accent-cyan)';
  setTimeout(() => {
    urlInput.style.borderColor = '';
  }, 1000);
}

function initElasticSliders() {
  // 1. Blur Slider (0px to 45px)
  new ElasticSlider(blurSliderContainer, {
    min: 0,
    max: 45,
    initial: currentSettings.glassBlur,
    onChange: (val) => {
      blurValueDisplay.textContent = `${val}px`;
      document.documentElement.style.setProperty('--glass-blur', `${val}px`);
      saveSettingDebounced({ glassBlur: val });
    },
  });

  // 2. Opacity Slider (15% to 95%)
  new ElasticSlider(opacitySliderContainer, {
    min: 15,
    max: 95,
    initial: currentSettings.glassOpacity,
    onChange: (val) => {
      opacityValueDisplay.textContent = `${val}%`;
      document.documentElement.style.setProperty('--glass-opacity', `${val / 100}`);
      saveSettingDebounced({ glassOpacity: val });
    },
  });

  // 3. Elastic Spring Playground
  new ElasticSlider(playgroundSliderContainer, {
    min: 0,
    max: 100,
    initial: 50,
  });
}

// Patches are merged so a quick blur change followed by an opacity change saves both
let pendingPatch: Partial<AppSettings> = {};
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
function saveSettingDebounced(patch: Partial<AppSettings>) {
  pendingPatch = { ...pendingPatch, ...patch };
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    window.electronAPI.saveSettings(pendingPatch);
    pendingPatch = {};
  }, 300);
}

function applySettings(settings: AppSettings) {
  bodyEl.setAttribute('data-theme', settings.theme);
  themeSelect.value = settings.theme;

  applyColorTheme(settings.colorTheme ?? 'claude');

  langSelect.value = settings.language;
  concurrencySelect.value = String(settings.maxConcurrentDownloads ?? 3);
  qualitySelect.value = String(settings.defaultVideoHeight ?? 1080);

  glassToggle.checked = settings.glassEnabled;
  bodyEl.setAttribute('data-glass', settings.glassEnabled ? 'true' : 'false');

  document.documentElement.style.setProperty('--glass-blur', `${settings.glassBlur}px`);
  document.documentElement.style.setProperty('--glass-opacity', `${settings.glassOpacity / 100}`);
  blurValueDisplay.textContent = `${settings.glassBlur}px`;
  opacityValueDisplay.textContent = `${settings.glassOpacity}%`;

  mp3PathInput.value = settings.mp3DownloadPath;
  mp4PathInput.value = settings.mp4DownloadPath;
}

function applyColorTheme(theme: AppSettings['colorTheme']) {
  bodyEl.setAttribute('data-color-theme', theme);

  document.querySelectorAll('.theme-card').forEach((card) => card.classList.remove('active'));
  const activeCard = document.getElementById(`theme-card-${theme}`);
  if (activeCard) activeCard.classList.add('active');

  const labelEl = document.getElementById('active-theme-label');
  if (labelEl) {
    if (theme === 'aura') labelEl.textContent = 'Midnight';
    else if (theme === 'ember') labelEl.textContent = 'Ember';
    else if (theme === 'true-liquid') labelEl.textContent = 'Glacier';
    else if (theme === 'claude') labelEl.textContent = 'Clay';
  }
  document.dispatchEvent(new CustomEvent('theme-changed', { detail: theme }));
}

function setupSettingsEvents() {
  glassToggle.addEventListener('change', () => {
    const isEnabled = glassToggle.checked;
    bodyEl.setAttribute('data-glass', isEnabled ? 'true' : 'false');
    window.electronAPI.saveSettings({ glassEnabled: isEnabled });
  });

  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value as 'dark' | 'light';
    bodyEl.setAttribute('data-theme', theme);
    window.electronAPI.saveSettings({ theme });
  });

  langSelect.addEventListener('change', () => {
    const lang = langSelect.value as 'tr' | 'en';
    currentSettings.language = lang;
    setLanguage(lang);
    applyTranslations();
    // Re-render dynamic texts
    tasks.forEach((view) => renderTask(view));
    updateTaskCounters();
    if (lastDeps) renderDependencies(lastDeps);
    document.dispatchEvent(new CustomEvent('language-changed'));
    window.electronAPI.saveSettings({ language: lang });
  });

  qualitySelect.addEventListener('change', () => {
    const h = parseInt(qualitySelect.value, 10);
    currentSettings.defaultVideoHeight = isFinite(h) ? h : 1080;
    window.electronAPI.saveSettings({ defaultVideoHeight: currentSettings.defaultVideoHeight });
  });

  concurrencySelect.addEventListener('change', () => {
    const n = parseInt(concurrencySelect.value, 10) || 3;
    currentSettings.maxConcurrentDownloads = n;
    window.electronAPI.saveSettings({ maxConcurrentDownloads: n });
  });

  browseMp3Btn.addEventListener('click', async () => {
    const folder = await window.electronAPI.selectFolder(mp3PathInput.value);
    if (folder) {
      mp3PathInput.value = folder;
      window.electronAPI.saveSettings({ mp3DownloadPath: folder });
    }
  });

  browseMp4Btn.addEventListener('click', async () => {
    const folder = await window.electronAPI.selectFolder(mp4PathInput.value);
    if (folder) {
      mp4PathInput.value = folder;
      window.electronAPI.saveSettings({ mp4DownloadPath: folder });
    }
  });

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.addEventListener('click', () => {
      const colorTheme = card.getAttribute('data-color-theme') as AppSettings['colorTheme'] | null;
      if (!colorTheme) return;
      if (currentSettings.colorTheme === colorTheme) return;
      currentSettings.colorTheme = colorTheme;
      withViewTransition(() => applyColorTheme(colorTheme), 'theme'); // a calm crossfade
      window.electronAPI.saveSettings({ colorTheme });
    });
  });
}

// ─────────────────────────────── Dependencies ───────────────────────────────

async function checkDependencies() {
  lastDeps = await window.electronAPI.checkDependencies();
  renderDependencies(lastDeps);
}

function renderDependencies(deps: DependencyStatus) {
  updateDepBadge('badge-spotdl', deps.spotdl, 'depMissingHint');
  updateDepBadge('badge-ytdlp', deps.ytdlp, 'depMissingHint');
  updateDepBadge('badge-ffmpeg', deps.ffmpeg, 'depMissingHint');
  updateDepBadge('badge-tagger', deps.tagger, 'depTaggerHint');
}

function updateDepBadge(elementId: string, available: boolean, missingHint: LangKey) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = available ? t('depOk') : t('depMissing');
  el.className = `dep-pill ${available ? 'online' : 'offline'}`;
  el.title = available ? '' : t(missingHint);
}

// ─────────────────────────────── Delete modal ───────────────────────────────

let activeDeleteTaskId: string | null = null;

function setupDeleteModal() {
  const deleteModal = $('delete-modal');
  const modalDeleteFileBtn = $<HTMLButtonElement>('modal-delete-file-btn');
  const modalDeleteListBtn = $<HTMLButtonElement>('modal-delete-list-btn');
  const modalCancelBtn = $<HTMLButtonElement>('modal-cancel-btn');

  const close = () => {
    activeDeleteTaskId = null;
    deleteModal.classList.remove('active');
  };

  modalCancelBtn.addEventListener('click', close);
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deleteModal.classList.contains('active')) close();
  });

  modalDeleteListBtn.addEventListener('click', () => {
    if (activeDeleteTaskId) removeTaskFromList(activeDeleteTaskId);
    close();
  });

  modalDeleteFileBtn.addEventListener('click', async () => {
    const taskId = activeDeleteTaskId;
    close();
    if (!taskId) return;
    const res = await window.electronAPI.deleteDownloadedFile(taskId);
    if (!res.success) {
      const key: LangKey =
        res.errorCode === 'noPath' ? 'errDeleteNoPath' : res.errorCode === 'notOnDisk' ? 'errDeleteNotOnDisk' : 'errDeleteFailed';
      alert(res.error ? `${t(key)}\n${res.error}` : t(key));
    }
    removeTaskFromList(taskId);
  });
}

function openDeleteModal(taskId: string) {
  activeDeleteTaskId = taskId;
  $('delete-modal').classList.add('active');
}

function removeTaskFromList(taskId: string) {
  const view = tasks.get(taskId);
  if (!view) return;
  const card = view.card;
  card.classList.add('task-removing'); // exit motion lives in CSS, per theme
  tasks.delete(taskId);
  updateTaskCounters();
  const done = () => {
    card.remove();
    if (tasks.size === 0) emptyState.style.display = '';
  };
  card.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400); // fallback when no transition runs (reduced motion)
}

// ─────────────────────────────── Task cards ───────────────────────────────

const ICON_VIDEO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
const ICON_AUDIO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
const ICON_TRASH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

const STATUS_KEYS: Record<DownloadStatus, LangKey> = {
  queued: 'statusQueued',
  downloading: 'statusDownloading',
  converting: 'statusConverting',
  completed: 'statusCompleted',
  error: 'statusError',
  cancelled: 'statusCancelled',
};

const isFinished = (s: DownloadStatus) => s === 'completed' || s === 'error' || s === 'cancelled';

/** Builds a task card with DOM APIs only — titles come from the internet and are never parsed as HTML. */
function createTaskView(payload: DownloadProgressPayload): TaskView {
  const card = el('div', 'task-item');

  const top = el('div', 'task-top');
  const titleGroup = el('div', 'task-title-group');
  const icon = el('div', 'task-icon-pill');
  const title = el('span', 'task-title');
  titleGroup.append(icon, title);

  const badges = el('div', 'task-badges');
  const badge = el('span', 'badge');
  const actions = el('div', 'task-actions-group');
  const action = el('button', 'btn-task-action');
  const del = el('button', 'btn-delete');
  del.innerHTML = ICON_TRASH; // static markup
  del.style.display = 'none';
  actions.append(action, del);
  badges.append(badge, actions);
  top.append(titleGroup, badges);

  const bar = el('div', 'task-progress-bar-container');
  const fill = el('div', 'task-progress-fill');
  fill.style.width = '0%';
  bar.append(fill);

  const bottom = el('div', 'task-bottom');
  const speed = el('span');
  const eta = el('span');
  const percent = el('span');
  percent.style.fontWeight = '700';
  percent.style.color = 'var(--accent-cyan)';
  bottom.append(speed, eta, percent);

  const note = el('div', 'task-note');
  note.style.display = 'none';

  card.append(top, bar, bottom, note);

  const view: TaskView = {
    card,
    last: payload,
    els: { title, icon, badge, action, del, fill, speed, eta, percent, note },
  };

  action.addEventListener('click', () => {
    if (view.last.status === 'completed') window.electronAPI.openFolder(payload.taskId);
    else if (!isFinished(view.last.status)) window.electronAPI.cancelDownload(payload.taskId);
  });
  del.addEventListener('click', () => openDeleteModal(payload.taskId));

  return view;
}

function updateTaskCard(payload: DownloadProgressPayload) {
  let view = tasks.get(payload.taskId);
  if (!view) {
    // Task was removed from the list already; ignore late events
    if (isFinished(payload.status) && payload.status !== 'completed') return;
    emptyState.style.display = 'none';
    view = createTaskView(payload);
    downloadsList.prepend(view.card);
    tasks.set(payload.taskId, view);
  } else {
    // Keep fields that this event doesn't carry (e.g. title, speed)
    view.last = {
      ...view.last,
      ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)),
    } as DownloadProgressPayload;
    // Speed/ETA only make sense while downloading
    if (payload.status !== 'downloading') {
      view.last.speed = undefined;
      view.last.eta = undefined;
    }
  }
  renderTask(view);
  updateTaskCounters();
}

function errorText(p: DownloadProgressPayload): string {
  switch (p.errorCode) {
    case 'spawnFailed':
      return t('errSpawnFailed');
    case 'noOutput':
      return t('errNoOutput');
    case 'folderFailed':
      return t('errFolderFailed');
    default:
      return t('errExitCode');
  }
}

function renderTask(view: TaskView) {
  const p = view.last;
  const e = view.els;
  const finished = isFinished(p.status);

  e.icon.innerHTML = p.format === 'mp4' ? ICON_VIDEO : ICON_AUDIO; // static markup

  let title = p.title || '...';
  if (p.status === 'completed' && (p.fileCount ?? 0) > 1) {
    title = `${title}  (${t('filesCount', { n: p.fileCount! })})`;
  }
  e.title.textContent = title;
  e.title.title = p.filePath || p.title || '';

  e.badge.className = `badge ${p.status}`;
  e.badge.textContent = t(STATUS_KEYS[p.status]);

  const pct = p.status === 'completed' ? 100 : Math.min(100, Math.max(0, p.percent || 0));
  e.fill.style.width = `${pct}%`;
  e.percent.textContent = `${Math.round(pct)}%`;

  // Left info: speed / state text
  let info = '';
  if (p.status === 'queued') info = t('waitingInQueue');
  else if (p.status === 'downloading') info = p.speed || t('preparing');
  else if (p.status === 'converting') info = t('processing');
  else if (p.status === 'completed') info = t('statusCompleted');
  else if (p.status === 'cancelled') info = t('statusCancelled');
  else if (p.status === 'error') info = errorText(p);
  e.speed.textContent = info;

  // Middle: ETA or playlist progress
  let mid = '';
  if (!finished) {
    if (p.itemsTotal && p.itemsTotal > 1) mid = t('itemsProgress', { done: p.itemsDone ?? 0, total: p.itemsTotal });
    else if (p.status === 'downloading' && p.eta) mid = p.eta;
  }
  e.eta.textContent = mid;

  // Error details (raw tool message) or partial-failure warning
  if (p.error && (p.status === 'error' || p.status === 'completed')) {
    e.note.style.display = '';
    e.note.className = p.status === 'completed' ? 'task-note warning' : 'task-note';
    e.note.textContent = p.status === 'completed' ? `${t('partialWarning')}: ${p.error}` : p.error;
    e.note.title = p.error;
  } else {
    e.note.style.display = 'none';
  }

  // Action buttons
  if (p.status === 'completed') {
    e.action.style.display = '';
    e.action.textContent = t('openFolderBtn');
    e.action.className = 'btn-task-action completed';
  } else if (finished) {
    e.action.style.display = 'none';
  } else {
    e.action.style.display = '';
    e.action.textContent = t('cancelBtn');
    e.action.className = 'btn-task-action';
  }
  e.del.style.display = finished ? 'flex' : 'none';
  e.del.title = t('deleteTitle');
}

function updateTaskCounters() {
  const active = [...tasks.values()].filter((v) => !isFinished(v.last.status)).length;
  const navBadge = document.getElementById('nav-task-badge');
  const hudCount = document.getElementById('hud-queue-count');
  if (navBadge) navBadge.textContent = String(tasks.size);
  if (hudCount) hudCount.textContent = t('hudActiveCount', { n: active });
}

// Start App
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
