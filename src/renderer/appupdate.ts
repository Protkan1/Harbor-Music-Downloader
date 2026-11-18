/**
 * Settings → App panel and the "Updating Harbor" dialog.
 *  - Automatic updates (default on): AppUpdateService checks GitHub Releases on start. While a
 *    new version downloads, a dialog with a progress bar covers the app; then it installs and
 *    Harbor restarts by itself. If downloads are still running, it waits for them quietly.
 *  - Battery saver: off / on battery / always (PowerService decides when it is active).
 */
import type { AppSettings, AppUpdateStatus, PowerSaverMode, PowerState } from '../shared/types';
import { $, el } from './dom';
import { t } from './i18n';
import { powerState } from './power';

let dialog: HTMLElement | null = null;
let dialogText: HTMLElement;
let dialogBar: HTMLElement;
let dialogActions: HTMLElement;

function ensureDialog() {
  if (dialog) return;
  dialog = el('div', 'aura-modal-overlay setup-overlay active');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'appupdate-title');
  const card = el('div', 'aura-modal-card setup-card');
  const badge = el('div', 'setup-badge');
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>';
  const title = el('h3', 'modal-title', t('appUpdateTitle'));
  title.id = 'appupdate-title';
  const desc = el('p', 'modal-desc', t('appUpdateDesc'));
  const track = el('div', 'appupdate-track');
  dialogBar = el('div', 'appupdate-bar');
  track.append(dialogBar);
  dialogText = el('p', 'appupdate-text');
  dialogText.setAttribute('role', 'status');
  dialogActions = el('div', 'setup-actions');
  dialogActions.hidden = true;
  const close = el('button', 'modal-btn-ghost', t('appUpdateClose')) as HTMLButtonElement;
  close.type = 'button';
  close.addEventListener('click', hideDialog);
  dialogActions.append(close);
  card.append(badge, title, desc, track, dialogText, dialogActions);
  dialog.append(card);
  document.getElementById('app-container')?.setAttribute('inert', '');
  document.body.append(dialog);
}

function hideDialog() {
  if (!dialog) return;
  document.getElementById('app-container')?.removeAttribute('inert');
  dialog.remove();
  dialog = null;
}

function statusText(s: AppUpdateStatus): string {
  switch (s.state) {
    case 'checking':
      return t('appUpdateChecking');
    case 'none':
      return t('appUpdateNone');
    case 'downloading':
      return t('appUpdateDownloading', { v: s.version ?? '', p: s.percent ?? 0 });
    case 'downloaded':
      return s.waitingForDownloads ? t('appUpdateWaiting', { v: s.version ?? '' }) : t('appUpdateInstalling');
    case 'installing':
      return t('appUpdateInstalling');
    case 'error':
      return t('appUpdateError', { e: s.error ?? '' });
    case 'disabled':
      return t('appUpdateDisabled');
    default:
      return '';
  }
}

function render(s: AppUpdateStatus) {
  $('app-version').textContent = s.current;
  const line = $('app-update-state');
  line.textContent = statusText(s);
  line.dataset.state = s.state;
  ($('app-update-check-btn') as HTMLButtonElement).disabled = ['checking', 'downloading', 'downloaded', 'installing'].includes(s.state);

  // The dialog: while downloading and installing (not while waiting for the user's downloads)
  const busy = s.state === 'downloading' || s.state === 'installing' || (s.state === 'downloaded' && !s.waitingForDownloads);
  if (busy) {
    ensureDialog();
    dialogBar.style.width = `${s.state === 'downloading' ? s.percent ?? 0 : 100}%`;
    dialogText.textContent = statusText(s);
    dialogActions.hidden = true;
  } else if (dialog && s.state === 'error') {
    dialogText.textContent = statusText(s);
    dialogActions.hidden = false; // close and keep using this version
  } else if (dialog) {
    hideDialog();
  }
}

function renderPower(s: PowerState) {
  const line = $('power-saver-state');
  line.textContent = s.active ? (s.mode === 'battery' ? t('powerSaverActiveBattery') : t('powerSaverActive')) : t('powerSaverInactive');
  line.dataset.state = s.active ? 'on' : 'off';
}

/** Call after the first-run setup: wires the panel and runs the start-up update check. */
export async function setupAppPanel(settings: AppSettings) {
  const autoBox = $<HTMLInputElement>('setting-auto-update-app');
  autoBox.checked = settings.autoUpdateApp !== false;
  autoBox.addEventListener('change', () => {
    void window.electronAPI.saveSettings({ autoUpdateApp: autoBox.checked });
  });

  const powerSel = $<HTMLSelectElement>('setting-power-saver');
  powerSel.value = settings.powerSaver ?? 'battery';
  powerSel.addEventListener('change', () => {
    void window.electronAPI.saveSettings({ powerSaver: powerSel.value as PowerSaverMode });
  });
  renderPower(powerState());
  document.addEventListener('power-changed', (e) => renderPower((e as CustomEvent<PowerState>).detail));
  document.addEventListener('language-changed', () => {
    renderPower(powerState());
    void window.electronAPI.getAppUpdateStatus().then(render);
  });

  window.electronAPI.onAppUpdateStatus(render);
  $('app-update-check-btn').addEventListener('click', () => void window.electronAPI.checkAppUpdate().then(render));
  render(await window.electronAPI.getAppUpdateStatus());

  // Start-up check (only when automatic updates are on)
  if (settings.autoUpdateApp !== false) void window.electronAPI.checkAppUpdate();
}
